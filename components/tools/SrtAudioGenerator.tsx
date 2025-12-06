
import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";
import { 
    parseSrtToSegments, 
    extractSrtTimestamps, 
    validateAndFixSegments, 
    getSrtEndSeconds, 
    sanitizeTextForTts, 
    createSilence, 
    base64ToUint8Array, 
    speedUpPcm, 
    pcmToMp3, 
    playSuccessChime, 
    playWarningSound, 
    sleep 
} from '../../utils';

interface SrtAudioGeneratorProps {
    fileContent: string;
    filename: string;
    // We pass encoding setter back to parent if needed, or handle it via props change. 
    // Actually, in the refactor, parent handles file reading, so this component just receives content.
}

export const SrtAudioGenerator: React.FC<SrtAudioGeneratorProps> = ({ fileContent, filename }) => {
    // UI State
    const [isProcessing, setIsProcessing] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [status, setStatus] = useState('');
    const [progress, setProgress] = useState(0);
    const [result, setResult] = useState('');
    const [audioUrl, setAudioUrl] = useState('');
    
    // Voice Settings
    const [voiceGender, setVoiceGender] = useState<'Male' | 'Female'>('Male');
    const [voiceName, setVoiceName] = useState<string>('Fenrir'); 

    // Debug View State
    const [debugData, setDebugData] = useState<string>('');
    const [currentSegmentIndex, setCurrentSegmentIndex] = useState<number>(-1);
    const activeDebugRowRef = useRef<HTMLDivElement>(null);

    // Persistence Refs for Resuming
    const abortRef = useRef<boolean>(false);
    const masterAudioBufferRef = useRef<Int16Array[]>([]);
    const currentAudioTimeRef = useRef<number>(0);
    const resumeIndexRef = useRef<number>(0);
    const processedSegmentsRef = useRef<any[]>([]);

    // Reset processing state if file content changes drastically (new file)
    useEffect(() => {
        // Reset refs when file content is reset (empty)
        if (!fileContent) {
            masterAudioBufferRef.current = [];
            currentAudioTimeRef.current = 0;
            resumeIndexRef.current = 0;
            processedSegmentsRef.current = [];
            setDebugData('');
            setAudioUrl('');
            setResult('');
            setProgress(0);
        }
    }, [fileContent]);

    // Auto-scroll debug view
    useEffect(() => {
        if (activeDebugRowRef.current) {
            activeDebugRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [currentSegmentIndex]);

    const handleAbort = () => {
        abortRef.current = true;
        setIsPaused(false);
        setStatus('Folyamat megszakítása...');
    };

    const processAudioSegments = async () => {
        if (!fileContent) return;
        setIsProcessing(true);
        setIsPaused(false);
        setResult('');
        setAudioUrl('');
        abortRef.current = false;

        // Clear State for fresh start if not resuming
        if (resumeIndexRef.current === 0 && masterAudioBufferRef.current.length === 0) {
            setDebugData('');
            setCurrentSegmentIndex(-1);
            setStatus('Feldolgozás indítása...');
            setProgress(5);
            masterAudioBufferRef.current = [];
            currentAudioTimeRef.current = 0;
            processedSegmentsRef.current = [];
        }

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

            // Step 1: Prep (Only if starting fresh)
            if (processedSegmentsRef.current.length === 0) {
                setStatus('1. Lépés: SRT elemzése és időzítések kibontása...');
                let segments = parseSrtToSegments(fileContent);
                const validTimestamps = extractSrtTimestamps(fileContent);
                const cleanSegments = validateAndFixSegments(segments, validTimestamps);
                
                setDebugData(JSON.stringify(cleanSegments, null, 2));
                if (cleanSegments.length === 0) throw new Error("Nem sikerült szegmenseket kinyerni. A fájl formátuma nem felismerhető.");
                
                processedSegmentsRef.current = cleanSegments;
                setProgress(15);
            }

            const cleanSegments = processedSegmentsRef.current;
            const srtActualEndTime = getSrtEndSeconds(fileContent);
            const MAX_ALLOWED_DURATION = (srtActualEndTime > 0 ? srtActualEndTime : (cleanSegments[cleanSegments.length - 1]?._endSec || 0)) + 45;

            // WARM-UP PHASE
            if (resumeIndexRef.current === 0) {
            setStatus('API Bemelegítése...');
            try {
                const speechConfig = {
                    voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } }
                };
                await ai.models.generateContent({
                    model: "gemini-2.5-flash-preview-tts",
                    contents: [{ parts: [{ text: " " }] }], 
                    config: { responseModalities: [Modality.AUDIO], speechConfig: speechConfig }
                });
            } catch (e) {
                console.warn("Warm-up failed, continuing anyway", e);
            }
            }

            setStatus('2. Lépés: Hang generálása és összeillesztése...');
            
            const speechConfig = {
                voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voiceName }
                }
            };

            // Resume Loop
            for (let i = resumeIndexRef.current; i < cleanSegments.length; i++) {
                if (abortRef.current) throw new Error("Folyamat megszakítva.");

                const segment = cleanSegments[i];
                setCurrentSegmentIndex(i);
                const targetStart = segment._startSec;
                
                if (currentAudioTimeRef.current > MAX_ALLOWED_DURATION) {
                    console.warn(`Hard limit reached. Current: ${currentAudioTimeRef.current}, Max: ${MAX_ALLOWED_DURATION}`);
                    break;
                }

                // 1. Gaps
                let gapDuration = targetStart - currentAudioTimeRef.current;
                if (gapDuration > 30) gapDuration = 5;

                if (gapDuration > 0.05) { 
                    setStatus(`Szünet generálása (${gapDuration.toFixed(2)}s)... (${i+1}/${cleanSegments.length})`);
                    const silencePcm = createSilence(gapDuration);
                    masterAudioBufferRef.current.push(silencePcm);
                    currentAudioTimeRef.current += gapDuration;
                }
                
                // 2. Generate Audio (Retry Logic)
                setStatus(`Mondat generálása (${i+1}/${cleanSegments.length})...`);
                
                let audioData: Int16Array | null = null;
                let attempts = 0;
                const maxAttempts = 5; 

                // sanitize adds padding to prevent empty response on short text
                let ttsText = sanitizeTextForTts(segment.text);

                while(attempts < maxAttempts && !audioData) {
                    if (abortRef.current) throw new Error("Folyamat megszakítva.");
                    try {
                        const result = await ai.models.generateContent({
                            model: "gemini-2.5-flash-preview-tts",
                            contents: [{ parts: [{ text: ttsText }] }],
                            config: {
                                responseModalities: [Modality.AUDIO],
                                speechConfig: speechConfig
                            }
                        });
                        
                        const base64Audio = result.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                        if (base64Audio) {
                            const uint8 = base64ToUint8Array(base64Audio);
                            audioData = new Int16Array(uint8.buffer);
                        } else {
                            throw new Error("Empty audio response");
                        }
                    } catch (err: any) {
                        attempts++;
                        const statusCode = err.status || err.response?.status || err.code || 'Unknown';
                        const errorMessage = err.message || "";
                        console.error(`TTS API Error (Attempt ${attempts}/${maxAttempts})`, err);
                        
                        let delay = 2000;
                        if (attempts === 2) delay = 4000;
                        if (attempts === 3) delay = 10000;
                        if (attempts === 4) {
                            delay = 30000; 
                            playWarningSound();
                        }

                        // --- SMART RETRY FOR SHORT TEXTS ---
                        // If empty response, append a period to force generation
                        if (errorMessage.includes("Empty audio response")) {
                            console.log(`Empty response encountered. Retrying with modified text...`);
                            if (!ttsText.trim().endsWith('.')) {
                                ttsText = ttsText.trim() + ".";
                            } else {
                                // If it already has a dot, append space or another dot
                                ttsText = ttsText + ".";
                            }
                        }

                        // Safety filter fallback (only after max attempts)
                        if (attempts >= maxAttempts && errorMessage.includes("Empty audio response")) {
                            console.warn(`Skipping segment "${segment.text}" due to empty response.`);
                            setStatus(`Figyelmeztetés: A "${segment.text.substring(0, 30)}..." szakasz átugrása (tartalom hiba)...`);
                            const dur = segment._endSec - segment._startSec;
                            audioData = createSilence(dur > 0 ? dur : 1);
                            break; 
                        }

                        // Suspend logic
                        if (attempts >= maxAttempts) {
                            setStatus(`Hálózati hiba (${statusCode}). Felfüggesztve. Kattints a Folytatásra.`);
                            playWarningSound();
                            setIsPaused(true);
                            resumeIndexRef.current = i; 
                            return; 
                        }

                        setStatus(`Hiba (${statusCode}). Újrapróbálkozás ${delay/1000}mp múlva... (${attempts}/${maxAttempts})`);
                        await sleep(delay);
                    }
                }

                if (!audioData) throw new Error("Nem várt hiba.");

                // 3. Adaptive Speed Up
                const rawDuration = audioData.length / 24000;
                const targetDuration = segment._endSec - segment._startSec;
                let speedFactor = 1.0;
                
                if (rawDuration > targetDuration) {
                    speedFactor = rawDuration / targetDuration;
                    if (speedFactor > 1.20) {
                        console.warn(`SPEED LIMIT HIT (Segment ${i+1}): Needed ${speedFactor.toFixed(3)}x, capped at 1.20x.`);
                        speedFactor = 1.20;
                    } else {
                        console.log(`Speeding up (Segment ${i+1}): ${speedFactor.toFixed(3)}x`);
                    }
                }

                const processedAudio = speedUpPcm(audioData, speedFactor);
                masterAudioBufferRef.current.push(processedAudio);
                currentAudioTimeRef.current += (processedAudio.length / 24000);

                const percent = 15 + Math.floor(((i + 1) / cleanSegments.length) * 75);
                setProgress(percent);
                
                resumeIndexRef.current = i + 1;
            }

            if (abortRef.current) throw new Error("Folyamat megszakítva.");

            setCurrentSegmentIndex(cleanSegments.length);

            // Step 3: Final Encoding
            setStatus('3. Lépés: MP3 Konvertálás...');
            
            const totalLength = masterAudioBufferRef.current.reduce((acc, curr) => acc + curr.length, 0);
            const finalPcm = new Int16Array(totalLength);
            let offset = 0;
            masterAudioBufferRef.current.forEach(arr => {
                finalPcm.set(arr, offset);
                offset += arr.length;
            });

            const mp3Blob = pcmToMp3(finalPcm, 24000); 
            const url = URL.createObjectURL(mp3Blob);
            
            setAudioUrl(url);
            setResult("A hangfájl sikeresen elkészült! Töltsd le az alábbi gombbal.");
            setProgress(100);
            playSuccessChime();
            setIsProcessing(false);

        } catch (error: any) {
            if (abortRef.current) {
                setStatus('A folyamat a felhasználó kérésére megszakadt.');
            } else {
                console.error(error);
                setStatus(`Hiba történt: ${error.message || 'Ismeretlen hiba'}`);
                setResult(`HIBA: ${error.message}`);
            }
            setIsProcessing(false);
            setIsPaused(false);
            abortRef.current = false;
        }
    };

    return (
        <div className="space-y-6 animate-fade-in">
             {/* Settings */}
             <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-800/50 p-4 rounded-lg border border-slate-700">
                <div className="text-slate-400 text-sm p-2 flex items-center">
                    (Karakterkódolás beállítása a fájl betöltése előtt történik)
                </div>
                <div>
                   <label className="block text-sm font-medium text-slate-400 mb-2">Hang kiválasztása</label>
                   <select 
                      value={voiceName}
                      onChange={(e) => {
                          const val = e.target.value;
                          setVoiceName(val);
                          if (['Fenrir', 'Charon', 'Puck'].includes(val)) setVoiceGender('Male');
                          else setVoiceGender('Female');
                      }}
                      disabled={isProcessing}
                      className="w-full bg-slate-900 border border-slate-700 rounded-md p-2 text-sm text-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                   >
                      <optgroup label="Férfi">
                        <option value="Fenrir">Fenrir (Erőteljes)</option>
                        <option value="Charon">Charon (Mély)</option>
                        <option value="Puck">Puck (Természetes)</option>
                      </optgroup>
                      <optgroup label="Nő">
                        <option value="Kore">Kore (Nyugodt)</option>
                        <option value="Zephyr">Zephyr (Lágy)</option>
                      </optgroup>
                   </select>
                </div>
            </div>

            {/* Debug Data View */}
            {debugData && (
                <div className="space-y-2">
                    <label className="block text-sm font-medium text-yellow-500">
                        🐛 Debug: Tervezett Időzítések (Kliens oldali)
                    </label>
                    <div className="w-full bg-slate-950 border border-yellow-700/50 rounded-lg p-3 text-xs font-mono overflow-auto max-h-60 shadow-inner">
                        {(() => {
                        try {
                            const parsed = JSON.parse(debugData);
                            return (
                            <div className="flex flex-col gap-1">
                                {parsed.map((seg: any, idx: number) => {
                                const isDone = idx < currentSegmentIndex;
                                const isCurrent = idx === currentSegmentIndex;
                                
                                let containerClass = "p-1 rounded border border-transparent transition-all duration-300";
                                let textClass = "text-slate-500";
                                
                                if (isDone) {
                                    containerClass = "p-1 rounded border-green-900/30 bg-green-900/10";
                                    textClass = "text-green-400 opacity-70";
                                } else if (isCurrent) {
                                    containerClass = "p-1 rounded border-yellow-700/50 bg-yellow-900/20 shadow-md";
                                    textClass = "text-yellow-300 font-bold";
                                }
                                
                                return (
                                    <div 
                                    key={idx} 
                                    ref={isCurrent ? activeDebugRowRef : null}
                                    className={containerClass}
                                    >
                                    <div className={`flex gap-2 ${textClass}`}>
                                        <span className="select-none opacity-50 w-6 text-right">{idx + 1}.</span>
                                        <span className="whitespace-pre-wrap break-words">{JSON.stringify(seg)}</span>
                                    </div>
                                    </div>
                                );
                                })}
                            </div>
                            );
                        } catch (e) {
                            return <pre className="text-yellow-100/80 whitespace-pre-wrap">{debugData}</pre>;
                        }
                        })()}
                    </div>
                </div>
            )}

            {/* Status & Progress */}
            {status && (
                <div className={`p-3 rounded-lg text-sm border ${status.startsWith('Hiba') ? 'bg-red-900/20 border-red-800 text-red-300' : (status.includes('Felfüggesztve') || status.includes('Figyelmeztetés') ? 'bg-yellow-900/20 border-yellow-800 text-yellow-300' : 'bg-blue-900/20 border-blue-800 text-blue-300')}`}>
                {status}
                </div>
            )}
            
            {isProcessing && (
                <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                    <div 
                        className={`h-2.5 rounded-full transition-all duration-300 ease-out ${isPaused ? 'bg-yellow-500' : 'bg-blue-500'}`}
                        style={{ width: `${progress}%` }}
                    ></div>
                    <div className="text-right text-xs text-slate-500 mt-1">{progress}%</div>
                </div>
            )}

            {/* Actions */}
            <div className="flex justify-end pt-4 border-t border-slate-700 space-x-3">
                 {isPaused && (
                    <button
                    onClick={processAudioSegments}
                    className="px-6 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium transition-colors focus:ring-2 focus:ring-green-500 outline-none animate-pulse"
                    >
                    Folytatás
                    </button>
                 )}
                 
                 {isProcessing || isPaused ? (
                    <button
                    onClick={handleAbort}
                    className="px-6 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium transition-colors focus:ring-2 focus:ring-red-500 outline-none"
                    >
                    Megszakítás
                    </button>
                 ) : (
                    <button
                    onClick={processAudioSegments}
                    disabled={!fileContent}
                    className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                    Indítás
                    </button>
                 )}
            </div>

            {/* Results */}
            {result && !isProcessing && !isPaused && (
                <div className="mt-6 space-y-4 animate-fade-in">
                <h3 className="text-lg font-bold text-white border-b border-slate-700 pb-2">Eredmény</h3>
                    <div className="bg-slate-800/50 p-6 rounded-xl border border-slate-700 text-center">
                    <p className={`${result.startsWith('HIBA') ? 'text-red-400' : 'text-green-400'} mb-4 font-medium`}>{result}</p>
                    {audioUrl && (
                        <div className="space-y-4">
                            <audio controls src={audioUrl} className="w-full" />
                            <a 
                                href={audioUrl} 
                                download={filename ? filename.replace(/\.[^/.]+$/, "") + ".mp3" : "generated_audio.mp3"}
                                className="inline-block px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-bold transition-all transform hover:scale-105 shadow-lg shadow-green-900/20"
                            >
                                MP3 Letöltése
                            </a>
                        </div>
                    )}
                    </div>
                </div>
            )}
        </div>
    );
};
