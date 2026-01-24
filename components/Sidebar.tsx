import React, { useState } from 'react';
import { AppConfig, ProcessingStep, UploadedImage } from '../types';
import { fetchOpenAIModels } from '../services/aiService';
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
    <div className="border border-slate-200 rounded-lg overflow-hidden bg-white shadow-sm transition-shadow hover:shadow-md">
      <button 
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50/50 hover:bg-slate-50 transition-colors text-left"
      >
        <span className="text-xs font-semibold text-slate-700 uppercase tracking-wide">{title}</span>
        <svg 
          className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="p-4 border-t border-slate-100 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
};

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
  
  // Collapse States
  const [sectionsState, setSectionsState] = useState({
    gallery: true,
    prompt: true,
    settings: false, // Collapsed by default
    execution: false // Collapsed by default
  });

  const toggleSection = (key: keyof typeof sectionsState) => {
    setSectionsState(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const isProcessing = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE;
  const processedImagesCount = images.filter(img => img.finalResultUrl).length;

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

  return (
    <div className="w-80 h-full bg-white border-r border-slate-200 flex flex-col shadow-xl z-20">
      {/* Brand Header */}
      <div className="p-5 border-b border-slate-100 flex items-center gap-3 bg-white">
        <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
          <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
        </div>
        <div>
          <h1 className="text-base font-bold text-slate-800 tracking-tight">Patcher Pro</h1>
          <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">AI Image Editor</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar bg-slate-50/50">
        <div className="p-4 space-y-6">
          
          {/* Upload Section - Always visible */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col items-center justify-center py-4 bg-white border border-slate-200 rounded-xl cursor-pointer hover:border-indigo-400 hover:shadow-md transition-all group">
              <svg className="w-6 h-6 text-slate-400 group-hover:text-indigo-500 mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
              <span className="text-[10px] font-bold text-slate-500 group-hover:text-slate-700">Files</span>
              <input type="file" className="hidden" multiple accept="image/*" onChange={onUpload} disabled={isProcessing} />
            </label>

            <label className="flex flex-col items-center justify-center py-4 bg-white border border-slate-200 rounded-xl cursor-pointer hover:border-indigo-400 hover:shadow-md transition-all group">
              <svg className="w-6 h-6 text-slate-400 group-hover:text-indigo-500 mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
              <span className="text-[10px] font-bold text-slate-500 group-hover:text-slate-700">Folder</span>
              <input type="file" className="hidden" multiple accept="image/*" {...{ webkitdirectory: "", directory: "" } as any} onChange={onUpload} disabled={isProcessing} />
            </label>
          </div>

          {/* Section: Gallery */}
          {images.length > 0 && (
            <Section 
              title={`Gallery (${images.length})`} 
              isOpen={sectionsState.gallery} 
              onToggle={() => toggleSection('gallery')}
            >
              <div className="flex justify-between items-center mb-2">
                 <span className="text-[10px] text-slate-400">Select to edit</span>
                 {processedImagesCount > 1 && (
                   <button 
                     onClick={(e) => { e.stopPropagation(); handleDownloadAllZip(); }}
                     disabled={isZipping}
                     className="text-[10px] text-indigo-600 font-medium hover:text-indigo-700 disabled:opacity-50 flex items-center gap-1 bg-indigo-50 px-2 py-0.5 rounded-full"
                   >
                      {isZipping ? 'Zipping...' : 'Download Zip'}
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
                        ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md' 
                        : 'border-slate-100 hover:border-slate-300'
                    } ${isProcessing ? 'opacity-50' : ''}`}
                  >
                    <img src={img.previewUrl} alt="thumb" className="w-full h-full object-cover bg-slate-100" />
                    
                    {img.regions.length > 0 && (
                      <div className="absolute top-0.5 right-0.5">
                           <span className="flex h-2 w-2">
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500 border border-white"></span>
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
          <Section title="Prompt" isOpen={sectionsState.prompt} onToggle={() => toggleSection('prompt')}>
             <textarea
                value={config.prompt}
                onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-indigo-500 focus:bg-white focus:ring-1 focus:ring-indigo-500/20 min-h-[80px] resize-y transition-all placeholder:text-slate-400"
                placeholder="Describe the edit..."
                disabled={isProcessing}
              />
          </Section>

          {/* Section: AI Configuration (Collapsed by default) */}
          <Section 
            title="Connection Settings" 
            isOpen={sectionsState.settings} 
            onToggle={() => toggleSection('settings')}
          >
             <div className="space-y-4">
                <div className="space-y-1">
                   <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">Provider</label>
                   <div className="relative">
                      <select 
                        value={config.provider}
                        onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                        className="w-full bg-slate-50 text-xs text-slate-700 border border-slate-200 rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-indigo-500 transition-colors cursor-pointer"
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
                      <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">Base URL</label>
                      <input
                        type="text"
                        value={config.openaiBaseUrl}
                        onChange={(e) => handleConfigChange('openaiBaseUrl', e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors"
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">API Key</label>
                      <input
                        type="password"
                        value={config.openaiApiKey}
                        onChange={(e) => handleConfigChange('openaiApiKey', e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-indigo-500 transition-colors"
                        placeholder="sk-..."
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between items-center px-1">
                        <label className="text-[10px] text-slate-500 font-bold uppercase">Model</label>
                        <button 
                          onClick={handleFetchOpenAIModels}
                          disabled={isLoadingModels}
                          className="text-[9px] text-indigo-600 font-medium hover:text-indigo-800 disabled:text-slate-400 transition-colors"
                        >
                          {isLoadingModels ? 'Fetching...' : 'Fetch List'}
                        </button>
                      </div>
                      {modelList.length > 0 ? (
                          <select
                          value={config.openaiModel}
                          onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                          className="w-full bg-slate-50 text-xs text-slate-700 border border-slate-200 rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-indigo-500"
                        >
                          {modelList.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text"
                          value={config.openaiModel}
                          onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                          placeholder="gpt-4o"
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <>
                     <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">API Key</label>
                      <input
                        type="password"
                        value={config.geminiApiKey}
                        onChange={(e) => handleConfigChange('geminiApiKey', e.target.value)}
                        className="w-full bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 placeholder-slate-400 focus:outline-none focus:border-indigo-500"
                        placeholder="AIza..."
                      />
                    </div>
                    <div className="space-y-1">
                       <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">Model</label>
                       <select
                          value={config.geminiModel}
                          onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                          className="w-full bg-slate-50 text-xs text-slate-700 border border-slate-200 rounded-md px-3 py-2 appearance-none focus:outline-none focus:border-indigo-500"
                        >
                          <option value="gemini-2.5-flash-image">gemini-2.5-flash-image</option>
                          <option value="gemini-3-pro-image-preview">gemini-3-pro-image-preview</option>
                          <option value="custom">Custom...</option>
                        </select>
                       {config.geminiModel === 'custom' && (
                         <input
                           type="text"
                           className="w-full mt-2 bg-slate-50 border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-700 focus:outline-none focus:border-indigo-500"
                           placeholder="Model ID"
                           onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                         />
                       )}
                    </div>
                  </>
                )}
             </div>
          </Section>

          {/* Section: Execution Options (Collapsed by default) */}
          <Section title="Processing Options" isOpen={sectionsState.execution} onToggle={() => toggleSection('execution')}>
             <div className="grid grid-cols-2 gap-4">
                 <div className="space-y-1">
                    <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">Mode</label>
                    <select
                      value={config.executionMode}
                      onChange={(e) => handleConfigChange('executionMode', e.target.value)}
                      className="w-full bg-slate-50 text-xs text-slate-700 border border-slate-200 rounded-md px-2 py-2 focus:outline-none focus:border-indigo-500"
                      disabled={isProcessing}
                    >
                      <option value="concurrent">Concurrent</option>
                      <option value="serial">Serial</option>
                    </select>
                 </div>
                 {config.executionMode === 'concurrent' && (
                   <div className="space-y-1">
                      <label className="text-[10px] text-slate-500 font-bold ml-1 uppercase">Concurrency</label>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        value={config.concurrencyLimit}
                        onChange={(e) => handleConfigChange('concurrencyLimit', parseInt(e.target.value) || 1)}
                        className="w-full bg-slate-50 text-xs text-slate-700 border border-slate-200 rounded-md px-2 py-2 focus:outline-none focus:border-indigo-500"
                        disabled={isProcessing}
                      />
                   </div>
                 )}
              </div>
          </Section>

          {/* Mini Results Preview */}
          {currentImage && currentImage.regions.some(r => r.processedImageBase64) && (
            <Section title="Patch Previews" isOpen={true} onToggle={() => {}}>
              <div className="grid grid-cols-3 gap-2">
                {currentImage.regions.map(region => (
                  region.processedImageBase64 ? (
                    <div key={region.id} className="relative aspect-square rounded-md overflow-hidden bg-slate-100 border border-slate-200 shadow-sm">
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
      <div className="p-4 border-t border-slate-200 bg-white shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
        {isProcessing ? (
          <div className="flex flex-col items-center justify-center py-2 space-y-3">
            <div className="relative w-8 h-8">
              <div className="absolute inset-0 border-2 border-indigo-100 rounded-full"></div>
              <div className="absolute inset-0 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            </div>
            <p className="text-xs text-slate-500 font-medium animate-pulse">{processingState}...</p>
          </div>
        ) : (
          <div className="space-y-3">
             <label className="flex items-center gap-2 px-1 cursor-pointer group select-none">
               <div className="relative flex items-center">
                 <input 
                   type="checkbox" 
                   checked={processAll} 
                   onChange={(e) => setProcessAll(e.target.checked)}
                   className="peer h-4 w-4 cursor-pointer appearance-none rounded border border-slate-300 bg-slate-50 checked:border-indigo-600 checked:bg-indigo-600 focus:outline-none transition-all"
                 />
                 <svg className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7"></path></svg>
               </div>
               <span className="text-xs font-medium text-slate-600 group-hover:text-indigo-600 transition-colors">Apply to all {images.length} images</span>
             </label>

             <button
              onClick={() => onProcess(processAll)}
              disabled={!canProcess}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-xl font-semibold text-sm transition-all shadow-md shadow-indigo-200 active:scale-[0.98] flex items-center justify-center gap-2"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
              {processAll ? 'Generate All Patches' : 'Generate Patches'}
            </button>
            
            {currentImage?.finalResultUrl && (
              <button
                onClick={onDownload}
                className="w-full py-3 bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 rounded-xl font-medium text-sm transition-all shadow-sm hover:shadow active:scale-[0.98] flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                Download Result
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;