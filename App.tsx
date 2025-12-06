
import React, { useState, useEffect } from 'react';
import { Card } from './components/Card';
import { Modal } from './components/Modal';
import { AITool, ToolId } from './types';
import { SrtTranslator } from './components/tools/SrtTranslator';
import { SrtAudioGenerator } from './components/tools/SrtAudioGenerator';
import { isValidSrt, MOJIBAKE_REGEX } from './utils';

// Icons
const SubtitleIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
  </svg>
);

const AudioIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
  </svg>
);

// Define available tools here
const TOOLS: AITool[] = [
  {
    id: ToolId.SRT_TRANSLATOR,
    title: ".srt file angolról magyarra",
    description: "Meglévő .srt feliratfájlok fordítása magyar nyelvre, az időzítés megtartásával és IT/szakmai kontextus figyelembevételével.",
    icon: <SubtitleIcon />
  },
  {
    id: ToolId.SRT_AUDIO_GENERATOR,
    title: "Magyar felirat Felolvasó",
    description: "Magyar nyelvű .srt fájlok felolvasása természetes hangon, időzítés tartásával, letölthető audio formátumban.",
    icon: <AudioIcon />
  }
];

export default function App() {
  const [activeTool, setActiveTool] = useState<AITool | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  
  // File State managed by Parent
  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileEncoding, setFileEncoding] = useState<string>('UTF-8');
  const [fileReadError, setFileReadError] = useState('');

  // Reset when tool changes
  const handleToolClick = (tool: AITool) => {
    setActiveTool(tool);
    setFile(null);
    setFileContent('');
    setFileReadError('');
    
    // Set default encoding based on tool type
    if (tool.id === ToolId.SRT_AUDIO_GENERATOR) {
      setFileEncoding('windows-1250');
    } else {
      setFileEncoding('UTF-8');
    }
    
    setIsModalOpen(true);
  };

  const closeModal = () => {
    // Note: Child components handle internal processing state. 
    // Closing modal destroys the child component, effectively resetting it.
    setIsModalOpen(false);
    setActiveTool(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      setFileContent('');
      setFileReadError('');
    }
  };

  useEffect(() => {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (fileEncoding === 'windows-1250' && MOJIBAKE_REGEX.test(content)) {
        console.warn("Detected UTF-8 file read as Windows-1250. Auto-switching to UTF-8.");
        setFileEncoding('UTF-8');
        return;
      }
      setFileContent(content);
    };
    reader.onerror = () => {
      setFileReadError('Hiba a fájl olvasásakor.');
    };
    reader.readAsText(file, fileEncoding);
  }, [file, fileEncoding]);


  return (
    <div className="min-h-screen bg-background text-slate-100 p-6 md:p-12">
      <div className="max-w-7xl mx-auto">
        <header className="mb-12 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-500 mb-4">
            AI Asszisztens
          </h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto">
            Válassz egy kártyát a feladat elindításához. A mesterséges intelligencia elvégzi a munka nehezét.
          </p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {TOOLS.map(tool => (
            <Card key={tool.id} tool={tool} onClick={handleToolClick} />
          ))}
        </div>
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={closeModal}
        title={activeTool?.title || ''}
      >
        <div className="space-y-6">
          {/* File Input Section (Common) */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-slate-400">
              Forrásfájl feltöltése (.srt)
            </label>
            <div className="flex flex-col md:flex-row gap-4">
                 <div className="flex items-center space-x-4">
                    <label className="cursor-pointer bg-slate-700 hover:bg-slate-600 text-white py-2 px-4 rounded-lg transition-colors border border-slate-600">
                        <span>Fájl kiválasztása</span>
                        <input 
                        type="file" 
                        accept=".srt" 
                        onChange={handleFileChange} 
                        className="hidden" 
                        />
                    </label>
                    <span className="text-sm text-slate-400 truncate max-w-xs">
                        {file ? file.name : 'Nincs fájl kiválasztva'}
                    </span>
                 </div>

                 {/* Encoding Selector (Only visible for Audio Generator or if needed) */}
                 {activeTool?.id === ToolId.SRT_AUDIO_GENERATOR && (
                     <div className="flex items-center gap-2">
                         <label className="text-sm text-slate-400">Kódolás:</label>
                         <select 
                            value={fileEncoding}
                            onChange={(e) => setFileEncoding(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded-md p-2 text-sm text-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                         >
                            <option value="windows-1250">ANSI (HU)</option>
                            <option value="UTF-8">UTF-8</option>
                         </select>
                     </div>
                 )}
            </div>
            {fileReadError && <p className="text-red-400 text-xs">{fileReadError}</p>}
          </div>

          {/* Content Preview / Editor (Common) */}
          {fileContent && (
             <div className="space-y-2">
               <label className="block text-sm font-medium text-slate-400">
                 Fájl tartalom ellenőrzése / szerkesztése
               </label>
               <textarea
                 value={fileContent}
                 onChange={(e) => setFileContent(e.target.value)}
                 rows={6}
                 className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm font-mono text-slate-300 focus:ring-2 focus:ring-blue-500 outline-none resize-y"
               />
               {!isValidSrt(fileContent) && (
                 <p className="text-red-400 text-xs">
                   ⚠️ A formátum sérültnek tűnik. Ellenőrizd a kódolást vagy javítsd manuálisan.
                 </p>
               )}
             </div>
          )}

          <hr className="border-slate-700" />

          {/* Tool Specific Logic */}
          {activeTool?.id === ToolId.SRT_TRANSLATOR && (
              <SrtTranslator 
                 fileContent={fileContent} 
                 filename={file ? file.name : ''} 
              />
          )}

          {activeTool?.id === ToolId.SRT_AUDIO_GENERATOR && (
              <SrtAudioGenerator 
                 fileContent={fileContent} 
                 filename={file ? file.name : ''} 
              />
          )}
        </div>
      </Modal>
    </div>
  );
}
