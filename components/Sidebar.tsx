
import React, { useState, useEffect } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, ThemeType, isRegionPaintable } from '../types';
import { stitchImageInverted } from '../services/imageUtils';
import { hasCachedTranslation } from '../services/translationCache';
import { t } from '../services/translations';
import JSZip from 'jszip';
import { Section } from './sidebar/Section';
import { MangaToolsPanel } from './sidebar/MangaToolsPanel';
import { HelpTip } from './sidebar/HelpTip';

interface SidebarProps {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  images: UploadedImage[];
  selectedImageId: string | null;
  selectedRegionId: string | null;
  onSelectImage: (id: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onProcess: (processAll: boolean) => void;
  /** Translation-only stage (independent of generation), same scope semantics
   *  as onProcess: processAll = whole project, otherwise the selected image. */
  onTranslate: (processAll: boolean) => void;
  onStop: () => void;
  processingState: ProcessingStep;
  currentImage?: UploadedImage;
  onDownload: () => void;
  onDeleteImage: (imageId: string) => void;
  onClearAllImages: () => void;
  onToggleSkip: (imageId: string) => void;
  onAutoDetect: (scope: 'current' | 'all') => void;
  isDetecting: boolean;
  onOpenGlobalSettings: () => void;
  onOpenHelp: () => void;
  onApplyAsOriginal: () => void;
  uploadProgress?: { current: number; total: number } | null;
  /** Returns a cached stitched URL for standard-mode images. The cache owns the URL — do NOT revoke. */
  getStitchedUrl: (image: UploadedImage) => Promise<string>;
}

const SECTION_STORAGE_KEY = 'genai_patcher_sidebar_sections_v1';

const THEMES: { id: ThemeType; label: string; bg: string; ring: string }[] = [
  { id: 'light', label: 'Light', bg: 'bg-slate-100', ring: 'ring-slate-400' },
  { id: 'dark', label: 'Dark', bg: 'bg-zinc-800', ring: 'ring-zinc-500' },
  { id: 'ocean', label: 'Blue', bg: 'bg-sky-400', ring: 'ring-sky-300' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-400', ring: 'ring-rose-300' },
  { id: 'forest', label: 'Green', bg: 'bg-emerald-400', ring: 'ring-emerald-300' },
];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const Sidebar: React.FC<SidebarProps> = ({
  config,
  setConfig,
  images,
  selectedImageId,
  onSelectImage,
  onUpload,
  onProcess,
  onTranslate,
  onStop,
  processingState,
  currentImage,
  onDownload,
  onDeleteImage,
  onClearAllImages,
  onToggleSkip,
  onAutoDetect,
  isDetecting,
  onOpenGlobalSettings,
  onOpenHelp,
  onApplyAsOriginal,
  uploadProgress,
  getStitchedUrl
}) => {
  const [isZipping, setIsZipping] = useState(false);
  const [processAll, setProcessAll] = useState(false);
  const [detectScope, setDetectScope] = useState<'current' | 'all'>('current');
  const [clearConfirmation, setClearConfirmation] = useState(false);
  // Set after a successful download (ZIP or single) so the user remembers to
  // clear the gallery — that also frees the persisted local session.
  const [clearHighlight, setClearHighlight] = useState(false);
  const [storageUsage, setStorageUsage] = useState<number | null>(null);

  // Poll the origin's storage usage (IndexedDB session + everything else on
  // this origin). Refresh immediately when the image count changes, and on a
  // slow interval to catch blob writes from the debounced autosave.
  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      try {
        const est = await navigator.storage.estimate();
        if (!cancelled && typeof est.usage === 'number') setStorageUsage(est.usage);
      } catch { /* Storage API unsupported — hide the indicator */ }
    };
    update();
    const timer = setInterval(update, 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [images.length]);
  
  // Initialize sections state from localStorage or default
  const [sectionsState, setSectionsState] = useState(() => {
    try {
      const saved = localStorage.getItem(SECTION_STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (e) {
      console.error("Failed to load sidebar sections state", e);
    }
    // Default: Gallery and Workflow open
    return {
      gallery: true,
      manga: false,
      workflow: true, // DEFAULT: TRUE
      editor: true
    };
  });

  // Persist sections state when changed
  useEffect(() => {
    localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sectionsState));
  }, [sectionsState]);

  // Scroll gallery to selected thumbnail when selection changes (e.g. arrow keys)
  useEffect(() => {
    if (!selectedImageId) return;
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-image-id="${selectedImageId}"]`);
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
  }, [selectedImageId]);

  const toggleSection = (key: keyof typeof sectionsState) => {
    setSectionsState((prev: any) => ({ ...prev, [key]: !prev[key] }));
  };

  const isProcessing = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE;
  const hasCompletedImages = images.some(img => img.regions.some(r => r.status === 'completed') || img.finalResultUrl);
  const downloadCount = hasCompletedImages 
      ? images.filter(img => img.regions.some(r => r.status === 'completed') || img.isSkipped).length 
      : images.length;
  
  const lang = config.language;

  const handleConfigChange = (key: keyof AppConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleDownloadAllZip = async () => {
    let imagesToZip: UploadedImage[] = [];
    const hasAnyResults = images.some(img => img.regions.some(r => r.status === 'completed') || img.finalResultUrl);
    
    if (hasAnyResults) {
        imagesToZip = images.filter(img => img.regions.some(r => r.status === 'completed') || img.finalResultUrl || img.isSkipped);
    } 
    else {
        imagesToZip = images;
    }

    if (imagesToZip.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder("images");

      // Process images sequentially to avoid OOM with many images
      for (const img of imagesToZip) {
        let targetUrl = img.finalResultUrl || img.previewUrl;
        let needsStitchRelease = false;

        const hasPatches = img.regions.some(r => r.status === 'completed');
        if (hasPatches && !img.isSkipped) {
            try {
               if (config.useInvertedMasking && img.fullAiResultUrl) {
                   targetUrl = await stitchImageInverted(img.previewUrl, img.fullAiResultUrl, img.regions);
                   needsStitchRelease = true;
               } else {
                   // Cached: useImageManager owns the URL across repeated zip calls.
                   targetUrl = await getStitchedUrl(img);
               }
            } catch (e) {
               console.error("Failed to stitch image for zip:", img.file.name, e);
               targetUrl = img.previewUrl;
            }
        }

        const response = await fetch(targetUrl);
        const blob = await response.blob();

        // Only release URLs we created ourselves; cached URLs are owned by useImageManager.
        if (needsStitchRelease && targetUrl.startsWith('blob:')) {
            URL.revokeObjectURL(targetUrl);
        }
        
        const filename = img.file.name.replace(/\.[^.]+$/, '') + '.png';
        
        folder?.file(filename, blob);
      }

      const content = await zip.generateAsync({ type: "blob", streamFiles: true });
      const objectUrl = URL.createObjectURL(content);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = "results.zip";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(objectUrl);
      setClearHighlight(true); // remind the user to free the local session

    } catch (error) {
      console.error("Zip generation failed", error);
      alert("Failed to create zip file");
    } finally {
      setIsZipping(false);
    }
  };

  const handleClearGallery = (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (clearConfirmation) {
          onClearAllImages();
          setClearConfirmation(false);
          setClearHighlight(false);
      } else {
          setClearConfirmation(true);
          setTimeout(() => setClearConfirmation(false), 3000);
      }
  };

  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;
  const targetImageExists = processAll ? images.length > 0 : !!currentImage;
  const hasRegions = processAll 
    ? images.some(i => i.regions.length > 0) 
    : (currentImage?.regions.length || 0) > 0;
  const canProceedWithEmptyRegions = config.processFullImageIfNoRegions === true;
    
  // --- Translation stage gating (independent task, see useImageProcessor.handleTranslate) ---
  const scopedImages = processAll
      ? images.filter(img => !img.isSkipped)
      : (currentImage ? [currentImage] : []);
  const isGenPaintable = (r: UploadedImage['regions'][number]) =>
      isRegionPaintable(r, config.generationRegionSource ?? 'text');
  const translationReady = scopedImages.some(img =>
      config.useFullImageMasking
          ? img.regions.some(isGenPaintable) && hasCachedTranslation(img.customPrompt)
          : img.regions.some(r => isGenPaintable(r) && hasCachedTranslation(r.customPrompt))
  );
  const translationWorkLeft = scopedImages.some(img =>
      config.useFullImageMasking
          ? img.regions.some(isGenPaintable) && !hasCachedTranslation(img.customPrompt)
          : img.regions.some(r => isGenPaintable(r) && !hasCachedTranslation(r.customPrompt))
  );

  const getDisabledReason = () => {
      if (!targetImageExists) return "No image selected";
      if (!hasValidKey) return "Missing API Key (Check Settings)";
      if (!hasRegions && !canProceedWithEmptyRegions) return "No regions selected";
      // 必须翻译 on but nothing translated yet: generating would only skip
      // everything, so point the user at the translate stage instead.
      if (config.enableTranslationMode && config.requireTranslationForGeneration && !translationReady) {
          return t(lang, 'requireTranslationNone');
      }
      return "";
  };

  const getTranslateDisabledReason = () => {
      if (!config.enableTranslationMode || !config.translationApiKey || !config.translationBaseUrl) {
          return t(lang, 'translateMissingConfig');
      }
      if (scopedImages.length === 0) return t(lang, 'translateNoTarget');
      if (!translationWorkLeft) return t(lang, 'translateNothingToDo');
      return "";
  };

  const isEditorMode = config.processingMode === 'editor';
  // The editor workflow tab is gated behind the manga module + 修补编辑器 switch.
  const editorTabAvailable = config.enableMangaMode && config.enableManualEditor;
  const statusKey = processingState.toLowerCase() as any;
  const showMangaToolkit = config.enableMangaMode;

  // If the editor tab's gating switch is turned off while editor mode is
  // active, fall back to manual mode so the UI never gets stuck on a hidden tab.
  useEffect(() => {
    if (isEditorMode && !editorTabAvailable) {
      handleConfigChange('processingMode', 'manual');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditorMode, editorTabAvailable]);

  return (
    <aside className="w-80 h-full bg-skin-surface border-r border-skin-border flex flex-col shadow-2xl z-20 relative">
      <div className="p-5 border-b border-skin-border bg-skin-surface relative flex flex-col gap-4">
        {/* Header Buttons */}
        <div className="absolute top-3 right-3 flex gap-1">
             <button
               onClick={onOpenGlobalSettings}
               className="p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
               title={t(lang, 'globalSettings')}
             >
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
             </button>

             <button
               onClick={onOpenHelp}
               className="p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
               title={t(lang, 'helpTitle')}
             >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
             </button>
        </div>

        <div className="pr-16">
           <h1 className="font-bold text-xl text-skin-primary tracking-tight">{t(lang, 'appTitle')}</h1>
           <p className="text-[10px] text-skin-muted uppercase tracking-wider">{t(lang, 'appSubtitle')}</p>
        </div>
        
        <div className="flex items-center justify-between bg-skin-fill p-2.5 rounded-xl border border-skin-border/50">
           <span className="text-[10px] font-bold text-skin-muted uppercase tracking-wider">Theme Style</span>
           <div className="flex items-center gap-3">
             {THEMES.map(theme => (
               <button
                 key={theme.id}
                 onClick={() => handleConfigChange('theme', theme.id)}
                 className={`w-5 h-5 rounded-full ${theme.bg} border-2 border-transparent transition-all duration-200 ${
                   config.theme === theme.id 
                     ? 'ring-2 ring-skin-text scale-110 border-white shadow-md' 
                     : 'hover:scale-110 hover:border-skin-border opacity-70 hover:opacity-100'
                 }`}
                 title={theme.label}
                 aria-label={theme.label}
               />
             ))}
           </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
        
        {/* Gallery Section */}
        <Section title={t(lang, 'galleryTitle')} isOpen={sectionsState.gallery} onToggle={() => toggleSection('gallery')}>
           <div className="flex gap-2 mb-2">
               <label className="flex-1 border border-dashed border-skin-border hover:border-skin-primary rounded-xl p-2 text-center cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex flex-col items-center justify-center h-20">
                  <input type="file" multiple accept="image/*" className="hidden" onChange={onUpload} />
                  <svg className="w-5 h-5 text-skin-muted group-hover:text-skin-primary mb-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                  <span className="text-[10px] font-medium text-skin-muted group-hover:text-skin-text leading-tight">{t(lang, 'uploadFiles')}</span>
               </label>
               
               <label className="flex-1 border border-dashed border-skin-border hover:border-skin-primary rounded-xl p-2 text-center cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex flex-col items-center justify-center h-20">
                  <input 
                    type="file" 
                    multiple 
                    {...({ webkitdirectory: "", directory: "" } as any)}
                    className="hidden" 
                    onChange={onUpload}
                    onClick={(e) => (e.currentTarget.value = '')}
                  />
                  <svg className="w-5 h-5 text-skin-muted group-hover:text-skin-primary mb-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                  <span className="text-[10px] font-medium text-skin-muted group-hover:text-skin-text leading-tight">{t(lang, 'uploadFolder')}</span>
               </label>
            </div>

            {uploadProgress && uploadProgress.total > 0 && (
              <div className="mb-2 animate-in fade-in slide-in-from-top-1">
                <div className="flex justify-between text-[10px] text-skin-muted font-bold mb-1">
                  <span>{t(lang, 'uploadingProgress', { current: uploadProgress.current, total: uploadProgress.total })}</span>
                  <span>{Math.round((uploadProgress.current / uploadProgress.total) * 100)}%</span>
                </div>
                <div className="h-1.5 w-full bg-skin-fill rounded-full overflow-hidden">
                  <div
                    className="h-full bg-skin-primary rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }}
                  ></div>
                </div>
              </div>
            )}

            {images.length > 0 ? (
             <div className="space-y-2">
                <div className="flex gap-2">
                    <button 
                        onClick={handleDownloadAllZip}
                        disabled={isZipping}
                        className="flex-1 py-1.5 text-xs border border-skin-border rounded-lg text-skin-muted hover:text-skin-primary hover:border-skin-primary transition-colors flex items-center justify-center gap-2 bg-skin-fill/30"
                        title={t(lang, 'downloadZip')}
                    >
                        {isZipping ? (
                            <>
                                <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                {t(lang, 'zipping')}
                            </>
                        ) : (
                            <>
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                                ZIP ({downloadCount})
                            </>
                        )}
                    </button>
                    
                    <button
                        type="button"
                        onClick={handleClearGallery}
                        className={`px-3 py-1.5 text-xs border rounded-lg transition-all flex items-center justify-center gap-1 ${
                            clearConfirmation
                                ? 'bg-rose-500 text-white border-rose-600 shadow-md scale-105'
                                : clearHighlight
                                    ? 'border-rose-500 text-rose-500 bg-rose-500/10 shadow-[0_0_10px_rgba(244,63,94,0.45)] animate-pulse'
                                    : 'border-skin-border text-skin-muted hover:text-rose-500 hover:border-rose-500 hover:bg-rose-50 bg-skin-fill/30'
                        }`}
                        title={clearConfirmation ? "Click again to confirm" : clearHighlight ? t(lang, 'clearGalleryHint') : t(lang, 'clearGallery')}
                    >
                        {clearConfirmation ? (
                            <span className="font-bold text-[10px] animate-pulse">SURE?</span>
                        ) : (
                            <>
                                <svg className="w-3.5 h-3.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                                {clearHighlight && <span className="font-bold text-[10px] pointer-events-none whitespace-nowrap">{t(lang, 'clearGallery')}</span>}
                            </>
                        )}
                    </button>
                </div>

                <div className="grid grid-cols-2 gap-2 max-h-[240px] overflow-y-auto custom-scrollbar pr-1 border border-skin-border/30 rounded-lg p-1 bg-skin-fill/10">
                  {images.map(img => (
                    <div 
                      key={img.id}
                      data-image-id={img.id}
                      className={`group relative flex flex-col p-2 rounded-lg border transition-all cursor-pointer overflow-hidden ${selectedImageId === img.id ? 'border-skin-primary bg-skin-primary/5 shadow-sm ring-1 ring-skin-primary/30' : 'border-skin-border bg-skin-surface hover:border-skin-primary/50'}`}
                      onClick={() => onSelectImage(img.id)}
                    >
                        <div className="w-full aspect-square rounded overflow-hidden bg-checkerboard relative mb-1.5">
                          <img src={img.thumbnailUrl || img.previewUrl} className={`w-full h-full object-contain ${img.isSkipped ? 'grayscale opacity-50' : ''}`} loading="lazy" decoding="async" />
                          
                          {img.isSkipped && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-0">
                              <span className="text-[9px] text-white font-bold bg-black/50 px-1 rounded">SKIP</span>
                            </div>
                          )}
                          
                          <button 
                             onClick={(e) => { e.stopPropagation(); onToggleSkip(img.id); }}
                             className={`absolute top-1 left-1 p-1 rounded-sm shadow-sm transition-all z-10 ${img.isSkipped ? 'bg-skin-primary text-white' : 'bg-skin-surface/90 text-skin-muted hover:text-skin-primary hover:bg-white'}`}
                             title={img.isSkipped ? t(lang, 'enableImage') : t(lang, 'skipImage')}
                          >
                             {img.isSkipped ? (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                             ) : (
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"></path></svg>
                             )}
                          </button>

                          <button 
                             onClick={(e) => { e.stopPropagation(); onDeleteImage(img.id); }}
                             className="absolute top-1 right-1 p-1 rounded-sm bg-skin-surface/90 hover:bg-rose-500 hover:text-white text-rose-500 shadow-sm transition-all z-10"
                             title={t(lang, 'deleteImage')}
                          >
                             <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                          </button>

                          {(img.regions.some(r => r.status === 'completed') || img.finalResultUrl) && (
                             <div className="absolute bottom-1 right-1 w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-sm border border-white z-10" title="Completed"></div>
                          )}
                        </div>

                        <div className="flex-1 min-w-0 w-full px-0.5">
                           <div className="text-[10px] font-medium truncate text-skin-text leading-tight" title={img.file.name}>{img.file.name}</div>
                           <div className="flex items-center justify-between gap-1 mt-1">
                              <span className="text-[9px] text-skin-muted truncate">{img.originalWidth}x{img.originalHeight}</span>
                              {img.regions.length > 0 && <span className="text-[9px] bg-skin-fill px-1 rounded text-skin-muted whitespace-nowrap">{img.regions.length} reg</span>}
                           </div>
                        </div>
                    </div>
                  ))}
                </div>

                <div className="text-[10px] text-skin-muted text-center flex justify-between px-1">
                   <span>{images.length} images</span>
                   <span>{downloadCount} processed</span>
                </div>

                {storageUsage !== null && config.enableSessionPersistence && (
                   <div className="text-[10px] text-skin-muted/80 text-center px-1 -mt-1" title={t(lang, 'localCacheTip')}>
                      {t(lang, 'localCache')}: {formatBytes(storageUsage)}
                   </div>
                )}
             </div>
           ) : (
             <div className="text-center py-6 text-xs text-skin-muted italic border-2 border-dashed border-skin-border rounded-lg bg-skin-fill/20">
                {t(lang, 'dropToUpload')}
             </div>
           )}
        </Section>
        
        <Section title={t(lang, 'modeTitle')} isOpen={sectionsState.workflow} onToggle={() => toggleSection('workflow')}>
           <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
               {(['api', 'manual', 'editor'] as const)
                 .filter(m => m !== 'editor' || editorTabAvailable)
                 .map(m => (
                 <button
                   key={m}
                   onClick={() => handleConfigChange('processingMode', m)}
                   className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${config.processingMode === m ? 'bg-skin-surface text-skin-primary shadow-sm' : 'text-skin-muted hover:text-skin-text'}`}
                 >
                    {m === 'api' ? t(lang, 'modeApi') : m === 'manual' ? t(lang, 'modeManual') : t(lang, 'modeEditor')}
                 </button>
               ))}
           </div>

           {/* Square Fill — applies to BOTH API processing and the manual workbench,
               so it lives here in the mode section instead of the API-only settings. */}
           <div className="pt-3 mt-3 border-t border-skin-border/50">
               {/* squareFill is meaningless when inverted masking is active: padding gets undone
                   immediately after the API call / on paste. Disable the toggle and grey it out. */}
               {(() => {
                   const squareFillDisabled = !!config.useInvertedMasking;
                   return (
                       <label className={`flex items-start gap-2 group ${squareFillDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                           <input
                               type="checkbox"
                               checked={config.enableSquareFill && !squareFillDisabled}
                               disabled={squareFillDisabled}
                               onChange={(e) => handleConfigChange('enableSquareFill', e.target.checked)}
                               className="mt-0.5 rounded border-skin-border text-skin-primary focus:ring-skin-primary disabled:opacity-50"
                           />
                           <span className="block text-xs font-medium text-skin-text group-hover:text-skin-primary transition-colors">{t(lang, 'squareFill')}</span>
                           {/* Long description moved behind the "?" (hover/focus) —
                               when the toggle is auto-disabled the icon turns amber
                               and carries the reason instead. */}
                           <HelpTip
                               className="ml-auto mt-0.5"
                               tone={squareFillDisabled ? 'warn' : 'default'}
                               text={squareFillDisabled
                                   ? t(lang, 'squareFillDisabledByInvertedTip')
                                   : t(lang, 'squareFillDesc')}
                           />
                       </label>

                   );
               })()}
               {config.enableSquareFill && !config.useInvertedMasking && (
                   <div className="mt-2 ml-1 pl-5 border-l-2 border-skin-border/30 space-y-2">
                       {/* Square edge length */}
                       <label className="flex items-center gap-2 text-[11px]">
                           <span className="text-skin-muted">{t(lang, 'squareFillSize')}</span>
                           <input
                               type="number"
                               min={256}
                               max={8192}
                               value={config.squareFillSize}
                               onChange={(e) => handleConfigChange('squareFillSize', Math.max(256, Math.min(8192, Number(e.target.value) || 1024)))}
                               className="w-16 px-1.5 py-0.5 text-xs bg-skin-fill border border-skin-border rounded focus:outline-none focus:ring-1 focus:ring-skin-primary text-skin-text"
                           />
                       </label>
                       {/* Extra inset while cropping back — removes residual blur bleed.
                           Its description also lives behind the "?". */}
                       <label className="flex items-center gap-2 text-[11px]">
                           <span className="text-skin-muted">{t(lang, 'squareFillCropInset')}</span>
                           <input
                               type="number"
                               min={0}
                               max={256}
                               value={config.squareFillCropInset}
                               onChange={(e) => handleConfigChange('squareFillCropInset', Math.max(0, Math.min(256, Math.round(Number(e.target.value)) || 0)))}
                               className="w-16 px-1.5 py-0.5 text-xs bg-skin-fill border border-skin-border rounded focus:outline-none focus:ring-1 focus:ring-skin-primary text-skin-text"
                           />
                           <HelpTip className="ml-auto" text={t(lang, 'squareFillCropInsetDesc')} />
                       </label>
                       </div>
               )}
           </div>
        </Section>

        {showMangaToolkit && (
            <Section title={t(lang, 'mangaTitle')} isOpen={sectionsState.manga} onToggle={() => toggleSection('manga')}>
               <MangaToolsPanel 
                  config={config}
                  onChange={handleConfigChange}
                  onAutoDetect={onAutoDetect}
                  isDetecting={isDetecting}
                  currentImage={currentImage}
                  detectScope={detectScope}
                  setDetectScope={setDetectScope}
               />
            </Section>
        )}

      </div>

      {/* Footer */}
      <div className="p-4 bg-skin-surface border-t border-skin-border z-10">
         {processingState !== ProcessingStep.IDLE && (
            <div className="mb-3">
               <div className="flex justify-between text-[10px] text-skin-muted uppercase font-bold mb-1">
                  <span>{t(lang, statusKey)}</span>
                  {processingState !== ProcessingStep.DONE && <span className="animate-pulse">...</span>}
               </div>
               <div className="h-1.5 w-full bg-skin-fill rounded-full overflow-hidden">
                  <div className={`h-full bg-skin-primary rounded-full transition-all duration-300 ${processingState === ProcessingStep.DONE ? 'w-full bg-emerald-500' : 'w-2/3 animate-progress-indeterminate'}`}></div>
               </div>
            </div>
         )}
         
         {!isProcessing ? (
           <div className="space-y-2">
             {/* Editor mode is fully local (erase/typeset/brush) — no API call,
                 so no Redraw button. Results surface via Download / Apply. */}
             {!isEditorMode && (
               <>
                 <label className="flex items-center justify-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={processAll}
                      onChange={(e) => setProcessAll(e.target.checked)}
                      className="rounded border-skin-border text-skin-primary focus:ring-skin-primary"
                    />
                    <span className="text-xs text-skin-muted">{t(lang, 'applyAll', { count: images.length })}</span>
                 </label>

                 {/* Translation stage — fully independent from the redraw stage: run
                     it first to fill the cache (and grow the glossary), then redraw. */}
                 <button
                    onClick={() => onTranslate(processAll)}
                    disabled={!!getTranslateDisabledReason()}
                    className="w-full py-2 border border-sky-500/60 text-sky-600 dark:text-sky-400 bg-sky-500/5 hover:bg-sky-500/15 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-sky-500/5 font-medium rounded-lg text-xs transition-colors flex items-center justify-center gap-1.5"
                    title={getTranslateDisabledReason() || t(lang, 'translateStageHint')}
                 >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"></path></svg>
                    {t(lang, processAll ? 'translateAll' : 'translate')}
                 </button>

                 <button
                    onClick={() => onProcess(processAll)}
                    disabled={!!getDisabledReason()}
                    className="w-full py-3 bg-skin-primary hover:bg-opacity-90 disabled:bg-skin-muted disabled:cursor-not-allowed text-skin-primary-fg font-bold rounded-lg shadow-lg shadow-skin-primary/20 transition-all active:scale-95 flex items-center justify-center gap-2"
                    title={getDisabledReason()}
                 >
                    {t(lang, processAll ? 'generateAll' : 'generate')}
                 </button>

                 {config.enableTranslationMode && (
                    <p className="text-[10px] text-skin-muted leading-tight text-center">{t(lang, 'translateStageHint')}</p>
                 )}
                 {config.enableTranslationMode && config.requireTranslationForGeneration && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight text-center">
                       ⚠️ {t(lang, 'requireTranslation')}
                    </p>
                 )}
               </>
             )}

             <div className="grid grid-cols-2 gap-2">
                 {(currentImage?.finalResultUrl || currentImage?.regions.some(r => r.status === 'completed')) && (
                     <>
                        <button 
                        onClick={onApplyAsOriginal}
                        className="w-full py-2 border border-skin-border text-skin-text bg-skin-fill hover:bg-skin-surface font-medium rounded-lg text-xs transition-colors"
                        title={t(lang, 'applyAsOriginal')}
                        >
                            {t(lang, 'applyAsOriginal')}
                        </button>
                        <button
                        onClick={() => { onDownload(); setClearHighlight(true); }}
                        className="w-full py-2 border border-skin-border text-skin-text bg-skin-fill hover:bg-skin-surface font-medium rounded-lg text-xs transition-colors"
                        title={t(lang, 'downloadResult')}
                        >
                            {t(lang, 'downloadResult')}
                        </button>
                     </>
                 )}
             </div>
           </div>
         ) : (
           <button 
              onClick={onStop}
              className="w-full py-3 bg-rose-500 hover:bg-rose-600 text-white font-bold rounded-lg shadow-lg transition-all active:scale-95"
           >
              {t(lang, 'stop')}
           </button>
         )}
      </div>
      
    </aside>
  );
};

export default React.memo(Sidebar);
