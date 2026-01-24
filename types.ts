export interface Region {
  id: string;
  x: number; // Percentage 0-100 relative to image
  y: number; // Percentage 0-100 relative to image
  width: number; // Percentage 0-100
  height: number; // Percentage 0-100
  type: 'rect'; // Extensible for future shapes
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedImageBase64?: string; // The result from API
}

export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;
  originalWidth: number;
  originalHeight: number;
  regions: Region[];
  finalResultUrl?: string; // The stitched final image
}

export type AiProvider = 'openai' | 'gemini';

export interface AppConfig {
  prompt: string;
  // Execution Mode is now effectively handled by concurrencyLimit
  // 1 = Serial, >1 = Concurrent
  executionMode: 'concurrent' | 'serial'; 
  concurrencyLimit: number;
  
  // Provider Settings
  provider: AiProvider;
  
  // OpenAI Specifics
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  
  // Gemini Specifics
  geminiApiKey: string;
  geminiModel: string;
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  CROPPING = 'CROPPING',
  API_CALLING = 'API_CALLING',
  STITCHING = 'STITCHING',
  DONE = 'DONE',
}