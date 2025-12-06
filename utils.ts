
// utils.ts - Shared Helper Functions

// --- Constants ---
// Regex to detect common Hungarian UTF-8 characters incorrectly read as Windows-1250.
export const MOJIBAKE_REGEX = /(\u0102[\u02C7\u00A9\u00AD\u0142\u00B6\u015F\u013E]|\u0139[\u2018\u0105])/;

// --- General Helpers ---

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const base64ToUint8Array = (base64: string) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

// --- SRT Parsing & Timestamp Helpers ---

export const isValidSrt = (content: string): boolean => {
  if (!content) return false;
  // Permissive regex
  const srtPattern = /(?:^|\n)\s*\d+\s+\d{1,3}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{1,3}:\d{2}:\d{2}[,.]\d{3}/;
  return srtPattern.test(content);
};

export const parseTimeStringToSeconds = (timeStr: string): number => {
  if (!timeStr) return 0;
  const cleanStr = timeStr.trim().replace(/^[^\d]+/, ''); 
  
  const fullMatch = cleanStr.match(/(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/);
  if (fullMatch) {
    const h = parseInt(fullMatch[1], 10);
    const m = parseInt(fullMatch[2], 10);
    const s = parseInt(fullMatch[3], 10);
    const msStr = fullMatch[4] || "0";
    const ms = parseInt(msStr.padEnd(3, '0').substring(0, 3), 10);
    return h * 3600 + m * 60 + s + ms / 1000;
  }
  
  const shortMatch = cleanStr.match(/^(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (shortMatch) {
    const m = parseInt(shortMatch[1], 10);
    const s = parseInt(shortMatch[2], 10);
    const msStr = shortMatch[3] || "0";
    const ms = parseInt(msStr.padEnd(3, '0').substring(0, 3), 10);
    return m * 60 + s + ms / 1000;
  }

  return 0;
};

export const extractSrtTimestamps = (content: string): { starts: string[], ends: string[], all: Set<string> } => {
    const starts: string[] = [];
    const ends: string[] = [];
    const all = new Set<string>();

    const regex = /(?:^|\n)\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})\s+-->\s+(\d{1,3}:\d{2}:\d{2}[,.]\d{3})/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        starts.push(match[1]);
        ends.push(match[2]);
        all.add(match[1]);
        all.add(match[2]);
    }
    return { starts, ends, all };
};

export const mapSourceTimestamps = (content: string): Map<string, string> => {
    const map = new Map<string, string>();
    const normalized = content.replace(/\r\n/g, '\n');
    // Regex allows whitespace around newline
    const regex = /(?:^|\n)\s*(\d+)\s*\n\s*([0-9:.,]+\s+-->\s+[0-9:.,]+)/g;
    let match;
    while ((match = regex.exec(normalized)) !== null) {
        map.set(match[1], match[2]);
    }
    return map;
};

export const repairSrtTimestamps = (generatedSrt: string, sourceMap: Map<string, string>): string => {
    // Regex matches Block Index, then Timestamp line, handling possible whitespace variations
    const regex = /(?:^|\n)\s*(\d+)\s*\n\s*([0-9:.,]+\s+-->\s+[0-9:.,]+)/g;
    
    return generatedSrt.replace(regex, (match, index, timestamp, offset) => {
        if (sourceMap.has(index)) {
            const originalTimestamp = sourceMap.get(index);
            // Ensure double newline separator for standard SRT formatting, except for the very first block
            const prefix = offset === 0 ? '' : '\n\n';
            return `${prefix}${index}\n${originalTimestamp}`;
        }
        return match; 
    }).trim();
};

export const parseSrtToSegments = (content: string) => {
    const segments: {startTime: string, endTime: string, text: string}[] = [];
    const normalizedContent = content.replace(/\r\n/g, '\n');
    // More robust split that handles optional whitespace on empty lines
    const blocksRaw = normalizedContent.split(/\n\s*\n/);
    
    let currentStartTime = "";
    let currentAccumulatedText = "";
    let lastEndTime = "";

    for (const block of blocksRaw) {
        // PERMISSIVE REGEX
        const match = block.match(/(?:^|\n)?\d+\n([0-9:.,]+)\s+-->\s+([0-9:.,]+)\n([\s\S]*)/);
        if (!match) continue; 
        
        const startTime = match[1];
        const endTime = match[2];
        const textRaw = match[3];
        const textClean = textRaw.replace(/\n/g, ' ').trim();
        
        if (!textClean) continue;

        lastEndTime = endTime;

        if (currentAccumulatedText === "") {
            currentStartTime = startTime;
        }

        if (currentAccumulatedText !== "") {
            currentAccumulatedText += " ";
        }
        currentAccumulatedText += textClean;

        if (/[.?!]$/.test(currentAccumulatedText)) {
            segments.push({
                startTime: currentStartTime,
                endTime: endTime,
                text: currentAccumulatedText
            });
            currentAccumulatedText = "";
            currentStartTime = "";
        }
    }

    if (currentAccumulatedText !== "") {
        segments.push({
            startTime: currentStartTime,
            endTime: lastEndTime,
            text: currentAccumulatedText
        });
    }

    return segments;
};

export const findClosestTimestamp = (targetSec: number, validStrings: string[]): string => {
    let closestStr = validStrings[0];
    let minDiff = Number.MAX_VALUE;

    for (const validStr of validStrings) {
        const validSec = parseTimeStringToSeconds(validStr);
        const diff = Math.abs(validSec - targetSec);
        if (diff < minDiff) {
            minDiff = diff;
            closestStr = validStr;
        }
    }
    return closestStr;
};

export const validateAndFixSegments = (segments: any[], validTimes: { starts: string[], ends: string[], all: Set<string> }) => {
  return segments.map((seg, index) => {
    let startStr = seg.startTime;
    let endStr = seg.endTime;
    
    if (!validTimes.all.has(startStr)) {
        const originalSec = parseTimeStringToSeconds(startStr);
        const hourShiftSec = Math.max(0, originalSec - 3600);
        const closestOriginal = findClosestTimestamp(originalSec, validTimes.starts);
        const closestShifted = findClosestTimestamp(hourShiftSec, validTimes.starts);
        
        const diffOriginal = Math.abs(originalSec - parseTimeStringToSeconds(closestOriginal));
        const diffShifted = Math.abs(hourShiftSec - parseTimeStringToSeconds(closestShifted));
        
        if (originalSec > 3600 && diffShifted < diffOriginal) {
            startStr = closestShifted;
        } else {
             startStr = closestOriginal;
        }
    }

    if (!validTimes.all.has(endStr)) {
        const originalSec = parseTimeStringToSeconds(endStr);
        const hourShiftSec = Math.max(0, originalSec - 3600);
        const closestOriginal = findClosestTimestamp(originalSec, validTimes.ends);
        const closestShifted = findClosestTimestamp(hourShiftSec, validTimes.ends);
        
        const diffOriginal = Math.abs(originalSec - parseTimeStringToSeconds(closestOriginal));
        const diffShifted = Math.abs(hourShiftSec - parseTimeStringToSeconds(closestShifted));
        
        if (originalSec > 3600 && diffShifted < diffOriginal) {
            endStr = closestShifted;
        } else {
             endStr = closestOriginal;
        }
    }

    let start = parseTimeStringToSeconds(startStr);
    let end = parseTimeStringToSeconds(endStr);

    if (end <= start) {
       end = start + 2; 
    }
    
    return {
      ...seg,
      startTime: startStr,
      endTime: endStr,
      _startSec: start,
      _endSec: end,
      text: seg.text || ""
    };
  }).sort((a, b) => a._startSec - b._startSec);
};

export const getSrtEndSeconds = (content: string): number => {
    if (!content) return 0;
    const regex = /-->\s*([0-9:.,]+)/g; 
    const matches = [...content.matchAll(regex)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      return parseTimeStringToSeconds(lastMatch[1]);
    }
    return 0;
};

export const sanitizeTextForTts = (text: string): string => {
  if (!text) return "";
  return text.replace(/`/g, '') + " ";
};

// --- Audio & Encoding Helpers ---

export const speedUpPcm = (inputBuffer: Int16Array, speedFactor: number): Int16Array => {
  if (speedFactor <= 1.0) return inputBuffer;

  const inputLen = inputBuffer.length;
  const newLen = Math.floor(inputLen / speedFactor); 
  const outputBuffer = new Int16Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const originalPos = i * speedFactor;
    const index = Math.floor(originalPos);
    const frac = originalPos - index;

    if (index + 1 < inputLen) {
      const val1 = inputBuffer[index];
      const val2 = inputBuffer[index + 1];
      outputBuffer[i] = val1 + (val2 - val1) * frac;
    } else {
      outputBuffer[i] = inputBuffer[index];
    }
  }
  return outputBuffer;
};

export const createSilence = (seconds: number, sampleRate: number = 24000): Int16Array => {
  if (seconds <= 0) return new Int16Array(0);
  return new Int16Array(Math.floor(seconds * sampleRate));
};

export const pcmToMp3 = (pcmData: Int16Array, sampleRate: number = 24000): Blob => {
  if (!(window as any).lamejs) {
    throw new Error("Lamejs library not loaded.");
  }
  
  const lib = (window as any).lamejs;
  const mp3encoder = new lib.Mp3Encoder(1, sampleRate, 128); 
  const mp3Data = [];
  const sampleBlockSize = 1152; 

  for (let i = 0; i < pcmData.length; i += sampleBlockSize) {
    const sampleChunk = pcmData.subarray(i, i + sampleBlockSize);
    const mp3buf = mp3encoder.encodeBuffer(sampleChunk);
    if (mp3buf.length > 0) {
      mp3Data.push(mp3buf);
    }
  }

  const mp3buf = mp3encoder.flush();
  if (mp3buf.length > 0) {
    mp3Data.push(mp3buf);
  }

  return new Blob(mp3Data, { type: 'audio/mp3' });
};

// --- Sounds ---

export const playSuccessChime = () => {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      
      const fundamental = 880; // A5
      const ratios = [1, 1.5, 2.4, 2.9];
      const gains = [0.1, 0.05, 0.03, 0.01];

      ratios.forEach((ratio, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(fundamental * ratio, now);
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(gains[i], now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5);
        
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        osc.start(now);
        osc.stop(now + 1.5);
      });
    }
  } catch (e) {
    console.error("Audio play error", e);
  }
};

export const playWarningSound = () => {
  try {
    const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContext) {
      const ctx = new AudioContext();
      const now = ctx.currentTime;
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.linearRampToValueAtTime(100, now + 0.4);

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.15);
      gain.gain.setValueAtTime(0.1, now + 0.2);
      gain.gain.linearRampToValueAtTime(0, now + 0.4);

      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch (e) {
    console.error("Audio play error", e);
  }
};

// --- Character Encoding ---

export const encodeWindows1250 = (str: string): Uint8Array => {
  const len = str.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    if (code < 128) {
      bytes[i] = code;
    } else {
      switch (code) {
         case 0x00C1: bytes[i] = 0xC1; break; // Á
         case 0x00C9: bytes[i] = 0xC9; break; // É
         case 0x00CD: bytes[i] = 0xCD; break; // Í
         case 0x00D3: bytes[i] = 0xD3; break; // Ó
         case 0x00D6: bytes[i] = 0xD6; break; // Ö
         case 0x0150: bytes[i] = 0xD5; break; // Ő
         case 0x00DA: bytes[i] = 0xDA; break; // Ú
         case 0x00DC: bytes[i] = 0xDC; break; // Ü
         case 0x0170: bytes[i] = 0xDB; break; // Ű
         
         case 0x00E1: bytes[i] = 0xE1; break; // á
         case 0x00E9: bytes[i] = 0xE9; break; // é
         case 0x00ED: bytes[i] = 0xED; break; // í
         case 0x00F3: bytes[i] = 0xF3; break; // ó
         case 0x00F6: bytes[i] = 0xF6; break; // ö
         case 0x0151: bytes[i] = 0xF5; break; // ő
         case 0x00FA: bytes[i] = 0xFA; break; // ú
         case 0x00FC: bytes[i] = 0xFC; break; // ü
         case 0x0171: bytes[i] = 0xFB; break; // ű

         case 0x2013: bytes[i] = 0x96; break; // –
         case 0x2014: bytes[i] = 0x97; break; // —
         case 0x2018: bytes[i] = 0x91; break; // ‘
         case 0x2019: bytes[i] = 0x92; break; // ’
         case 0x201E: bytes[i] = 0x84; break; // „
         case 0x201C: bytes[i] = 0x93; break; // “
         case 0x201D: bytes[i] = 0x94; break; // ”
         case 0x2026: bytes[i] = 0x85; break; // …
         case 0x00A0: bytes[i] = 0xA0; break; // nbsp

         default: 
            if (code >= 0xA0 && code <= 0xFF) {
                 bytes[i] = code; 
            } else {
                 bytes[i] = 0x3F; // ?
            }
      }
    }
  }
  return bytes;
};
