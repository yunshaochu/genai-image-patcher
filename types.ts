
export interface RestoreBox {
  id: string;
  x: number;       // Percentage 0-100 relative to the region (not the full image)
  y: number;
  width: number;
  height: number;
  inverse: boolean; // true = keep AI result inside box, restore outside
}

export interface Region {
  id: string;
  x: number; // Percentage 0-100 relative to image
  y: number; // Percentage 0-100 relative to image
  width: number; // Percentage 0-100
  height: number; // Percentage 0-100
  type: 'rect'; // Extensible for future shapes
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedImageBase64?: string; // The result from API
  /** The region dimensions at the time processedImageBase64 was generated (percentages). Used for display/stitch alignment when the green frame is resized. */
  anchorX?: number;
  anchorY?: number;
  anchorWidth?: number;
  anchorHeight?: number;
  source?: 'manual' | 'auto'; // To distinguish manually drawn vs AI detected regions
  customPrompt?: string; // Image-specific prompt overrides global prompt
  contextOnly?: boolean; // If true, region is visible context only — not translated or painted
  ocrText?: string; // Detected text from OCR
  isOcrLoading?: boolean; // Loading state for OCR
  isRecalculating?: boolean; // New: visual flag for background refinements
  restoreBoxes?: RestoreBox[]; // Box-based restore regions (框选还原)
  restoreMaskBase64?: string; // Brush-based restore mask (涂抹还原), alpha=1=processed, 0=original
}

export interface ImageHistoryState {
  previewUrl: string;
  regions: Region[];
  finalResultUrl?: string;
  width: number;
  height: number;
  fullAiResultUrl?: string; // Added to history
}

export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;       // Display URL (may be compressed in balanced mode)
  originalUrl: string;      // Original full-resolution URL for API crop (never compressed)
  thumbnailUrl: string;     // Small thumbnail for gallery
  originalWidth: number;
  originalHeight: number;
  regions: Region[];
  finalResultUrl?: string; // The stitched final image
  fullAiResultUrl?: string; // The raw full-size output from the AI (before any cropping)
  isSkipped?: boolean; // If true, excluded from batch processing but included in zip (as original)
  customPrompt?: string; // Full image specific prompt
  
  // History for Undo/Redo of "Apply as Original"
  history: ImageHistoryState[];
  historyIndex: number;
}

export type AiProvider = 'openai' | 'gemini';

export type ThemeType = 'light' | 'dark' | 'ocean' | 'rose' | 'forest';

export type Language = 'zh' | 'en';

export type ProcessingMode = 'api' | 'manual';

export type PerformanceMode = 'unlimited' | 'balanced';

export type SquareFillMode = 'ratio' | 'detect';

export interface AppConfig {
  prompt: string;
  // Execution Mode is now effectively handled by concurrencyLimit
  // 1 = Serial, >1 = Concurrent
  executionMode: 'concurrent' | 'serial'; 
  concurrencyLimit: number;
  
  // Advanced: If an image has no regions, process the whole image
  processFullImageIfNoRegions: boolean;
  
  // Retry & Timeout Settings
  apiTimeout: number; // in milliseconds
  maxRetries: number; // count

  // Workflow Mode
  processingMode: ProcessingMode;

  // Performance Mode
  performanceMode: PerformanceMode;
  
  // Theme & Language
  theme: ThemeType;
  language: Language;

  // Provider Settings
  provider: AiProvider;
  
  // OpenAI Specifics
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiStream: boolean; // New: Stream Toggle
  enableSquareFill: boolean; // New: Pad image to 1:1 square before sending
  squareFillMargin: number; // px: safety margin to trim from each edge after depadding (only for 'detect' mode)
  squareFillMode: SquareFillMode; // 'ratio' = crop by proportion, 'detect' = scan dark pixels + margin
  
  // Gemini Specifics
  geminiApiKey: string;
  geminiModel: string;

  // Backend Detection Settings (Python)
  detectionApiUrl: string; // e.g. http://localhost:8000/detect
  ocrApiUrl: string; // e.g. http://localhost:8000/ocr
  
  // Detection Tuning
  detectionInflationPercent: number; // e.g. 10 for 10% expansion
  detectionOffsetXPercent: number; // e.g. 0
  detectionOffsetYPercent: number; // e.g. 0
  detectionConfidenceThreshold: number; // e.g. 30 for 0.3
  
  // Manga Module Settings (New Structure)
  enableMangaMode: boolean;        // Master switch
  enableBubbleDetection: boolean;  // Sub switch: Auto-detect regions
  enableOCR: boolean;              // Sub switch: Text recognition
  enableManualEditor: boolean;     // Sub switch: Brush/Text editor
  enableVerticalTextDefault: boolean; // Sub switch: Default text orientation

  // Logic Switch
  useFullImageMasking: boolean; // Send full image with non-selected areas masked white
  useInvertedMasking: boolean; // New: Selected areas are masked white (AI generates BG), Orginal regions kept.
  fullImageOpaquePercent: number; // 0-100, default 99. Determines how much of the center is opaque before feathering starts.

  // Translation Mode Settings
  enableTranslationMode: boolean;
  sendMaskedContextForTranslation: boolean;
  translationBaseUrl: string;
  translationApiKey: string;
  translationModel: string;
  translationPrompt: string;
  /** User's custom prompt for translation WITHOUT masked context (cached) */
  translationPromptNoContext?: string;
  /** User's custom prompt for translation WITH masked context (cached) */
  translationPromptWithContext?: string;
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  CROPPING = 'CROPPING',
  API_CALLING = 'API_CALLING',
  STITCHING = 'STITCHING',
  DONE = 'DONE',
}