import React from 'react';

export enum ToolId {
  SRT_TRANSLATOR = 'srt_translator',
  SRT_AUDIO_GENERATOR = 'srt_audio_generator'
}

export interface AITool {
  id: ToolId;
  title: string;
  description: string;
  icon: React.ReactNode;
}

export interface ToolExecutionResult {
  output: string;
  tokenUsage?: {
    promptTokens: number;
    responseTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}