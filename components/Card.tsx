import React from 'react';
import { AITool } from '../types';

interface CardProps {
  tool: AITool;
  onClick: (tool: AITool) => void;
}

export const Card: React.FC<CardProps> = ({ tool, onClick }) => {
  return (
    <div 
      onClick={() => onClick(tool)}
      className="group relative bg-surface border border-slate-700 rounded-xl p-6 cursor-pointer transition-all duration-300 hover:shadow-lg hover:shadow-blue-500/10 hover:border-blue-500/50 hover:-translate-y-1 flex flex-col h-full"
    >
      <div className="mb-4 text-blue-400 group-hover:text-blue-300 transition-colors">
        {tool.icon}
      </div>
      <h3 className="text-xl font-bold text-slate-100 mb-2 group-hover:text-white transition-colors">
        {tool.title}
      </h3>
      <p className="text-slate-400 text-sm leading-relaxed flex-grow">
        {tool.description}
      </p>
      <div className="mt-4 pt-4 border-t border-slate-700/50 flex items-center justify-between text-xs text-slate-500 group-hover:text-blue-400 transition-colors">
        <span>AI Eszköz</span>
        <span className="opacity-0 group-hover:opacity-100 transition-opacity">Megnyitás &rarr;</span>
      </div>
    </div>
  );
};