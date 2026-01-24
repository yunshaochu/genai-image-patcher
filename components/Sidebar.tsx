
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
  processingState: ProcessingStep;
  currentImage?: UploadedImage;
  onDownload: () => void;
  onManualPatchUpdate: (imageId: string, regionId: string, base64: string) => void;
  onUpdateImagePrompt: (imageId: string, prompt: string) => void;
  onDeleteImage: (imageId: string) => void;
}

// Collapsible Section Component
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

// Component for a single Manual Patch Row
const ManualPatchRow: React.FC<{
  region: Region;
  image: UploadedImage;
  onPatchUpdate: (base64: string) => void;
  lang: 'zh' | 'en';
}> = ({ region, image, onPatchUpdate, lang }) => {
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
    // CRITICAL: Stop propagation so App.tsx global listener doesn't trigger file upload
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
    <div className="flex items-stretch gap-2 bg-skin-fill/30 p-2 rounded-lg border border-skin-border">
      {/* Source Side */}
      <div className="flex-1 flex flex-col gap-1 items-center">
         <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'sourceCrop')}</span>
         <div className="w-16 h-16 bg-checkerboard rounded border border-skin-border overflow-hidden relative group">
            {sourceCrop ? (
              <img src={sourceCrop} className="w-full h-full object-contain" />
            ) : (
              <div className="w-full h-full animate-pulse bg-skin-fill"></div>
            )}
         </div>
         <button 
           onClick={handleCopy}
           disabled={!sourceCrop}
           className="text-[9px] px-2 py-0.5 bg-skin-surface border border-skin-border rounded hover:bg-skin-fill transition-colors w-full text-center"
         >
           {copied ? t(lang, 'copied') : t(lang, 'copyCrop')}
         </button>
      </div>

      <div className="flex items-center text-skin-muted">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path></svg>
      </div>

      {/* Target Side */}
      <div 
        className="flex-1 flex flex-col gap-1 items-center"
      >
         <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'patchZone')}</span>
         <div 
           className={`w-16 h-16 bg-skin-surface rounded border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer outline-none transition-all ${
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
         </div>
         <div className={`text-[9px] font-bold ${region.status === 'completed' ? 'text-emerald-500' : 'text-skin-muted'}`}>
            {region.status === 'completed' ? t(lang, 'status_completed') : t(lang, 'status_pending')}
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
  processingState,
  currentImage,
  onDownload,
  onManualPatchUpdate,
  onUpdateImagePrompt,
  onDeleteImage
}) => {
  const [modelList, setModelList] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [processAll, setProcessAll] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  // Collapse States
  const [sectionsState, setSectionsState] = useState({
    gallery: true,
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
  const processedImagesCount = images.filter(img => img.finalResultUrl).length;
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
    const processedImages = images.filter(img => img.finalResultUrl);
    if (processedImages.length === 0) return;

    setIsZipping(true);
    try {
      const zip = new JSZip();
      const folder = zip.folder("patched_results");

      const promises = processedImages.map(async (img, index) => {
        if (!img.finalResultUrl) return;
        
        // Fetch blob from blob URL or Data URL
        const response = await fetch(img.finalResultUrl);
        const blob = await response.blob();
        
        // Create clean filename
        const originalName = img.file.name.substring(0, img.file.name.lastIndexOf('.')) || img.file.name;
        const ext = img.file.name.split('.').pop() || 'png';
        const filename = `${originalName}_patched.${ext}`;
        
        folder?.file(filename, blob);
      });

      await Promise.all(promises);
      
      const content = await zip.generateAsync({ type: "blob" });
      
      // Trigger download
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

  // --- PROCESSING PERMISSION LOGIC ---
  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;
  
  const targetImageExists = processAll ? images.length > 0 : !!currentImage;
  
  const hasRegions = processAll 
    ? images.some(i => i.regions.length > 0) 
    : (currentImage?.regions.length || 0) > 0;
  
  const canProceedWithEmptyRegions = config.processFullImageIfNoRegions === true;

  const canProcessApi = 
    targetImageExists && 
    hasValidKey && 
    (hasRegions || canProceedWithEmptyRegions);
    
  const getDisabledReason = () => {
      if (!targetImageExists) return "No image selected";
      if (!hasValidKey) return "Missing API Key (Check Settings)";
      if (!hasRegions && !canProceedWithEmptyRegions) return "No regions selected";
      return "";
  };

  const isManualMode = config.processingMode === 'manual';

  const statusKey = processingState.toLowerCase() as any;
  const processingText = isProcessing ? t(lang, statusKey) : '';

  // Dummy region for Full Image Mode (Manual)
  const fullImageDummyRegion: Region = {
    id: 'manual-full-image',
    x: 0, y: 0, width: 100, height: 100,
    type: 'rect',
    status: 'pending'
  };

  return (
    <>
      <div className="w-80 h-full bg-skin-surface border-r border-skin-border flex flex-col shadow-xl z-20 transition-colors duration-300">
        {/* Brand Header & Theme Switcher */}
        <div className="p-5 border-b border-skin-border flex flex-col gap-4 bg-skin-surface">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-skin-primary flex items-center justify-center shadow-lg shadow-skin-primary/30">
                    <svg className="w-5 h-5 text-skin-primary-fg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </div>
                <div>
                    <h1 className="text-base font-bold text-skin-text tracking-tight">{t(lang, 'appTitle')}</h1>
                    <p className="text-[10px] text-skin-muted font-semibold uppercase tracking-wider">{t(lang, 'appSubtitle')}</p>
                </div>
            </div>
            {/* Language Toggle */}
            <button 
              onClick={() => handleConfigChange('language', config.language === 'zh' ? 'en' : 'zh')}
              disabled={isProcessing}
              className="text-[10px] font-bold text-skin-muted hover:text-skin-primary border border-skin-border px-2 py-1 rounded hover:bg-skin-fill transition-colors disabled:opacity-50"
            >
              {config.language === 'zh' ? 'EN' : '中文'}
            </button>
          </div>

          {/* High-End Theme Selector */}
          <div className={`flex items-center justify-between bg-skin-fill px-2 py-1.5 rounded-full border border-skin-border ${isProcessing ? 'pointer-events-none opacity-50' : ''}`}>
              {THEMES.map((theme) => (
                  <button
                      key={theme.id}
                      onClick={() => handleConfigChange('theme', theme.id)}
                      title={theme.label}
                      className={`w-4 h-4 rounded-full transition-all duration-300 ${theme.bg} ${
                          config.theme === theme.id 
                              ? `ring-2 ${theme.ring} scale-125 shadow-sm` 
                              : 'opacity-50 hover:opacity-100 hover:scale-110'
                      }`}
                  />
              ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar bg-skin-fill/30">
          <div className="p-4 space-y-6">
            
            {/* Upload Section */}
            <div className="grid grid-cols-2 gap-3">
              <label className={`flex flex-col items-center justify-center py-4 bg-skin-surface border border-skin-border rounded-xl cursor-pointer hover:border-skin-primary hover:shadow-md transition-all group ${isProcessing ? 'pointer-events-none opacity-50' : ''}`}>
                <svg className="w-6 h-6 text-skin-muted group-hover:text-skin-primary mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                <span className="text-[10px] font-bold text-skin-muted group-hover:text-skin-text">{t(lang, 'uploadFiles')}</span>
                <input type="file" className="hidden" multiple accept="image/*" onChange={onUpload} disabled={isProcessing} />
              </label>

              <label className={`flex flex-col items-center justify-center py-4 bg-skin-surface border border-skin-border rounded-xl cursor-pointer hover:border-skin-primary hover:shadow-md transition-all group ${isProcessing ? 'pointer-events-none opacity-50' : ''}`}>
                <svg className="w-6 h-6 text-skin-muted group-hover:text-skin-primary mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                <span className="text-[10px] font-bold text-skin-muted group-hover:text-skin-text">{t(lang, 'uploadFolder')}</span>
                <input type="file" className="hidden" multiple accept="image/*" {...{ webkitdirectory: "", directory: "" } as any} onChange={onUpload} disabled={isProcessing} />
              </label>
            </div>

            {/* Section: Gallery */}
            {images.length > 0 && (
              <Section 
                title={`${t(lang, 'galleryTitle')} (${images.length})`} 
                isOpen={sectionsState.gallery} 
                onToggle={() => toggleSection('gallery')}
              >
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] text-skin-muted">{t(lang, 'selectToEdit')}</span>
                  {/* CHANGED: Show button if ANY image is processed (>0) */}
                  {processedImagesCount > 0 && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleDownloadAllZip(); }}
                      disabled={isZipping || isProcessing}
                      className="text-[10px] text-skin-primary font-medium hover:underline disabled:opacity-50 flex items-center gap-1 bg-skin-primary-light px-2 py-0.5 rounded-full"
                    >
                        {isZipping ? t(lang, 'zipping') : t(lang, 'downloadZip')}
                    </button>
                  )}
                </div>
                {/* BLOCKED INTERACTION DURING PROCESSING */}
                <div className={`grid grid-cols-4 gap-2 max-h-48 overflow-y-auto custom-scrollbar pr-1 ${isProcessing ? 'pointer-events-none opacity-50' : ''}`}>
                  {images.map((img) => (
                    <div
                      key={img.id}
                      onClick={() => onSelectImage(img.id)}
                      className={`relative group aspect-square rounded-lg overflow-hidden cursor-pointer border-2 transition-all ${
                        selectedImageId === img.id 
                          ? 'border-skin-primary ring-2 ring-skin-primary/20 shadow-md' 
                          : 'border-skin-fill hover:border-skin-border'
                      }`}
                    >
                      <img src={img.previewUrl} alt="thumb" className="w-full h-full object-cover bg-skin-fill" />
                      
                      {/* Delete Button */}
                      {!isProcessing && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteImage(img.id);
                          }}
                          className="absolute top-0.5 left-0.5 w-5 h-5 bg-black/40 hover:bg-rose-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all z-10 backdrop-blur-[1px]"
                          title={t(lang, 'deleteImage')}
                        >
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                      )}

                      <div className="absolute top-0.5 right-0.5 flex gap-0.5">
                        {img.regions.some(r => r.status === 'processing') && (
                           <span className="flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                            </span>
                        )}
                         {!img.regions.some(r => r.status === 'processing') && img.regions.length > 0 && (
                            <span className="flex h-2 w-2">
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-skin-primary border border-skin-surface"></span>
                            </span>
                         )}
                      </div>
                      
                      {img.finalResultUrl && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-emerald-500"></div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Workflow Mode Selector */}
            <Section title={t(lang, 'modeTitle')} isOpen={sectionsState.workflow} onToggle={() => toggleSection('workflow')}>
              <div className="flex rounded-lg border border-skin-border overflow-hidden bg-skin-fill">
                <button
                  onClick={() => handleConfigChange('processingMode', 'api')}
                  disabled={isProcessing}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    config.processingMode === 'api' 
                      ? 'bg-skin-primary text-skin-primary-fg' 
                      : 'text-skin-muted hover:bg-skin-fill/50'
                  }`}
                >
                  {t(lang, 'modeApi')}
                </button>
                <div className="w-px bg-skin-border"></div>
                <button
                  onClick={() => handleConfigChange('processingMode', 'manual')}
                  disabled={isProcessing}
                  className={`flex-1 py-2 text-xs font-medium transition-colors ${
                    config.processingMode === 'manual' 
                      ? 'bg-skin-primary text-skin-primary-fg' 
                      : 'text-skin-muted hover:bg-skin-fill/50'
                  }`}
                >
                  {t(lang, 'modeManual')}
                </button>
              </div>
            </Section>

            {/* API Workflow Sections */}
            {!isManualMode && (
              <>
                {/* Section: Prompt */}
                <Section title={t(lang, 'promptTitle')} isOpen={sectionsState.prompt} onToggle={() => toggleSection('prompt')}>
                  <div className="space-y-3">
                    {/* Global Prompt */}
                    <div className="space-y-1">
                      {currentImage && (
                        <div className="flex items-center gap-1.5 px-1">
                          <svg className="w-3 h-3 text-skin-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                          <label className="text-[10px] font-bold text-skin-muted uppercase tracking-wider">{t(lang, 'promptGlobalLabel')}</label>
                        </div>
                      )}
                      <textarea
                        value={config.prompt}
                        onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
                        className="w-full bg-skin-fill border border-skin-border rounded-lg px-3 py-2 text-sm text-skin-text focus:outline-none focus:border-skin-primary focus:bg-skin-surface focus:ring-1 focus:ring-skin-primary/20 min-h-[60px] resize-y transition-all placeholder:text-skin-muted disabled:opacity-50"
                        placeholder={t(lang, 'promptPlaceholder')}
                        disabled={isProcessing}
                      />
                    </div>

                    {/* Specific Prompt for Current Image */}
                    {currentImage && (
                      <div className="space-y-1 pt-2 border-t border-skin-border/50 animate-in fade-in slide-in-from-top-2">
                        <div className="flex items-center justify-between px-1">
                          <div className="flex items-center gap-1.5">
                            <svg className="w-3 h-3 text-skin-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                            <label className="text-[10px] font-bold text-skin-primary uppercase tracking-wider truncate max-w-[150px]" title={currentImage.file.name}>
                              {currentImage.file.name}
                            </label>
                          </div>
                          {currentImage.customPrompt && (
                             <button onClick={() => onUpdateImagePrompt(currentImage.id, '')} className="text-[9px] text-skin-muted hover:text-rose-500">Clear</button>
                          )}
                        </div>
                        <textarea
                          value={currentImage.customPrompt || ''}
                          onChange={(e) => onUpdateImagePrompt(currentImage.id, e.target.value)}
                          className="w-full bg-skin-surface/50 border border-skin-border/80 border-dashed focus:border-solid rounded-lg px-3 py-2 text-sm text-skin-text focus:outline-none focus:border-skin-primary focus:bg-skin-surface focus:ring-1 focus:ring-skin-primary/20 min-h-[60px] resize-y transition-all placeholder:text-skin-muted/70 disabled:opacity-50"
                          placeholder={t(lang, 'promptSpecificPlaceholder')}
                          disabled={isProcessing}
                        />
                      </div>
                    )}
                  </div>
                </Section>

                {/* Section: AI Configuration */}
                <Section 
                  title={t(lang, 'settingsTitle')} 
                  isOpen={sectionsState.settings} 
                  onToggle={() => toggleSection('settings')}
                >
                  <div className="space-y-4">
                      {/* ... Provider & Key Inputs ... */}
                      <div className="space-y-1">
                        <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'provider')}</label>
                        <div className="relative">
                            <select 
                              value={config.provider}
                              onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                              className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary transition-colors cursor-pointer disabled:opacity-50"
                              disabled={isProcessing}
                            >
                              <option value="openai">OpenAI Compatible</option>
                              <option value="gemini">Google Gemini</option>
                            </select>
                        </div>
                      </div>

                      {config.provider === 'openai' ? (
                        <>
                          <div className="space-y-1">
                            <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'baseUrl')}</label>
                            <input
                              type="text"
                              value={config.openaiBaseUrl}
                              onChange={(e) => handleConfigChange('openaiBaseUrl', e.target.value)}
                              className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary transition-colors disabled:opacity-50"
                              placeholder="https://api.openai.com/v1"
                              disabled={isProcessing}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'apiKey')}</label>
                            <input
                              type="password"
                              value={config.openaiApiKey}
                              onChange={(e) => handleConfigChange('openaiApiKey', e.target.value)}
                              className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary transition-colors disabled:opacity-50"
                              placeholder="sk-..."
                              disabled={isProcessing}
                            />
                          </div>
                          <div className="space-y-1">
                            <div className="flex justify-between items-center px-1">
                              <label className="text-[10px] text-skin-muted font-bold uppercase">{t(lang, 'model')}</label>
                              <button 
                                onClick={handleFetchOpenAIModels}
                                disabled={isLoadingModels || isProcessing}
                                className="text-[9px] text-skin-primary font-medium hover:underline disabled:text-skin-muted transition-colors"
                              >
                                {isLoadingModels ? t(lang, 'fetching') : t(lang, 'fetchList')}
                              </button>
                            </div>
                            {modelList.length > 0 ? (
                                <select
                                value={config.openaiModel}
                                onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                                className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary disabled:opacity-50"
                                disabled={isProcessing}
                              >
                                {modelList.map(m => <option key={m} value={m}>{m}</option>)}
                              </select>
                            ) : (
                              <input
                                type="text"
                                value={config.openaiModel}
                                onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                                className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary disabled:opacity-50"
                                placeholder="gpt-4o"
                                disabled={isProcessing}
                              />
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="space-y-1">
                            <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'apiKey')}</label>
                            <input
                              type="password"
                              value={config.geminiApiKey}
                              onChange={(e) => handleConfigChange('geminiApiKey', e.target.value)}
                              className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary disabled:opacity-50"
                              placeholder="AIza..."
                              disabled={isProcessing}
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'model')}</label>
                            <select
                                value={config.geminiModel}
                                onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                                className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary disabled:opacity-50"
                                disabled={isProcessing}
                              >
                                <option value="gemini-2.5-flash-image">gemini-2.5-flash-image</option>
                                <option value="gemini-3-pro-image-preview">gemini-3-pro-image-preview</option>
                                <option value="custom">{t(lang, 'customModel')}</option>
                              </select>
                            {config.geminiModel === 'custom' && (
                              <input
                                type="text"
                                className="w-full mt-2 bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text focus:outline-none focus:border-skin-primary disabled:opacity-50"
                                placeholder={t(lang, 'modelIdPlaceholder')}
                                onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                                disabled={isProcessing}
                              />
                            )}
                          </div>
                        </>
                      )}
                  </div>
                </Section>
                
                {/* Section: Execution Options */}
                <Section title={t(lang, 'executionTitle')} isOpen={sectionsState.execution} onToggle={() => toggleSection('execution')}>
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-1">
                            <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'mode')}</label>
                            <select
                              value={config.executionMode}
                              onChange={(e) => handleConfigChange('executionMode', e.target.value)}
                              className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-2 py-2 focus:outline-none focus:border-skin-primary disabled:opacity-50"
                              disabled={isProcessing}
                            >
                              <option value="concurrent">{t(lang, 'modeConcurrent')}</option>
                              <option value="serial">{t(lang, 'modeSerial')}</option>
                            </select>
                        </div>
                        {config.executionMode === 'concurrent' && (
                          <div className="space-y-1">
                              <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'concurrency')}</label>
                              <input
                                type="number"
                                min="1"
                                max="50"
                                value={config.concurrencyLimit}
                                onChange={(e) => handleConfigChange('concurrencyLimit', parseInt(e.target.value) || 1)}
                                className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-2 py-2 focus:outline-none focus:border-skin-primary disabled:opacity-50"
                                disabled={isProcessing}
                              />
                          </div>
                        )}
                    </div>
                    
                    {/* Full Image Toggle */}
                    <div className="flex items-start gap-2 pt-2 border-t border-skin-border/50">
                      <div className="relative flex items-center pt-1">
                        <input
                          type="checkbox"
                          checked={config.processFullImageIfNoRegions}
                          onChange={(e) => handleConfigChange('processFullImageIfNoRegions', e.target.checked)}
                          className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-skin-muted bg-skin-fill checked:border-skin-primary checked:bg-skin-primary focus:outline-none transition-all"
                          disabled={isProcessing}
                        />
                        <svg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-[20%] w-3 h-3 text-skin-primary-fg opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
                      </div>
                      <div>
                        <span className="text-xs font-semibold text-skin-text block">{t(lang, 'processFullImage')}</span>
                        <p className="text-[10px] text-skin-muted leading-tight">{t(lang, 'processFullImageDesc')}</p>
                      </div>
                    </div>
                  </div>
                </Section>
              </>
            )}

            {/* Manual Workbench Section */}
            {isManualMode && (
              <Section 
                title={t(lang, 'workbenchTitle')} 
                isOpen={sectionsState.manual} 
                onToggle={() => toggleSection('manual')}
              >
                {(!currentImage || (currentImage.regions.length === 0 && !config.processFullImageIfNoRegions)) ? (
                  <div className="text-xs text-skin-muted text-center py-4 italic">
                    {t(lang, 'noRegions')}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {currentImage && currentImage.regions.map(r => (
                      <ManualPatchRow 
                        key={r.id} 
                        region={r} 
                        image={currentImage} 
                        onPatchUpdate={(base64) => onManualPatchUpdate(currentImage.id, r.id, base64)}
                        lang={lang}
                      />
                    ))}
                    {/* Render Full Image Manual Row if configured */}
                    {currentImage && config.processFullImageIfNoRegions && currentImage.regions.length === 0 && (
                       <ManualPatchRow 
                        key="manual-full-image"
                        region={fullImageDummyRegion}
                        image={currentImage}
                        onPatchUpdate={(base64) => onManualPatchUpdate(currentImage.id, fullImageDummyRegion.id, base64)}
                        lang={lang}
                      />
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* Mini Results Preview (Auto Mode Only) */}
            {!isManualMode && currentImage && currentImage.regions.some(r => r.processedImageBase64) && (
              <Section title={t(lang, 'previewTitle')} isOpen={true} onToggle={() => {}}>
                <div className="grid grid-cols-3 gap-2">
                  {currentImage.regions.map(region => (
                    region.processedImageBase64 ? (
                      <div key={region.id} className="relative aspect-square rounded-md overflow-hidden bg-skin-fill border border-skin-border shadow-sm">
                        <img src={region.processedImageBase64} className="w-full h-full object-contain" />
                      </div>
                    ) : null
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>

        {/* Footer / Actions */}
        <div className="p-4 border-t border-skin-border bg-skin-surface shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] relative">
           
           {/* Unobtrusive Guide Button */}
           <button 
             onClick={() => setShowHelp(true)}
             className="absolute top-2 right-2 text-skin-muted hover:text-skin-primary transition-colors"
             title={t(lang, 'guideTitle')}
           >
             <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
           </button>

          {isProcessing ? (
            <div className="flex flex-col items-center justify-center py-2 space-y-3">
              <div className="relative w-8 h-8">
                <div className="absolute inset-0 border-2 border-skin-primary-light rounded-full"></div>
                <div className="absolute inset-0 border-2 border-skin-primary border-t-transparent rounded-full animate-spin"></div>
              </div>
              <p className="text-xs text-skin-muted font-medium animate-pulse">{processingText}</p>
            </div>
          ) : (
            <div className="space-y-3 pt-4">
              {!isManualMode && (
                <>
                  <label className="flex items-center gap-2 px-1 cursor-pointer group select-none">
                    <div className="relative flex items-center">
                      <input 
                        type="checkbox" 
                        checked={processAll} 
                        onChange={(e) => setProcessAll(e.target.checked)}
                        className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-skin-muted bg-skin-fill checked:border-skin-primary checked:bg-skin-primary focus:outline-none transition-all"
                      />
                      <svg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 text-skin-primary-fg opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
                    </div>
                    <span className="text-xs font-medium text-skin-muted group-hover:text-skin-primary transition-colors">
                      {t(lang, 'applyAll', { count: images.length })}
                    </span>
                  </label>

                  {/* Wrapped button for proper tooltip behavior on disabled state */}
                  <div title={!canProcessApi ? getDisabledReason() : ''} className="w-full">
                    <button
                      onClick={() => onProcess(processAll)}
                      disabled={!canProcessApi}
                      className="w-full py-3 bg-skin-primary hover:opacity-90 disabled:bg-skin-border disabled:text-skin-muted text-skin-primary-fg rounded-xl font-semibold text-sm transition-all shadow-md shadow-skin-primary/30 active:scale-[0.98] flex items-center justify-center gap-2 pointer-events-auto"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                      {processAll ? t(lang, 'generateAll') : t(lang, 'generate')}
                    </button>
                  </div>
                  
                  {/* ADDED: Batch Download Button in Footer */}
                  {processedImagesCount > 1 && (
                      <button
                        onClick={handleDownloadAllZip}
                        disabled={isZipping}
                        className="w-full py-3 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-semibold text-sm transition-all shadow-md active:scale-[0.98] flex items-center justify-center gap-2"
                      >
                         <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                        {isZipping ? t(lang, 'zipping') : t(lang, 'downloadZip')} ({processedImagesCount})
                      </button>
                   )}
                </>
              )}
              
              {currentImage?.finalResultUrl && (
                <button
                  onClick={onDownload}
                  className="w-full py-3 bg-skin-surface hover:bg-skin-fill text-skin-text border border-skin-border rounded-xl font-medium text-sm transition-all shadow-sm hover:shadow active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  {t(lang, 'downloadResult')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      
      {/* Help Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200">
           <div className="bg-skin-surface border border-skin-border rounded-2xl shadow-2xl max-w-md w-full p-6 relative">
              <button 
                onClick={() => setShowHelp(false)}
                className="absolute top-4 right-4 text-skin-muted hover:text-skin-text"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
              
              <h2 className="text-xl font-bold text-skin-text mb-4 flex items-center gap-2">
                 <div className="w-8 h-8 rounded-lg bg-skin-primary flex items-center justify-center shadow-md">
                    <svg className="w-5 h-5 text-skin-primary-fg" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"></path></svg>
                 </div>
                 {t(lang, 'guideTitle')}
              </h2>
              
              <div className="space-y-3 text-sm text-skin-text">
                 <p className="flex gap-3"><span className="text-skin-primary font-bold">1.</span> {t(lang, 'guideStep1')}</p>
                 <p className="flex gap-3"><span className="text-skin-primary font-bold">2.</span> {t(lang, 'guideStep2')}</p>
                 <p className="flex gap-3"><span className="text-skin-primary font-bold">3.</span> {t(lang, 'guideStep3')}</p>
                 <p className="flex gap-3"><span className="text-skin-primary font-bold">4.</span> {t(lang, 'guideStep4')}</p>
                 <p className="flex gap-3"><span className="text-skin-primary font-bold">5.</span> {t(lang, 'guideStep5')}</p>
              </div>
              
              <div className="mt-6 pt-4 border-t border-skin-border">
                 <p className="text-xs text-skin-muted italic">{t(lang, 'guideTips')}</p>
              </div>
              
              <button 
                onClick={() => setShowHelp(false)}
                className="mt-6 w-full py-2 bg-skin-fill hover:bg-skin-border text-skin-text rounded-lg font-medium transition-colors text-sm"
              >
                {t(lang, 'close')}
              </button>
           </div>
        </div>
      )}
    </>
  );
};

export default Sidebar;
