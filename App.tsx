import React, { useState, useEffect } from 'react';
import { AppConfig, UploadedImage, Region, ProcessingStep } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import { loadImage, cropRegion, stitchImage, readFileAsDataURL, naturalSortCompare } from './services/imageUtils';
import { generateRegionEdit } from './services/aiService';
import { t } from './services/translations';

const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";
const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  processFullImageIfNoRegions: false, 
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'dall-e-3',
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api' 
};

type ViewMode = 'original' | 'result';

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];
  
  for (const item of items) {
    const p = task(item).then((res) => {
      results.push(res);
    });
    executing.push(p);
    const cleanP = p.then(() => {
        executing.splice(executing.indexOf(cleanP), 1);
    });
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const geminiKey = parsed.geminiApiKey || process.env.API_KEY || '';
        return { 
            ...DEFAULT_CONFIG, 
            ...parsed, 
            geminiApiKey: geminiKey,
            language: parsed.language || 'zh' 
        };
      }
    } catch (e) {
      console.error("Failed to load config from localStorage", e);
    }
    return DEFAULT_CONFIG;
  });

  const [images, setImages] = useState<UploadedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [processingState, setProcessingState] = useState<ProcessingStep>(ProcessingStep.IDLE);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('original');

  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  }, [config.theme]);

  const selectedImage = images.find((img) => img.id === selectedImageId);

  const processFiles = async (fileList: File[]) => {
    const newImages: UploadedImage[] = [];
    const imageFiles = fileList.filter(f => f.type.startsWith('image/'));
    
    if (imageFiles.length === 0) return;

    for (const file of imageFiles) {
      try {
        const previewUrl = await readFileAsDataURL(file);
        const imgEl = await loadImage(previewUrl);

        newImages.push({
          id: crypto.randomUUID(),
          file,
          previewUrl,
          originalWidth: imgEl.naturalWidth,
          originalHeight: imgEl.naturalHeight,
          regions: [],
          customPrompt: '' // Initialize
        });
      } catch (e) {
        console.error("Failed to load image", file.name, e);
      }
    }

    if (newImages.length > 0) {
      setImages((prev) => {
        const updated = [...prev, ...newImages];
        return updated.sort(naturalSortCompare);
      });
      if (!selectedImageId && newImages.length > 0) {
         setSelectedImageId(newImages[0].id);
      }
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
           return;
        }

        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const file = items[i].getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            await processFiles(files);
        }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [selectedImageId]); 

  const handleUpdateRegions = (imageId: string, regions: Region[]) => {
    setImages(prev => prev.map(img => 
      img.id === imageId ? { ...img, regions } : img
    ));
  };

  const handleUpdateImagePrompt = (imageId: string, prompt: string) => {
    setImages(prev => prev.map(img => 
      img.id === imageId ? { ...img, customPrompt: prompt } : img
    ));
  };

  const handleDeleteImage = (imageId: string) => {
    setImages(prev => {
      const newImages = prev.filter(img => img.id !== imageId);
      
      // If we deleted the currently selected image, select the first available one, or clear selection
      if (selectedImageId === imageId) {
        if (newImages.length > 0) {
          setSelectedImageId(newImages[0].id);
        } else {
          setSelectedImageId(null);
        }
      }
      return newImages;
    });
  };

  const handleManualPatchUpdate = (imageId: string, regionId: string, base64: string) => {
    setImages(prev => {
        const nextState = prev.map(img => {
            if (img.id !== imageId) return img;
            const updatedRegions = img.regions.map(r => 
                r.id === regionId ? { ...r, processedImageBase64: base64, status: 'completed' as const } : r
            );
            return { ...img, regions: updatedRegions };
        });
        
        // Trigger stitch for this image in background
        const targetImg = nextState.find(i => i.id === imageId);
        if (targetImg) {
            stitchImage(targetImg.previewUrl, targetImg.regions).then(stitched => {
                setImages(current => current.map(i => i.id === imageId ? { ...i, finalResultUrl: stitched } : i));
            });
        }
        
        return nextState;
    });
  };

  const processSingleImage = async (image: UploadedImage) => {
    const regionsToProcess = image.regions.filter(r => r.status === 'pending' || r.status === 'failed');
    
    if (regionsToProcess.length === 0 && image.regions.length === 0 && config.processFullImageIfNoRegions) {
        const fullRegion: Region = {
            id: 'full-image',
            x: 0, y: 0, width: 100, height: 100,
            type: 'rect',
            status: 'pending'
        };
        regionsToProcess.push(fullRegion);
    }

    if (regionsToProcess.length === 0 && !config.processFullImageIfNoRegions) return;

    const imgElement = await loadImage(image.previewUrl);

    setImages(prev => prev.map(img => {
      if (img.id !== image.id) return img;
      return {
        ...img,
        regions: img.regions.map(r => regionsToProcess.find(rp => rp.id === r.id) ? { ...r, status: 'processing' } : r)
      };
    }));

    setProcessingState(ProcessingStep.CROPPING);

    const updatedRegions = [...image.regions];
    
    // Determine the effective prompt for this specific image
    // Logic: Global Prompt + " " + Specific Prompt
    const globalPrompt = config.prompt.trim();
    const specificPrompt = image.customPrompt ? image.customPrompt.trim() : '';
    
    const effectivePrompt = specificPrompt.length > 0 
        ? `${globalPrompt} ${specificPrompt}` 
        : globalPrompt;

    for (const region of regionsToProcess) {
        try {
            const croppedBase64 = await cropRegion(imgElement, region);
            setProcessingState(ProcessingStep.API_CALLING);
            // Use the effective prompt here
            const processedBase64 = await generateRegionEdit(croppedBase64, effectivePrompt, config);
            
            const index = updatedRegions.findIndex(r => r.id === region.id);
            if (index !== -1) {
                updatedRegions[index] = {
                    ...updatedRegions[index],
                    processedImageBase64: processedBase64,
                    status: 'completed'
                };
            } else if (region.id === 'full-image') {
               const newRegion: Region = { ...region, id: crypto.randomUUID(), processedImageBase64: processedBase64, status: 'completed' };
               updatedRegions.push(newRegion);
            }

        } catch (err) {
            console.error("Region processing failed", err);
            const index = updatedRegions.findIndex(r => r.id === region.id);
            if (index !== -1) {
                updatedRegions[index] = { ...updatedRegions[index], status: 'failed' };
            }
        }
    }

    setImages(prev => prev.map(img => img.id === image.id ? { ...img, regions: updatedRegions } : img));

    setProcessingState(ProcessingStep.STITCHING);
    try {
        const stitched = await stitchImage(image.previewUrl, updatedRegions);
        setImages(prev => prev.map(img => img.id === image.id ? { ...img, finalResultUrl: stitched } : img));
    } catch (e) {
        console.error("Stitching failed", e);
    }
  };

  const handleProcess = async (processAll: boolean) => {
    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);

    const targets = processAll 
        ? images 
        : (selectedImage ? [selectedImage] : []);

    if (targets.length === 0) {
        setProcessingState(ProcessingStep.IDLE);
        return;
    }

    try {
        if (config.executionMode === 'concurrent') {
            await runWithConcurrency(targets, config.concurrencyLimit, processSingleImage);
        } else {
            for (const img of targets) {
                await processSingleImage(img);
            }
        }
        setProcessingState(ProcessingStep.DONE);
    } catch (e: any) {
        console.error("Global processing error", e);
        setErrorMsg(e.message || "Unknown error occurred");
        setProcessingState(ProcessingStep.IDLE);
    }
  };

  const handleDownload = () => {
      if (!selectedImage || !selectedImage.finalResultUrl) return;
      const link = document.createElement('a');
      link.href = selectedImage.finalResultUrl;
      link.download = `patched_${selectedImage.file.name}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  return (
    <div className="flex h-screen w-screen bg-skin-fill text-skin-text overflow-hidden font-sans">
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        onSelectImage={setSelectedImageId}
        onUpload={handleUpload}
        onProcess={handleProcess}
        processingState={processingState}
        currentImage={selectedImage}
        onDownload={handleDownload}
        onManualPatchUpdate={handleManualPatchUpdate}
        onUpdateImagePrompt={handleUpdateImagePrompt}
        onDeleteImage={handleDeleteImage}
      />
      
      <main className="flex-1 relative bg-checkerboard flex flex-col">
        {selectedImage ? (
           <>
             <div className="absolute top-4 left-4 z-10 flex gap-2">
                 <button 
                   onClick={() => setViewMode('original')}
                   className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'original' ? 'bg-skin-primary text-skin-primary-fg border-skin-primary' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                 >
                   {t(config.language, 'readyToCreate')}
                 </button>
                 {selectedImage.finalResultUrl && (
                    <button 
                        onClick={() => setViewMode('result')}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'result' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                    >
                        {t(config.language, 'status_completed')}
                    </button>
                 )}
             </div>

             {viewMode === 'original' ? (
                <EditorCanvas
                    image={selectedImage}
                    onUpdateRegions={handleUpdateRegions}
                    disabled={processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE}
                    language={config.language}
                />
             ) : (
                <div className="w-full h-full flex items-center justify-center p-8">
                    <img 
                      src={selectedImage.finalResultUrl} 
                      className="max-h-[85vh] max-w-full object-contain shadow-2xl rounded-lg ring-1 ring-skin-border" 
                      alt="Result" 
                    />
                </div>
             )}
           </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-skin-muted select-none">
            <div className="w-24 h-24 mb-4 rounded-3xl bg-skin-surface border-2 border-dashed border-skin-border flex items-center justify-center animate-pulse">
                <svg className="w-10 h-10 text-skin-border" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            </div>
            <p className="text-lg font-medium">{t(config.language, 'readyToCreate')}</p>
            <p className="text-sm opacity-60">{t(config.language, 'uploadHint')}</p>
          </div>
        )}

        {errorMsg && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-rose-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-2 opacity-80 hover:opacity-100">✕</button>
            </div>
        )}
      </main>
    </div>
  );
}
