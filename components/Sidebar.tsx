import React, { useState } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, ThemeType } from '../types';
import { fetchOpenAIModels } from '../services/aiService';
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
  onDownload
}) => {
  const [modelList, setModelList] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [processAll, setProcessAll] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  // Collapse States
  const [sectionsState, setSectionsState] = useState({
    gallery: true,
    prompt: true,
    settings: false, 
    execution: false 
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

  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;
  const canProcess = images.length > 0 && hasValidKey && (processAll ? images.some(i => i.regions.length > 0) : currentImage?.regions.length);

  // Status text for the footer
  const statusKey = processingState.toLowerCase() as any;
  const processingText = isProcessing ? t(lang, statusKey) : '';

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
              className="text-[10px] font-bold text-skin-muted hover:text-skin-primary border border-skin-border px-2 py-1 rounded hover:bg-skin-fill transition-colors"
            >
              {config.language === 'zh' ? 'EN' : '中文'}
            </button>
          </div>

          {/* High-End Theme Selector */}
          <div className="flex items-center justify-between bg-skin-fill px-2 py-1.5 rounded-full border border-skin-border">
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
            
            {/* Upload Section - Always visible */}
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col items-center justify-center py-4 bg-skin-surface border border-skin-border rounded-xl cursor-pointer hover:border-skin-primary hover:shadow-md transition-all group">
                <svg className="w-6 h-6 text-skin-muted group-hover:text-skin-primary mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                <span className="text-[10px] font-bold text-skin-muted group-hover:text-skin-text">{t(lang, 'uploadFiles')}</span>
                <input type="file" className="hidden" multiple accept="image/*" onChange={onUpload} disabled={isProcessing} />
              </label>

              <label className="flex flex-col items-center justify-center py-4 bg-skin-surface border border-skin-border rounded-xl cursor-pointer hover:border-skin-primary hover:shadow-md transition-all group">
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
                  {processedImagesCount > 1 && (
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleDownloadAllZip(); }}
                      disabled={isZipping}
                      className="text-[10px] text-skin-primary font-medium hover:underline disabled:opacity-50 flex items-center gap-1 bg-skin-primary-light px-2 py-0.5 rounded-full"
                    >
                        {isZipping ? t(lang, 'zipping') : t(lang, 'downloadZip')}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                  {images.map((img) => (
                    <div
                      key={img.id}
                      onClick={() => !isProcessing && onSelectImage(img.id)}
                      className={`relative group aspect-square rounded-lg overflow-hidden cursor-pointer border-2 transition-all ${
                        selectedImageId === img.id 
                          ? 'border-skin-primary ring-2 ring-skin-primary/20 shadow-md' 
                          : 'border-skin-fill hover:border-skin-border'
                      } ${isProcessing ? 'opacity-50' : ''}`}
                    >
                      <img src={img.previewUrl} alt="thumb" className="w-full h-full object-cover bg-skin-fill" />
                      
                      {img.regions.length > 0 && (
                        <div className="absolute top-0.5 right-0.5">
                            <span className="flex h-2 w-2">
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-skin-primary border border-skin-surface"></span>
                            </span>
                        </div>
                      )}
                      
                      {img.finalResultUrl && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-emerald-500"></div>
                      )}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Section: Prompt */}
            <Section title={t(lang, 'promptTitle')} isOpen={sectionsState.prompt} onToggle={() => toggleSection('prompt')}>
              <textarea
                  value={config.prompt}
                  onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
                  className="w-full bg-skin-fill border border-skin-border rounded-lg px-3 py-2 text-sm text-skin-text focus:outline-none focus:border-skin-primary focus:bg-skin-surface focus:ring-1 focus:ring-skin-primary/20 min-h-[80px] resize-y transition-all placeholder:text-skin-muted"
                  placeholder={t(lang, 'promptPlaceholder')}
                  disabled={isProcessing}
                />
            </Section>

            {/* Section: AI Configuration (Collapsed by default) */}
            <Section 
              title={t(lang, 'settingsTitle')} 
              isOpen={sectionsState.settings} 
              onToggle={() => toggleSection('settings')}
            >
              <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'provider')}</label>
                    <div className="relative">
                        <select 
                          value={config.provider}
                          onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                          className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary transition-colors cursor-pointer"
                          disabled={isProcessing}
                        >
                          <option value="openai">OpenAI Compatible</option>
                          <option value="gemini">Google Gemini</option>
                        </select>
                    </div>
                  </div>

                  {/* Dynamic Fields based on Provider */}
                  {config.provider === 'openai' ? (
                    <>
                      <div className="space-y-1">
                        <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'baseUrl')}</label>
                        <input
                          type="text"
                          value={config.openaiBaseUrl}
                          onChange={(e) => handleConfigChange('openaiBaseUrl', e.target.value)}
                          className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary transition-colors"
                          placeholder="https://api.openai.com/v1"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'apiKey')}</label>
                        <input
                          type="password"
                          value={config.openaiApiKey}
                          onChange={(e) => handleConfigChange('openaiApiKey', e.target.value)}
                          className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary transition-colors"
                          placeholder="sk-..."
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="flex justify-between items-center px-1">
                          <label className="text-[10px] text-skin-muted font-bold uppercase">{t(lang, 'model')}</label>
                          <button 
                            onClick={handleFetchOpenAIModels}
                            disabled={isLoadingModels}
                            className="text-[9px] text-skin-primary font-medium hover:underline disabled:text-skin-muted transition-colors"
                          >
                            {isLoadingModels ? t(lang, 'fetching') : t(lang, 'fetchList')}
                          </button>
                        </div>
                        {modelList.length > 0 ? (
                            <select
                            value={config.openaiModel}
                            onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                            className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary"
                          >
                            {modelList.map(m => <option key={m} value={m}>{m}</option>)}
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={config.openaiModel}
                            onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                            className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary"
                            placeholder="gpt-4o"
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
                          className="w-full bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text placeholder-skin-muted focus:outline-none focus:border-skin-primary"
                          placeholder="AIza..."
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'model')}</label>
                        <select
                            value={config.geminiModel}
                            onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                            className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-skin-primary"
                          >
                            <option value="gemini-2.5-flash-image">gemini-2.5-flash-image</option>
                            <option value="gemini-3-pro-image-preview">gemini-3-pro-image-preview</option>
                            <option value="custom">{t(lang, 'customModel')}</option>
                          </select>
                        {config.geminiModel === 'custom' && (
                          <input
                            type="text"
                            className="w-full mt-2 bg-skin-fill border border-skin-border rounded-md px-3 py-2 text-xs text-skin-text focus:outline-none focus:border-skin-primary"
                            placeholder={t(lang, 'modelIdPlaceholder')}
                            onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                          />
                        )}
                      </div>
                    </>
                  )}
              </div>
            </Section>

            {/* Section: Execution Options (Collapsed by default) */}
            <Section title={t(lang, 'executionTitle')} isOpen={sectionsState.execution} onToggle={() => toggleSection('execution')}>
              <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                      <label className="text-[10px] text-skin-muted font-bold ml-1 uppercase">{t(lang, 'mode')}</label>
                      <select
                        value={config.executionMode}
                        onChange={(e) => handleConfigChange('executionMode', e.target.value)}
                        className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-2 py-2 focus:outline-none focus:border-skin-primary"
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
                          className="w-full bg-skin-fill text-xs text-skin-text border border-skin-border rounded-md px-2 py-2 focus:outline-none focus:border-skin-primary"
                          disabled={isProcessing}
                        />
                    </div>
                  )}
                </div>
            </Section>

            {/* Mini Results Preview */}
            {currentImage && currentImage.regions.some(r => r.processedImageBase64) && (
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

              <button
                onClick={() => onProcess(processAll)}
                disabled={!canProcess}
                className="w-full py-3 bg-skin-primary hover:opacity-90 disabled:bg-skin-border disabled:text-skin-muted text-skin-primary-fg rounded-xl font-semibold text-sm transition-all shadow-md shadow-skin-primary/30 active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                {processAll ? t(lang, 'generateAll') : t(lang, 'generate')}
              </button>
              
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