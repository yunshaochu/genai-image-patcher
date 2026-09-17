
export interface RestoreBox {
  id: string;
  x: number;       // Percentage 0-100 relative to the region (not the full image)
  y: number;
  width: number;
  height: number;
  inverse: boolean; // true = keep AI result inside box, restore outside
}

/** Detection classes returned by the comic-detector API (docs/API_RTDTR.md) */
export type DetectedClass = 'bubble' | 'text_bubble' | 'text_free';

/**
 * Per-region text style used by the in-place manga text editor.
 * Reserved fields (fontFamily / rotation / colors) are consumed by the
 * compositor but intentionally not exposed in the UI yet — the UI only
 * offers text content, auto font size and vertical/horizontal for now.
 */
export interface EditorTextStyle {
  fontSize?: number;      // px; undefined = auto-fit to the region box
  isVertical?: boolean;   // undefined = auto heuristic (tall box / global default)
  color?: string;         // reserved, default '#000000'
  outlineColor?: string;  // reserved, default '#ffffff'
  outlineWidth?: number;  // reserved, default 0 (no stroke)
  isBold?: boolean;       // reserved, default true
  fontFamily?: string;    // reserved, default sans-serif
  rotation?: number;      // reserved, default 0
}

export interface Region {
  id: string;
  x: number; // Percentage 0-100 relative to image
  y: number; // Percentage 0-100 relative to image
  width: number; // Percentage 0-100
  height: number; // Percentage 0-100
  type: 'rect'; // Extensible for future shapes
  status: 'pending' | 'processing' | 'completed' | 'failed';
  processedImageUrl?: string; // Object URL of the API-generated patch
  /** The region dimensions at the time processedImageUrl was generated (percentages). Used for display/stitch alignment when the green frame is resized. */
  anchorX?: number;
  anchorY?: number;
  anchorWidth?: number;
  anchorHeight?: number;
  source?: 'manual' | 'auto'; // To distinguish manually drawn vs AI detected regions
  /** Class reported by the detection API. 'bubble' boxes are kept as
   *  context-only markers (reserved for later use); text_bubble / text_free
   *  are the editable text areas in editor mode. */
  detectedClass?: DetectedClass;
  customPrompt?: string; // Image-specific prompt overrides global prompt
  contextOnly?: boolean; // If true, region is visible context only — not translated or painted
  ocrText?: string; // Detected text from OCR
  isOcrLoading?: boolean; // Loading state for OCR
  restoreBoxes?: RestoreBox[]; // Box-based restore regions (框选还原)
  restoreMaskUrl?: string; // Brush-based restore mask Object URL (涂抹还原), alpha=1=processed, 0=original

  // --- In-place manga text editor (editor workflow mode) ---
  editorText?: string;        // Edited/typeset text (falls back to ocrText when unset)
  editorErased?: boolean;     // Original text inside the region has been flood-fill erased
  editorStyle?: EditorTextStyle; // Typeset style overrides
  editorBrushUrl?: string;    // Transparent brush-stroke layer Object URL (region-crop sized)
  editorComposited?: boolean; // processedImageUrl was produced by the editor compositor

  // Retry diagnostics. retryCount counts failed attempts in the current run
  // (cleared when the user manually triggers a fresh processing pass on this
  // region). errorHistory keeps short error messages for the same attempts —
  // surfaced in UI only when AppConfig.showRetryDiagnostics is on.
  retryCount?: number;
  errorHistory?: string[];
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

export type ProcessingMode = 'api' | 'manual' | 'editor';

export type PerformanceMode = 'unlimited' | 'balanced';

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
  maxRetriesPerRegion: number; // per-region retry budget (excludes first attempt). Standard mode: each region counts independently. Full-image-masking mode: all regions in an image share one counter (one API call per image).
  showRetryDiagnostics: boolean; // show per-region retry count badge + error history

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
  enableSquareFill: boolean; // New: Pad image to 1:1 square (blurred background) before sending
  squareFillSize: number; // px: square edge length for square fill (content is never downscaled below its original size)
  squareFillCropInset: number; // px: extra pixels trimmed from every side when cropping back (0 = exact original-ratio box)
  
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

  /** When true, images sent to translation/redraw APIs are re-encoded to WebP
   *  at a target file size (binary search on quality). Preserves pixel
   *  dimensions — no resampling. When false, raw originals are sent. */
  enableAiPayloadCompression: boolean;
  /** Target size in KB for the translation API payload + context image. */
  aiPayloadTranslationTargetKB: number;
  /** Target size in KB for the redraw (image edit) API payload. */
  aiPayloadRedrawTargetKB: number;
}

export enum ProcessingStep {
  IDLE = 'IDLE',
  CROPPING = 'CROPPING',
  API_CALLING = 'API_CALLING',
  STITCHING = 'STITCHING',
  DONE = 'DONE',
}