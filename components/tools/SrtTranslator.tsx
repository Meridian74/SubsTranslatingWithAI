
import React, { useState, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { 
    mapSourceTimestamps, 
    repairSrtTimestamps, 
    encodeWindows1250, 
    playSuccessChime, 
    playWarningSound, 
    sleep 
} from '../../utils';

interface SrtTranslatorProps {
    fileContent: string;
    filename: string;
}

export const SrtTranslator: React.FC<SrtTranslatorProps> = ({ fileContent, filename }) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const [isPaused, setIsPaused] = useState(false);
    const [status, setStatus] = useState('');
    const [progress, setProgress] = useState(0);
    const [result, setResult] = useState('');
    
    // State for resuming batches
    const abortRef = useRef<boolean>(false);
    const currentBatchIndexRef = useRef<number>(0);
    const accumulatedResultRef = useRef<string[]>([]);
    
    // Helper to split raw SRT into blocks
    const splitIntoBlocks = (content: string): string[] => {
        const normalized = content.replace(/\r\n/g, '\n');
        // Split by double newline, filter empty
        return normalized.split(/\n\s*\n/).filter(b => b.trim().length > 0);
    };

    const handleAbort = () => {
        abortRef.current = true;
        setIsPaused(false);
        setStatus('Folyamat megszakítása...');
    };

    const processTranslation = async () => {
        if (!fileContent) return;
        setIsProcessing(true);
        setIsPaused(false);
        setResult('');
        abortRef.current = false;

        // Prep blocks
        const allBlocks = splitIntoBlocks(fileContent);
        const CHUNK_SIZE = 40; // Process 40 subtitles at a time to prevent AI drift
        const totalBatches = Math.ceil(allBlocks.length / CHUNK_SIZE);
        
        // If starting fresh
        if (currentBatchIndexRef.current === 0) {
            setStatus(`Fordítás előkészítése (${allBlocks.length} blokk)...`);
            accumulatedResultRef.current = [];
            setProgress(5);
        }

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
            // Prep source timestamp map for final repair (on the full file)
            const sourceTimestampMap = mapSourceTimestamps(fileContent);

            for (let i = currentBatchIndexRef.current; i < totalBatches; i++) {
                if (abortRef.current) throw new Error("Folyamat megszakítva.");

                const startIdx = i * CHUNK_SIZE;
                const endIdx = Math.min(startIdx + CHUNK_SIZE, allBlocks.length);
                const chunkBlocks = allBlocks.slice(startIdx, endIdx);
                const chunkContent = chunkBlocks.join('\n\n');

                setStatus(`Fordítás: ${i + 1}. köteg a ${totalBatches}-ből...`);

                const prompt = `
Te egy precíziós felirat-fordító motor vagy. 
FELADAT: A bemeneti angol SRT fájlrészletet fordítsd magyarra.

KRITIKUS SZABÁLYOK:
1. 1:1 MEGFELELTETÉS: A kimenetben PONTOSAN ugyanannyi blokknak kell lennie, mint a bemenetben.
2. INDEX-HŰSÉG: Tartsd meg az eredeti sorszámokat (pl. ha a bemenet 120-al kezdődik, a kimenet is azzal kezdődjön).
3. TARTALOM: Szakmai, IT fejlesztői nyelvezet.
4. FORMATÁLÁS: SRT formátum.

BEMENET:
${chunkContent}

KIMENET (Csak a nyers SRT):
                `;

                // Retry Logic per Batch
                let attempts = 0;
                const maxAttempts = 5;
                let batchSuccess = false;

                while (attempts < maxAttempts && !batchSuccess) {
                    if (abortRef.current) throw new Error("Folyamat megszakítva.");
                    try {
                        const res = await ai.models.generateContent({
                            model: "gemini-2.5-flash",
                            contents: prompt,
                        });

                        const rawText = res.text || "";
                        let cleanedText = rawText.replace(/```(?:srt)?/gi, '').replace(/```/g, '').trim();
                        
                        // Remove preamble if exists
                        const firstBlockLine = chunkBlocks[0].split('\n')[0].trim(); // e.g. "81"
                        // Regex to find the start of the first block index in the response
                        const srtStartIndex = cleanedText.search(new RegExp(`^${firstBlockLine}\\s+(?:00|[0-9]{2}):`, 'm'));
                        
                        if (srtStartIndex > -1) {
                            cleanedText = cleanedText.substring(srtStartIndex).trim();
                        } else {
                             // Fallback: try to find just the index number alone on a line
                             const indexOnlyMatch = cleanedText.search(new RegExp(`^${firstBlockLine}\\s*$`, 'm'));
                             if (indexOnlyMatch > -1) {
                                cleanedText = cleanedText.substring(indexOnlyMatch).trim();
                             }
                        }

                        accumulatedResultRef.current.push(cleanedText);
                        batchSuccess = true;
                        
                        // Update Progress
                        const percent = Math.round(((i + 1) / totalBatches) * 100);
                        setProgress(percent);
                        currentBatchIndexRef.current = i + 1;

                    } catch (err: any) {
                        attempts++;
                        const statusCode = err.status || err.response?.status || err.code || 'Unknown';
                        console.error(`Translation Batch Error (Attempt ${attempts}/${maxAttempts})`, err);
                        
                        let delay = 2000;
                        if (attempts === 2) delay = 4000;
                        if (attempts === 4) { delay = 30000; playWarningSound(); }

                        if (attempts >= maxAttempts) {
                            setStatus(`Hiba a ${i+1}. kötegnél (${statusCode}). Felfüggesztve.`);
                            playWarningSound();
                            setIsPaused(true);
                            return; 
                        }
                        
                        setStatus(`Hiba (${statusCode}). Újrapróbálkozás... (${attempts}/${maxAttempts})`);
                        await sleep(delay);
                    }
                }
            }
            
            // Final Assembly
            setStatus('Végső ellenőrzés és összefűzés...');
            const fullRawTranslation = accumulatedResultRef.current.join('\n\n');
            
            // Final Repair using the Source Map (Fixes timestamps across the whole file)
            const finalCleaned = repairSrtTimestamps(fullRawTranslation, sourceTimestampMap);
            
            setResult(finalCleaned);
            playSuccessChime();
            setIsProcessing(false);
            
            // Reset refs for next run
            currentBatchIndexRef.current = 0;
            accumulatedResultRef.current = [];

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
                    onClick={processTranslation}
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
                    onClick={processTranslation}
                    disabled={!fileContent}
                    className="px-6 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors focus:ring-2 focus:ring-blue-500 outline-none"
                    >
                    Indítás
                    </button>
                 )}
            </div>

            {/* Result */}
            {result && !isProcessing && !isPaused && !result.startsWith('HIBA') && (
                 <div className="mt-6 space-y-4 animate-fade-in">
                    <h3 className="text-lg font-bold text-white border-b border-slate-700 pb-2">Eredmény</h3>
                     <div className="space-y-4">
                         <textarea
                            readOnly
                            value={result}
                            className="w-full bg-slate-950 border border-slate-700 rounded-lg p-4 text-sm font-mono text-green-400 h-64 focus:outline-none"
                         />
                         <div className="flex justify-center">
                             <a 
                                href={URL.createObjectURL(new Blob([encodeWindows1250(result)], {type: "text/plain;charset=windows-1250"}))}
                                download={filename ? filename.replace(/\.srt$/i, "_hu.srt") : "translated_hu.srt"}
                                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors shadow-lg flex items-center gap-2"
                             >
                                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                                </svg>
                                Fordítás Letöltése (.srt)
                             </a>
                         </div>
                     </div>
                 </div>
            )}
             {result && result.startsWith('HIBA') && (
                <div className="mt-6 p-4 bg-red-900/20 text-red-300 rounded-lg border border-red-800">
                    {result}
                </div>
            )}
        </div>
    );
};
