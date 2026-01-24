import React, { useState } from 'react';
import { AppConfig, ProcessingStep, UploadedImage } from '../types';
import { fetchOpenAIModels } from '../services/aiService';

interface SidebarProps {
  config: AppConfig;
  setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
  images: UploadedImage[];
  selectedImageId: string | null;
  onSelectImage: (id: string) => void;
  onUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onProcess: () => void;
  processingState: ProcessingStep;
  currentImage?: UploadedImage;
  onDownload: () => void;
}

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
  
  const isProcessing = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE;

  const handleConfigChange = (key: keyof AppConfig, value: string) => {
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

  const hasValidKey = config.provider === 'openai' ? !!config.openaiApiKey : !!config.geminiApiKey;

  return (
    <div className="w-80 h-full bg-slate-900 border-r border-slate-800 flex flex-col shadow-xl z-10">
      <div className="p-5 border-b border-slate-800">
        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
          GenAI Patcher
        </h1>
        <p className="text-xs text-slate-500 mt-1">Multi-region Image Transformation</p>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Upload Section */}
        <div>
          <label className="block text-sm font-medium text-slate-400 mb-2">Upload Images</label>
          <div className="space-y-2">
            <label className="flex flex-col items-center justify-center w-full h-24 border-2 border-slate-700 border-dashed rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors group">
              <div className="flex flex-col items-center justify-center pt-5 pb-6">
                <svg className="w-6 h-6 mb-2 text-slate-500 group-hover:text-blue-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path>
                </svg>
                <p className="text-xs text-slate-500 group-hover:text-slate-300">Click to Upload or Paste</p>
              </div>
              <input type="file" className="hidden" multiple accept="image/*" onChange={onUpload} disabled={isProcessing} />
            </label>

            <label className="flex items-center justify-center w-full py-2 border border-slate-700 rounded cursor-pointer hover:bg-slate-800 transition-colors">
               <span className="text-xs text-slate-400 flex items-center gap-2">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"></path></svg>
                 Upload Folder
               </span>
               <input 
                 type="file" 
                 className="hidden" 
                 multiple 
                 accept="image/*" 
                 {...{ webkitdirectory: "", directory: "" } as any}
                 onChange={onUpload} 
                 disabled={isProcessing} 
               />
            </label>
          </div>
        </div>

        {/* Thumbnail List */}
        {images.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-400 mb-2">Gallery ({images.length})</label>
            <div className="grid grid-cols-3 gap-2 max-h-40 overflow-y-auto pr-1">
              {images.map((img) => (
                <div
                  key={img.id}
                  onClick={() => !isProcessing && onSelectImage(img.id)}
                  className={`relative aspect-square rounded overflow-hidden cursor-pointer border-2 transition-all ${
                    selectedImageId === img.id ? 'border-blue-500 ring-2 ring-blue-500/20' : 'border-slate-700 hover:border-slate-500'
                  } ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <img src={img.previewUrl} alt="thumb" className="w-full h-full object-cover" />
                  {img.regions.length > 0 && (
                    <span className="absolute bottom-0 right-0 bg-blue-600 text-[9px] px-1 text-white">
                      {img.regions.length}
                    </span>
                  )}
                  {img.finalResultUrl && (
                     <div className="absolute top-0 right-0 w-2 h-2 bg-green-500 rounded-full m-1"></div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <hr className="border-slate-800" />

        {/* AI Configuration */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
             <label className="block text-sm font-medium text-slate-300">AI Service</label>
             <select 
               value={config.provider}
               onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
               className="bg-slate-800 text-xs text-white border border-slate-600 rounded px-2 py-1 focus:outline-none"
               disabled={isProcessing}
             >
               <option value="openai">OpenAI Compatible</option>
               <option value="gemini">Google Gemini</option>
             </select>
          </div>

          {config.provider === 'openai' ? (
            <div className="space-y-3 p-3 bg-slate-800/50 rounded border border-slate-800">
               <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Base URL</label>
                <input
                  type="text"
                  value={config.openaiBaseUrl}
                  onChange={(e) => handleConfigChange('openaiBaseUrl', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                  placeholder="https://api.openai.com/v1"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">API Key</label>
                <input
                  type="password"
                  value={config.openaiApiKey}
                  onChange={(e) => handleConfigChange('openaiApiKey', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                  placeholder="sk-..."
                />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <label className="block text-[10px] uppercase font-bold text-slate-500">Model</label>
                  <button 
                    onClick={handleFetchOpenAIModels}
                    disabled={isLoadingModels}
                    className="text-[10px] text-blue-400 hover:text-blue-300 disabled:text-slate-600"
                  >
                    {isLoadingModels ? 'Fetching...' : 'Fetch List'}
                  </button>
                </div>
                {modelList.length > 0 ? (
                  <select
                    value={config.openaiModel}
                    onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none"
                  >
                    {modelList.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={config.openaiModel}
                    onChange={(e) => handleConfigChange('openaiModel', e.target.value)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                    placeholder="dall-e-3"
                  />
                )}
              </div>
            </div>
          ) : (
             <div className="space-y-3 p-3 bg-slate-800/50 rounded border border-slate-800">
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">API Key</label>
                <input
                  type="password"
                  value={config.geminiApiKey}
                  onChange={(e) => handleConfigChange('geminiApiKey', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300"
                  placeholder="Gemini API Key"
                />
              </div>
              <div>
                <label className="block text-[10px] uppercase font-bold text-slate-500 mb-1">Model</label>
                <select
                  value={config.geminiModel}
                  onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 focus:outline-none"
                >
                  <option value="gemini-2.5-flash-image">gemini-2.5-flash-image</option>
                  <option value="gemini-3-pro-image-preview">gemini-3-pro-image-preview</option>
                  <option value="custom">Custom (Type below)</option>
                </select>
                {config.geminiModel === 'custom' && (
                   <input
                   type="text"
                   className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-300 mt-2"
                   placeholder="Enter custom model name"
                   onChange={(e) => handleConfigChange('geminiModel', e.target.value)}
                 />
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-400 mb-1">Transformation Prompt</label>
            <textarea
              placeholder="E.g., A futuristic cyberpunk building."
              value={config.prompt}
              onChange={(e) => setConfig({ ...config, prompt: e.target.value })}
              className="w-full bg-slate-800 border border-slate-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 h-24 resize-none transition-colors"
              disabled={isProcessing}
            />
          </div>
        </div>

        {/* Generated Patches Gallery */}
        {currentImage && currentImage.regions.some(r => r.processedImageBase64) && (
          <div>
            <hr className="border-slate-800 my-4" />
            <label className="block text-sm font-medium text-slate-400 mb-2">Generated Patches</label>
            <div className="grid grid-cols-2 gap-2">
              {currentImage.regions.map(region => (
                region.processedImageBase64 ? (
                  <div key={region.id} className="relative group rounded border border-slate-700 overflow-hidden bg-black/20">
                     <img 
                       src={region.processedImageBase64} 
                       alt="Patch" 
                       className="w-full h-20 object-contain" 
                     />
                     <div className="absolute top-0 left-0 bg-black/60 text-white text-[9px] px-1">
                       ID: {region.id.slice(0,4)}
                     </div>
                  </div>
                ) : null
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action Footer */}
      <div className="p-5 border-t border-slate-800 bg-slate-900/50 backdrop-blur">
        {isProcessing ? (
          <div className="text-center space-y-2">
            <div className="inline-block animate-spin rounded-full h-5 w-5 border-2 border-blue-500 border-t-transparent"></div>
            <p className="text-sm text-blue-400 font-medium">{processingState}...</p>
          </div>
        ) : (
          <div className="space-y-2">
             <button
              onClick={onProcess}
              disabled={!images.length || !hasValidKey || !currentImage?.regions.length}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded font-medium transition-all shadow-lg shadow-blue-900/20 active:scale-95 text-sm"
            >
              Start Processing
            </button>
            {currentImage?.finalResultUrl && (
              <button
                onClick={onDownload}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium transition-all shadow-lg shadow-emerald-900/20 active:scale-95 text-sm flex items-center justify-center gap-2"
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