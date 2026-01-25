
import React, { useState, useEffect } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, ThemeType, Region } from '../types';
import { fetchOpenAIModels } from '../services/aiService';
import { cropRegion, loadImage } from '../services/imageUtils';
import { t } from '../services/translations';
import JSZip from 'jszip';

interface SidebarProps {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  images: UploadedImage[];
  selectedImageId: string | null;
  onSelectImage: (id: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onProcess: (processAll: boolean) => void;
  onStop: () => void;
  processingState: ProcessingStep;
  currentImage?: UploadedImage;
  onDownload: () => void;
  onManualPatchUpdate: (imageId: string, regionId: string, base64: string) => void;
  onUpdateImagePrompt: (imageId: string, prompt: string) => void;
  onDeleteImage: (imageId: string) => void;
  onToggleSkip: (imageId: string) => void;
  onAutoDetect: (scope: 'current' | 'all') => void;
  isDetecting: boolean;
  onOpenEditor: (imageId: string, regionId: string) => void;
}

const Section: React.FC<{ 
  title: string; 
  children: React.ReactNode; 
  isOpen?: boolean; 
  onToggle?: () => void 
}> = ({ title, children, isOpen, onToggle }) => {
  return (
    <div className="border border-skin-border rounded-lg overflow-hidden bg-skin-surface shadow-sm transition-all hover:shadow-md">
      <button 
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-skin-fill/50 hover:bg-skin-fill transition-colors text-left"
      >
        <span className="text-xs font-semibold text-skin-muted uppercase tracking-wide">{title}</span>
        <svg 
          className={`w-4 h-4 text-skin-muted transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="p-4 border-t border-skin-border space-y-4">
          {children}
        </div>
      )}
    </div>
  );
};

const ManualPatchRow: React.FC<{
  region: Region;
  image: UploadedImage;
  onPatchUpdate: (base64: string) => void;
  lang: 'zh' | 'en';
  onOpenEditor: () => void;
}> = ({ region, image, onPatchUpdate, lang, onOpenEditor }) => {
  const [sourceCrop, setSourceCrop] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const generateCrop = async () => {
      try {
        const imgEl = await loadImage(image.previewUrl);
        const crop = await cropRegion(imgEl, region);
        if (active) setSourceCrop(crop);
      } catch (e) {
        console.error("Failed to crop for manual view", e);
      }
    };
    generateCrop();
    return () => { active = false; };
  }, [image.previewUrl, region]);

  const handleCopy = async () => {
    if (!sourceCrop) return;
    try {
      const response = await fetch(sourceCrop);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed", e);
      alert("Browser blocked copy. Please right click image to copy.");
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
             if (evt.target?.result) {
                onPatchUpdate(evt.target.result as string);
             }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    }
  };

  return (
    <div className={`flex items-stretch gap-2 bg-skin-fill/30 p-2 rounded-lg border ${region.source === 'auto' ? 'border-dashed border-skin-primary/50' : 'border-skin-border'}`}>
      <div className="flex-1 flex flex-col gap-1 items-center">
         <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'sourceCrop')}</span>
         <div className="w-16 h-16 bg-checkerboard rounded border border-skin-border overflow-hidden relative group">
            {sourceCrop ? (
              <img src={sourceCrop} className="w-full h-full object-contain" />
            ) : (
              <div className="w-full h-full animate-pulse bg-skin-fill"></div>
            )}
            {region.source === 'auto' && (
                <div className="absolute top-0 right-0 p-0.5 bg-skin-primary text-white rounded-bl shadow-sm" title="Detected Automatically">
                   <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </div>
            )}
         </div>
         <div className="flex gap-1 w-full">
             <button 
               onClick={handleCopy}
               disabled={!sourceCrop}
               className="flex-1 text-[9px] px-1 py-1 bg-skin-surface border border-skin-border rounded hover:bg-skin-fill transition-colors text-center truncate"
               title={t(lang, 'copyCrop')}
             >
               {copied ? t(lang, 'copied') : t(lang, 'copyCrop')}
             </button>
         </div>
      </div>

      <div className="flex items-center text-skin-muted flex-col justify-center">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path></svg>
      </div>

      <div 
        className="flex-1 flex flex-col gap-1 items-center"
      >
         <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'patchZone')}</span>
         <div 
           className={`w-16 h-16 bg-skin-surface rounded border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer outline-none transition-all relative group ${
             region.status === 'completed' ? 'border-emerald-400 bg-emerald-50/50' : 'border-skin-border hover:border-skin-primary focus:border-skin-primary focus:ring-1 focus:ring-skin-primary/50'
           }`}
           tabIndex={0}
           onPaste={handlePaste}
           title={t(lang, 'pasteHint')}
         >
            {region.processedImageBase64 ? (
              <img src={region.processedImageBase64} className="w-full h-full object-contain" />
            ) : (
              <span className="text-[9px] text-skin-muted text-center px-1">Ctrl+V</span>
            )}
            
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                 <button 
                    onClick={(e) => { e.stopPropagation(); onOpenEditor(); }}
                    className="p-1 rounded bg-white text-skin-primary shadow-sm hover:scale-110 transition-transform"
                    title={t(lang, 'editor_title')}
                 >
                     <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                 </button>
            </div>
         </div>
         
         <div className={`text-[9px] font-bold py-1 ${
             region.status === 'completed' ? 'text-emerald-500' : 
             region.status === 'failed' ? 'text-rose-500' :
             'text-skin-muted'
         }`}>
            {region.status === 'failed' ? t(lang, 'status_failed') : region.status === 'completed' ? 'Done' : 'Empty'}
         </div>
      </div>
    </div>
  );
};

const THEMES: { id: ThemeType; label: string; bg: string; ring: string }[] = [
  { id: 'light', label: 'Light', bg: 'bg-slate-100', ring: 'ring-slate-400' },
  { id: 'dark', label: 'Dark', bg: 'bg-zinc-800', ring: 'ring-zinc-500' },
  { id: 'ocean', label: 'Blue', bg: 'bg-sky-400', ring: 'ring-sky-300' },
  { id: 'rose', label: 'Rose', bg: 'bg-rose-400', ring: 'ring-rose-300' },
  { id: 'forest', label: 'Green', bg: 'bg-emerald-400', ring: 'ring-emerald-300' },
];

const Sidebar: React.FC<SidebarProps> = ({
  config,
  setConfig,
  images,
  selectedImageId,
  onSelectImage,
  onUpload,
  onProcess,
  onStop,
  processingState,
  currentImage,
  onDownload,
  onManualPatchUpdate,
  onUpdateImagePrompt,
  onDeleteImage,
  onToggleSkip,
  onAutoDetect,
  isDetecting,
  onOpenEditor
}) => {
  const [modelList, setModelList] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [processAll, setProcessAll] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [detectScope, setDetectScope] = useState<'current' | 'all'>('current');
  const [showDetectTuning, setShowDetectTuning] = useState(false);

  const [sectionsState, setSectionsState] = useState({
    gallery: true,
    smart: true,
    workflow: true,
    prompt: true,
    settings: false, 
    execution: false,
    manual: true
  });

  const toggleSection = (key: keyof typeof sectionsState) => {
    setSectionsState(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isProcessing = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE;
  const readyForZipCount = images.filter(img => img.finalResultUrl || img.isSkipped).length;
  const lang = config.language;

  const handleConfigChange = (key: keyof AppConfig, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleFetchOpenAIModels = async () => {
    if (!config.openaiApiKey || !config.openaiBaseUrl) {
      alert("Please enter API Key and Base URL first.");
      return;
    }
    setIsLoadingModels(true);
    try {
      const models = await fetchOpenAIModels(config.openaiBaseUrl, config.openaiApiKey);
      setModelList(models);
      if (models.length > 0 && !models.includes(config.openaiModel)) {
        handleConfigChange('openaiModel', models[0]);
      }
    } catch (e: any) {
      alert("Failed to fetch models: " + e.message);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const handleDownloadAllZip = async () => {
    const imagesToZip = images.filter(img => img.finalResultUrl || img.isSkipped);
    if (imagesToZip.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder("patched_results");

      const promises = imagesToZip.map(async (img, index) => {
        const targetUrl = img.isSkipped ? img.previewUrl : img.finalResultUrl;
        if (!targetUrl) return;
        
        const response = await fetch(targetUrl);
        const blob = await response.blob();
        
        const originalName = img.file.name.substring(0, img.file.name.lastIndexOf('.')) || img.file.name;
        const ext = img.file.name.split('.').pop() || 'png';
        const filename = `${originalName}_${img.isSkipped ? 'original' : 'patched'}.${ext}`;
        
        folder?.file(filename, blob);
      });

      await Promise.all(promises);
      
      const content = await zip.generateAsync({ type: "blob" });
      
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = "results.zip";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

    } catch (error) {
      console.error("Zip generation failed", error);
      alert("Failed to create zip file");
    } finally {
      setIsZipping(false);
    }
  };

  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;
  const targetImageExists = processAll ? images.length > 0 : !!currentImage;
  const hasRegions = processAll 
    ? images.some(i => i.regions.length > 0) 
    : (currentImage?.regions.length || 0) > 0;
  const canProceedWithEmptyRegions = config.processFullImageIfNoRegions === true;
    
  const getDisabledReason = () => {
      if (!targetImageExists) return "No image selected";
      if (!hasValidKey) return "Missing API Key (Check Settings)";
      if (!hasRegions && !canProceedWithEmptyRegions) return "No regions selected";
      return "";
  };

  const isManualMode = config.processingMode === 'manual';
  const statusKey = processingState.toLowerCase() as any;

  return (
    <aside className="w-80 h-full bg-skin-surface border-r border-skin-border flex flex-col shadow-xl z-20 relative">
      <div className="p-5 border-b border-skin-border bg-skin-surface relative flex flex-col gap-4">
        {/* Help Button - Absolute Top Right */}
        <button 
          onClick={() => setShowHelp(true)}
          className="absolute top-3 right-3 p-2 text-skin-muted hover:text-skin-primary hover:bg-skin-fill rounded-full transition-all"
          title={t(lang, 'guideTitle')}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        </button>

        <div className="pr-10">
           <h1 className="font-bold text-xl text-skin-primary tracking-tight">{t(lang, 'appTitle')}</h1>
           <p className="text-[10px] text-skin-muted uppercase tracking-wider">{t(lang, 'appSubtitle')}</p>
        </div>
        
        {/* Theme Toggle */}
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
           {/* Upload Buttons */}
           <div className="flex gap-2 mb-2">
               <label className="flex-1 border border-dashed border-skin-border hover:border-skin-primary rounded p-2 text-center cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex flex-col items-center justify-center h-20">
                  <input type="file" multiple accept="image/*" className="hidden" onChange={onUpload} />
                  <svg className="w-5 h-5 text-skin-muted group-hover:text-skin-primary mb-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                  <span className="text-[10px] font-medium text-skin-muted group-hover:text-skin-text leading-tight">{t(lang, 'uploadFiles')}</span>
               </label>
               
               <label className="flex-1 border border-dashed border-skin-border hover:border-skin-primary rounded p-2 text-center cursor-pointer transition-colors bg-skin-fill/30 hover:bg-skin-fill group flex flex-col items-center justify-center h-20">
                  {/* @ts-ignore */}
                  <input type="file" multiple webkitdirectory="" directory="" className="hidden" onChange={onUpload} />
                  <svg className="w-5 h-5 text-skin-muted group-hover:text-skin-primary mb-1 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                  <span className="text-[10px] font-medium text-skin-muted group-hover:text-skin-text leading-tight">{t(lang, 'uploadFolder')}</span>
               </label>
           </div>

           {/* Image List (Grid 2 per row) */}
           {images.length > 0 ? (
             <div className="space-y-0">
                <div className="grid grid-cols-2 gap-2">
                  {images.map(img => (
                    <div 
                      key={img.id} 
                      className={`group relative flex flex-col p-2 rounded-md border transition-all cursor-pointer overflow-hidden ${selectedImageId === img.id ? 'border-skin-primary bg-skin-primary/5 shadow-sm' : 'border-skin-border bg-skin-surface hover:border-skin-primary/50'}`}
                      onClick={() => onSelectImage(img.id)}
                    >
                        <div className="w-full aspect-square rounded overflow-hidden bg-checkerboard relative mb-1.5">
                          <img src={img.previewUrl} className={`w-full h-full object-contain ${img.isSkipped ? 'grayscale opacity-50' : ''}`} />
                          
                          {/* Skipped Overlay */}
                          {img.isSkipped && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/20 z-0">
                              <span className="text-[9px] text-white font-bold bg-black/50 px-1 rounded">SKIP</span>
                            </div>
                          )}
                          
                          {/* --- ACTION BUTTONS (Updated Locations) --- */}
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

                          {img.finalResultUrl && (
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

                {readyForZipCount > 0 && (
                  <button 
                    onClick={handleDownloadAllZip}
                    disabled={isZipping}
                    className="w-full mt-3 py-1.5 text-xs border border-skin-border rounded text-skin-muted hover:text-skin-primary hover:border-skin-primary transition-colors flex items-center justify-center gap-2"
                  >
                    {isZipping ? (
                      <>
                        <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                        {t(lang, 'zipping')}
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        {t(lang, 'downloadZip')} ({readyForZipCount})
                      </>
                    )}
                  </button>
                )}
             </div>
           ) : (
             <div className="text-center py-6 text-xs text-skin-muted italic border-2 border-dashed border-skin-border rounded-lg bg-skin-fill/20">
                {t(lang, 'dropToUpload')}
             </div>
           )}
        </Section>
        
        {/* Smart Detection */}
        {currentImage && (
            <Section title={t(lang, 'detectTitle')} isOpen={sectionsState.smart} onToggle={() => toggleSection('smart')}>
               <div className="flex gap-2 mb-2 bg-skin-fill p-1 rounded border border-skin-border">
                  <button 
                     onClick={() => setDetectScope('current')}
                     className={`flex-1 py-1.5 text-[10px] rounded transition-all ${detectScope === 'current' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                  >
                     {t(lang, 'detectScopeCurrent')}
                  </button>
                  <button 
                     onClick={() => setDetectScope('all')}
                     className={`flex-1 py-1.5 text-[10px] rounded transition-all ${detectScope === 'all' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                  >
                     {t(lang, 'detectScopeAll')}
                  </button>
               </div>

               <button
                  onClick={() => onAutoDetect(detectScope)}
                  disabled={isDetecting}
                  className="w-full py-3 bg-gradient-to-r from-violet-500 to-fuchsia-500 hover:from-violet-600 hover:to-fuchsia-600 text-white font-bold rounded-lg shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 mb-2"
               >
                  {isDetecting ? (
                      <>
                         <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                         {t(lang, 'detecting')}
                      </>
                  ) : (
                      <>
                         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                         {t(lang, 'detectBtn')}
                      </>
                  )}
               </button>
               
               <button 
                 onClick={() => setShowDetectTuning(!showDetectTuning)}
                 className="w-full text-[10px] text-skin-muted flex items-center justify-center gap-1 hover:text-skin-text mb-2"
               >
                  {showDetectTuning ? '▼' : '▶'} {t(lang, 'detectAdvanced')}
               </button>
               
               {showDetectTuning && (
                 <div className="bg-skin-fill/30 p-2 rounded border border-skin-border space-y-3 animate-in fade-in slide-in-from-top-1">
                    <div>
                       <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                          <span>{t(lang, 'detectInflation')}</span>
                          <span className="font-mono text-skin-primary">{config.detectionInflationPercent > 0 ? '+' : ''}{config.detectionInflationPercent}%</span>
                       </div>
                       <input 
                         type="range" min="-20" max="100" step="5"
                         value={config.detectionInflationPercent}
                         onChange={(e) => handleConfigChange('detectionInflationPercent', Number(e.target.value))}
                         className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                       />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-2">
                       <div>
                           <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                              <span>Offset X</span>
                              <span className="font-mono text-skin-primary">{config.detectionOffsetXPercent}%</span>
                           </div>
                           <input 
                             type="range" min="-50" max="50" step="5"
                             value={config.detectionOffsetXPercent}
                             onChange={(e) => handleConfigChange('detectionOffsetXPercent', Number(e.target.value))}
                             className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                           />
                       </div>
                       <div>
                           <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                              <span>Offset Y</span>
                              <span className="font-mono text-skin-primary">{config.detectionOffsetYPercent}%</span>
                           </div>
                           <input 
                             type="range" min="-50" max="50" step="5"
                             value={config.detectionOffsetYPercent}
                             onChange={(e) => handleConfigChange('detectionOffsetYPercent', Number(e.target.value))}
                             className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                           />
                       </div>
                    </div>

                    <div>
                       <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                          <span>{t(lang, 'detectConfidence')}</span>
                          <span className="font-mono text-skin-primary">{config.detectionConfidenceThreshold / 100}</span>
                       </div>
                       <input 
                         type="range" min="10" max="90" step="5"
                         value={config.detectionConfidenceThreshold}
                         onChange={(e) => handleConfigChange('detectionConfidenceThreshold', Number(e.target.value))}
                         className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                       />
                    </div>
                 </div>
               )}

               <p className="text-[10px] text-skin-muted text-center mt-1 mb-2">{t(lang, 'detectTip')}</p>
               
               <div className="pt-2 border-t border-skin-border/50">
                   <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'detectApiLabel')}</label>
                   <input 
                     type="text" 
                     value={config.detectionApiUrl}
                     onChange={(e) => handleConfigChange('detectionApiUrl', e.target.value)}
                     className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface focus:border-skin-primary transition-colors"
                     placeholder="http://localhost:5000/detect"
                   />
               </div>
            </Section>
        )}

        {/* Workflow Mode */}
        <Section title={t(lang, 'modeTitle')} isOpen={sectionsState.workflow} onToggle={() => toggleSection('workflow')}>
           <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
               {(['api', 'manual'] as const).map(m => (
                 <button
                   key={m}
                   onClick={() => handleConfigChange('processingMode', m)}
                   className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${config.processingMode === m ? 'bg-skin-surface text-skin-primary shadow-sm' : 'text-skin-muted hover:text-skin-text'}`}
                 >
                    {m === 'api' ? t(lang, 'modeApi') : t(lang, 'modeManual')}
                 </button>
               ))}
           </div>
        </Section>

        {/* Prompt Section */}
        {!isManualMode && (
          <Section title={t(lang, 'promptTitle')} isOpen={sectionsState.prompt} onToggle={() => toggleSection('prompt')}>
             <div className="space-y-3">
               <div>
                  <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'promptGlobalLabel')}</label>
                  <textarea 
                    value={config.prompt}
                    onChange={(e) => handleConfigChange('prompt', e.target.value)}
                    className="w-full h-20 p-2 text-xs border border-skin-border rounded-md bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none"
                    placeholder={t(lang, 'promptPlaceholder')}
                  />
               </div>
               
               {currentImage && (
                 <div className="pt-2 border-t border-skin-border border-dashed">
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block flex items-center gap-2">
                       {t(lang, 'promptSpecificLabel')}
                       <span className="px-1.5 py-0.5 rounded-full bg-skin-fill text-skin-text font-normal normal-case truncate max-w-[100px]">
                          {currentImage.file.name}
                       </span>
                    </label>
                    <textarea 
                      value={currentImage.customPrompt || ''}
                      onChange={(e) => onUpdateImagePrompt(currentImage.id, e.target.value)}
                      className="w-full h-16 p-2 text-xs border border-skin-border rounded-md bg-skin-surface focus:ring-1 focus:ring-skin-primary focus:border-skin-primary transition-all resize-none"
                      placeholder={t(lang, 'promptSpecificPlaceholder')}
                    />
                 </div>
               )}
             </div>
          </Section>
        )}

        {/* Settings */}
        {!isManualMode && (
          <Section title={t(lang, 'settingsTitle')} isOpen={sectionsState.settings} onToggle={() => toggleSection('settings')}>
              <div className="space-y-3">
                 <div>
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'provider')}</label>
                    <select 
                      value={config.provider}
                      onChange={(e) => handleConfigChange('provider', e.target.value)}
                      className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                    >
                       <option value="openai">OpenAI Compatible (ChatGPT, Claude, etc)</option>
                       <option value="gemini">Google Gemini</option>
                    </select>
                 </div>
                 
                 {config.provider === 'openai' && (
                    <>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'baseUrl')}</label>
                        <input 
                          type="text" 
                          value={config.openaiBaseUrl}
                          onChange={(e) => handleConfigChange('openaiBaseUrl', e.target.value)}
                          className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'apiKey')}</label>
                        <input 
                          type="password" 
                          value={config.openaiApiKey}
                          onChange={(e) => handleConfigChange('openaiApiKey', e.target.value)}
                          className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                        />
                      </div>
                      <div>
                         <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'model')}</label>
                         <div className="flex gap-2">
                             <input 
                               type="text" 
                               value={config.openaiModel}
                               onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                               className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                               placeholder={t(lang, 'modelIdPlaceholder')}
                               list="openai-models"
                             />
                             <datalist id="openai-models">
                               {modelList.map(m => <option key={m} value={m} />)}
                             </datalist>
                             <button 
                               onClick={handleFetchOpenAIModels}
                               disabled={isLoadingModels}
                               className="px-2 py-1 bg-skin-fill border border-skin-border rounded text-xs hover:bg-skin-border"
                             >
                               {isLoadingModels ? '...' : '↻'}
                             </button>
                         </div>
                      </div>
                    </>
                 )}

                 {config.provider === 'gemini' && (
                    <>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'apiKey')}</label>
                        <input 
                          type="password" 
                          value={config.geminiApiKey}
                          disabled={true}
                          title="API Key is managed via environment variable"
                          className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface opacity-60 cursor-not-allowed"
                          placeholder="Using process.env.API_KEY"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'model')}</label>
                        <input 
                           type="text" 
                           value={config.geminiModel}
                           onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                           className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                        />
                      </div>
                    </>
                 )}
              </div>
          </Section>
        )}
        
        {/* Execution Settings */}
        {!isManualMode && (
          <Section title={t(lang, 'executionTitle')} isOpen={sectionsState.execution} onToggle={() => toggleSection('execution')}>
              <div className="space-y-3">
                 <div>
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'mode')}</label>
                    <div className="flex bg-skin-fill p-1 rounded border border-skin-border">
                       <button 
                         onClick={() => handleConfigChange('executionMode', 'concurrent')}
                         className={`flex-1 py-1 text-[10px] rounded transition-all ${config.executionMode === 'concurrent' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted'}`}
                       >
                         {t(lang, 'modeConcurrent')}
                       </button>
                       <button 
                         onClick={() => handleConfigChange('executionMode', 'serial')}
                         className={`flex-1 py-1 text-[10px] rounded transition-all ${config.executionMode === 'serial' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted'}`}
                       >
                         {t(lang, 'modeSerial')}
                       </button>
                    </div>
                 </div>
                 
                 {config.executionMode === 'concurrent' && (
                    <div>
                       <div className="flex justify-between">
                         <label className="text-[10px] uppercase font-bold text-skin-muted block">{t(lang, 'concurrency')}</label>
                         <span className="text-[10px] font-mono">{config.concurrencyLimit}</span>
                       </div>
                       <input 
                         type="number" min="1" step="1"
                         value={config.concurrencyLimit}
                         onChange={(e) => handleConfigChange('concurrencyLimit', Math.max(1, Number(e.target.value)))}
                         className="w-full p-1.5 text-xs border border-skin-border rounded bg-skin-surface"
                       />
                    </div>
                 )}
                 
                 <div className="flex gap-2">
                     <div className="flex-1">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'timeoutLabel')}</label>
                        <input 
                          type="number" value={config.apiTimeout / 1000}
                          onChange={(e) => handleConfigChange('apiTimeout', Number(e.target.value) * 1000)}
                          className="w-full p-1 text-xs border border-skin-border rounded bg-skin-surface"
                        />
                     </div>
                     <div className="flex-1">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'retriesLabel')}</label>
                        <input 
                          type="number" value={config.maxRetries}
                          onChange={(e) => handleConfigChange('maxRetries', Number(e.target.value))}
                          className="w-full p-1 text-xs border border-skin-border rounded bg-skin-surface"
                        />
                     </div>
                 </div>
                 
                 <div className="pt-2 border-t border-skin-border/50">
                    <label className="flex items-start gap-2 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={config.processFullImageIfNoRegions}
                          onChange={(e) => handleConfigChange('processFullImageIfNoRegions', e.target.checked)}
                          className="mt-0.5"
                        />
                        <div>
                           <span className="block text-xs font-medium text-skin-text group-hover:text-skin-primary transition-colors">{t(lang, 'processFullImage')}</span>
                           <span className="block text-[10px] text-skin-muted leading-tight mt-0.5">{t(lang, 'processFullImageDesc')}</span>
                        </div>
                    </label>
                 </div>
              </div>
          </Section>
        )}

        {/* Manual Patch Workbench */}
        {isManualMode && currentImage && (
           <Section title={t(lang, 'workbenchTitle')} isOpen={sectionsState.manual} onToggle={() => toggleSection('manual')}>
              {currentImage.regions.length === 0 ? (
                 <div className="text-center py-4 text-xs text-skin-muted">{t(lang, 'noRegions')}</div>
              ) : (
                 <div className="space-y-3">
                     {currentImage.regions.map(region => (
                        <ManualPatchRow 
                           key={region.id}
                           region={region}
                           image={currentImage}
                           onPatchUpdate={(base64) => onManualPatchUpdate(currentImage.id, region.id, base64)}
                           lang={lang}
                           onOpenEditor={() => onOpenEditor(currentImage.id, region.id)}
                        />
                     ))}
                 </div>
              )}
              <button 
                 onClick={() => onOpenEditor(currentImage.id, 'manual-full-image')}
                 className="w-full py-2 mt-2 bg-skin-surface border border-dashed border-skin-primary/50 text-skin-primary rounded text-xs hover:bg-skin-fill transition-colors"
              >
                  + Edit Full Image
              </button>
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
             <button 
                onClick={() => onProcess(processAll)}
                disabled={!!getDisabledReason()}
                className="w-full py-3 bg-skin-primary hover:bg-opacity-90 disabled:bg-skin-muted disabled:cursor-not-allowed text-skin-primary-fg font-bold rounded-lg shadow-lg shadow-skin-primary/20 transition-all active:scale-95 flex items-center justify-center gap-2"
                title={getDisabledReason()}
             >
                {t(lang, processAll ? 'generateAll' : 'generate')}
             </button>
             
             <label className="flex items-center justify-center gap-2 cursor-pointer select-none">
                <input 
                  type="checkbox" 
                  checked={processAll} 
                  onChange={(e) => setProcessAll(e.target.checked)} 
                  className="rounded border-skin-border text-skin-primary focus:ring-skin-primary"
                />
                <span className="text-xs text-skin-muted">{t(lang, 'applyAll', { count: images.length })}</span>
             </label>

             {currentImage?.finalResultUrl && (
                 <button 
                   onClick={onDownload}
                   className="w-full py-2 border border-skin-border text-skin-text bg-skin-fill hover:bg-skin-surface font-medium rounded-lg text-xs transition-colors"
                 >
                    {t(lang, 'downloadResult')}
                 </button>
             )}
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
      
      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-skin-surface max-w-lg w-full max-h-[80vh] rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
              <div className="p-4 border-b border-skin-border flex justify-between items-center">
                 <h3 className="font-bold text-lg">{t(lang, 'guideTitle')}</h3>
                 <button onClick={() => setShowHelp(false)} className="p-1 hover:bg-skin-fill rounded">✕</button>
              </div>
              <div className="p-6 overflow-y-auto space-y-6 text-sm text-skin-text">
                  <section>
                      <h4 className="font-bold text-skin-primary mb-2 border-b border-skin-border/50 pb-1">{t(lang, 'guide_sec_basics')}</h4>
                      <ol className="list-decimal list-inside space-y-2 text-skin-muted">
                          <li><strong className="text-skin-text">{t(lang, 'guide_step_upload')}</strong>: {t(lang, 'guide_step_upload_desc')}</li>
                          <li><strong className="text-skin-text">{t(lang, 'guide_step_region')}</strong>: {t(lang, 'guide_step_region_desc')}</li>
                          <li><strong className="text-skin-text">{t(lang, 'guide_step_config')}</strong>: {t(lang, 'guide_step_config_desc')}</li>
                          <li><strong className="text-skin-text">{t(lang, 'guide_step_run')}</strong>: {t(lang, 'guide_step_run_desc')}</li>
                      </ol>
                  </section>
                  <section>
                      <h4 className="font-bold text-skin-primary mb-2 border-b border-skin-border/50 pb-1">{t(lang, 'guide_sec_advanced')}</h4>
                      <div className="space-y-3">
                         <div className="bg-skin-fill/50 p-3 rounded-lg">
                            <h5 className="font-bold text-xs mb-1">{t(lang, 'guide_tip_batch_title')}</h5>
                            <p className="text-xs text-skin-muted">{t(lang, 'guide_tip_batch_desc')}</p>
                         </div>
                         <div className="bg-skin-fill/50 p-3 rounded-lg">
                            <h5 className="font-bold text-xs mb-1">{t(lang, 'guide_tip_manual_title')}</h5>
                            <p className="text-xs text-skin-muted">{t(lang, 'guide_tip_manual_desc')}</p>
                         </div>
                         <div className="bg-skin-fill/50 p-3 rounded-lg">
                            <h5 className="font-bold text-xs mb-1">{t(lang, 'guide_tip_timeout_title')}</h5>
                            <p className="text-xs text-skin-muted">{t(lang, 'guide_tip_timeout_desc')}</p>
                         </div>
                      </div>
                  </section>
              </div>
              <div className="p-4 border-t border-skin-border bg-skin-fill/30">
                  <button onClick={() => setShowHelp(false)} className="w-full py-2 bg-skin-primary text-skin-primary-fg rounded-lg font-bold">
                     {t(lang, 'close')}
                  </button>
              </div>
           </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
