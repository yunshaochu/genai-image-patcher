

import React, { useState, useEffect, useRef } from 'react';
import { AppConfig, UploadedImage, Region, ProcessingStep } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import PatchEditor from './components/PatchEditor'; // Import PatchEditor
import { loadImage, cropRegion, stitchImage, readFileAsDataURL, naturalSortCompare } from './services/imageUtils';
import { generateRegionEdit } from './services/aiService';
import { detectBubbles } from './services/detectionService';
import { t } from './services/translations';

const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";
const CONFIG_STORAGE_KEY = 'genai_patcher_config_v3';

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  processFullImageIfNoRegions: false, 
  apiTimeout: 150000, // 150 seconds default to prevent timeouts on slow gens
  maxRetries: 1,     // 1 retry
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'dall-e-3',
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api',
  // Updated to the specific backend URL provided
  detectionApiUrl: 'https://03da4393f7bc48419b6993c5162cb609--5000.ap-shanghai2.cloudstudio.club/detect',
  
  // Detection Tuning Defaults
  detectionInflationPercent: 10, // 10% expansion
  detectionOffsetXPercent: 0,
  detectionOffsetYPercent: 0,
  detectionConfidenceThreshold: 30, // 0.3
  
  // Global Features
  enableSmartAssist: false // Default off
};

type ViewMode = 'original' | 'result';

// --- AsyncSemaphore Class ---
// Strictly controls the global number of active heavy tasks (Crop + API)
class AsyncSemaphore {
  private permits: number;
  private queue: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const resolve = this.queue.shift();
      if (resolve) resolve();
    } else {
      this.permits++;
    }
  }
}

// Improved concurrency runner
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
  signal: AbortSignal,
  staggerMs: number = 0 
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();
  
  for (const item of items) {
    if (signal.aborted) break;
    
    await new Promise(resolve => setTimeout(resolve, staggerMs > 0 ? staggerMs : 0));
    
    if (signal.aborted) break;

    const p = task(item).then((res) => {
      if (!signal.aborted) results.push(res);
    });
    
    executing.add(p);
    
    const cleanP = p.catch(() => {}).then(() => {
        executing.delete(p);
    });
    
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  
  if (!signal.aborted) {
      await Promise.all(executing);
  }
  return results;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        const geminiKey = parsed.geminiApiKey || process.env.API_KEY || '';
        // Ensure new defaults are respected if key missing in old config
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
  const [isDragging, setIsDragging] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  
  // Editor State Lifted Up
  const [editingRegion, setEditingRegion] = useState<{ imageId: string, regionId: string, startBase64: string } | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const prevResultUrlRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', config.theme || 'light');
  }, [config.theme]);

  const selectedImage = images.find((img) => img.id === selectedImageId);

  useEffect(() => {
    const currentResultUrl = selectedImage?.finalResultUrl;
    if (!currentResultUrl && viewMode === 'result') {
      setViewMode('original');
    }
    if (!prevResultUrlRef.current && currentResultUrl) {
        setViewMode('result');
    }
    prevResultUrlRef.current = currentResultUrl;
  }, [selectedImage?.finalResultUrl, viewMode, selectedImageId]);

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
          customPrompt: '',
          isSkipped: false
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
         handleSelectImage(newImages[0].id);
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

  const handleSelectImage = (id: string) => {
    setSelectedImageId(id);
    const target = images.find(img => img.id === id);
    if (target?.finalResultUrl) {
        setViewMode('result');
    } else {
        setViewMode('original');
    }
  };

  const handleUpdateRegions = (imageId: string, regions: Region[]) => {
    setImages(prev => {
        const nextState = prev.map(img => 
          img.id === imageId ? { ...img, regions } : img
        );

        const targetImg = nextState.find(i => i.id === imageId);
        if (targetImg && targetImg.finalResultUrl) {
            stitchImage(targetImg.previewUrl, targetImg.regions).then(stitched => {
                setImages(current => current.map(i => i.id === imageId ? { ...i, finalResultUrl: stitched } : i));
            });
        }
        return nextState;
    });
  };

  const handleUpdateImagePrompt = (imageId: string, prompt: string) => {
    setImages(prev => prev.map(img => 
      img.id === imageId ? { ...img, customPrompt: prompt } : img
    ));
  };

  const handleToggleSkip = (imageId: string) => {
    setImages(prev => prev.map(img => 
        img.id === imageId ? { ...img, isSkipped: !img.isSkipped } : img
    ));
  };

  const handleDeleteImage = (imageId: string) => {
    setImages(prev => {
      const newImages = prev.filter(img => img.id !== imageId);
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
            
            let updatedRegions: Region[];
            if (regionId === 'manual-full-image') {
               const fullRegion: Region = {
                   id: crypto.randomUUID(),
                   x: 0, y: 0, width: 100, height: 100,
                   type: 'rect',
                   status: 'completed',
                   processedImageBase64: base64,
                   source: 'manual'
               };
               updatedRegions = [...img.regions, fullRegion];
            } else {
               updatedRegions = img.regions.map(r => 
                 r.id === regionId ? { ...r, processedImageBase64: base64, status: 'completed' as const } : r
               );
            }
            return { ...img, regions: updatedRegions };
        });
        
        const targetImg = nextState.find(i => i.id === imageId);
        if (targetImg) {
            stitchImage(targetImg.previewUrl, targetImg.regions).then(stitched => {
                setImages(current => current.map(i => i.id === imageId ? { ...i, finalResultUrl: stitched } : i));
            });
        }
        return nextState;
    });
  };

  // --- EDITOR HANDLERS (Lifted Up) ---
  const handleOpenEditor = async (imageId: string, regionId: string) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;

      if (regionId === 'manual-full-image') {
          // Special case for full image editing (Manual Mode feature)
          setEditingRegion({
              imageId,
              regionId,
              startBase64: img.finalResultUrl || img.previewUrl
          });
          return;
      }

      const region = img.regions.find(r => r.id === regionId);
      if (!region) return;

      let startBase64 = region.processedImageBase64;
      if (!startBase64) {
         // If no processed result, crop from original
         const imgEl = await loadImage(img.previewUrl);
         startBase64 = await cropRegion(imgEl, region);
      }
      setEditingRegion({
          imageId,
          regionId,
          startBase64
      });
  };

  const handleEditorSave = (newBase64: string) => {
      if (editingRegion) {
          handleManualPatchUpdate(editingRegion.imageId, editingRegion.regionId, newBase64);
      }
      setEditingRegion(null);
  };

  // --- AUTO DETECTION HANDLER ---
  const handleAutoDetect = async (scope: 'current' | 'all') => {
     setIsDetecting(true);
     setErrorMsg(null);
     
     const controller = new AbortController();
     abortControllerRef.current = controller;

     try {
         const targets = scope === 'current' 
            ? (selectedImage ? [selectedImage] : [])
            : images.filter(img => !img.isSkipped);
        
         if (targets.length === 0) {
            setIsDetecting(false);
            return;
         }

         const detectTask = async (img: UploadedImage) => {
            try {
                const newRegions = await detectBubbles(img.previewUrl, config);
                if (newRegions.length > 0) {
                    setImages(prev => prev.map(currentImg => 
                        currentImg.id === img.id 
                           ? { ...currentImg, regions: [...currentImg.regions, ...newRegions] }
                           : currentImg
                    ));
                }
            } catch (e: any) {
                console.error(`Detection failed for ${img.file.name}:`, e);
            }
         };

         await runWithConcurrency(
             targets,
             config.concurrencyLimit,
             detectTask,
             controller.signal,
             0
         );

     } catch (e: any) {
         console.error(e);
         setErrorMsg("Detection Error: " + e.message);
     } finally {
         setIsDetecting(false);
         abortControllerRef.current = null;
     }
  };

  const processSingleImage = async (imageSnapshot: UploadedImage, signal: AbortSignal, globalSemaphore: AsyncSemaphore) => {
    if (signal.aborted) return;
    if (imageSnapshot.isSkipped) return;

    const regionsMap = new Map<string, Region>();
    imageSnapshot.regions.forEach(r => regionsMap.set(r.id, r));

    let initialRegions = [...imageSnapshot.regions];
    if (initialRegions.length === 0 && config.processFullImageIfNoRegions) {
        const fullRegion: Region = {
            id: crypto.randomUUID(),
            x: 0, y: 0, width: 100, height: 100,
            type: 'rect',
            status: 'pending',
            source: 'manual'
        };
        initialRegions = [fullRegion];
        regionsMap.set(fullRegion.id, fullRegion);
        
        setImages(prev => prev.map(img => 
            img.id === imageSnapshot.id ? { ...img, regions: initialRegions } : img
        ));
    }

    const regionsToProcess = Array.from(regionsMap.values()).filter(r => r.status === 'pending' || r.status === 'failed');
    if (regionsToProcess.length === 0) return;

    const imgElement = await loadImage(imageSnapshot.previewUrl);

    regionsToProcess.forEach(r => {
        regionsMap.set(r.id, { ...r, status: 'processing' });
    });
    
    setImages(prev => prev.map(img => {
      if (img.id !== imageSnapshot.id) return img;
      return { ...img, regions: Array.from(regionsMap.values()) };
    }));

    if (signal.aborted) return;
    setProcessingState(ProcessingStep.CROPPING);

    const globalPrompt = config.prompt.trim();
    const specificPrompt = imageSnapshot.customPrompt ? imageSnapshot.customPrompt.trim() : '';
    const effectivePrompt = specificPrompt.length > 0 ? `${globalPrompt} ${specificPrompt}` : globalPrompt;

    const processRegionTask = async (region: Region) => {
        if (signal.aborted) return;

        await globalSemaphore.acquire();
        
        try {
            if (signal.aborted) return;
            await new Promise(r => setTimeout(r, 0));
            const croppedBase64 = await cropRegion(imgElement, region);
            
            if (signal.aborted) return;

            setProcessingState(ProcessingStep.API_CALLING);
            const processedBase64 = await generateRegionEdit(croppedBase64, effectivePrompt, config, signal);
            
            if (signal.aborted) return;

            const completedRegion = { ...region, processedImageBase64: processedBase64, status: 'completed' as const };
            regionsMap.set(region.id, completedRegion);

            setProcessingState(ProcessingStep.STITCHING);
            await new Promise(r => setTimeout(r, 0));
            
            const currentAllRegions = Array.from(regionsMap.values());
            const stitchedUrl = await stitchImage(imageSnapshot.previewUrl, currentAllRegions);

            setImages(prev => prev.map(img => {
                if (img.id !== imageSnapshot.id) return img;
                return {
                    ...img,
                    finalResultUrl: stitchedUrl,
                    regions: currentAllRegions 
                };
            }));

        } catch (err: any) {
            if (err.name === 'AbortError') return;
            
            console.error(`Region ${region.id} failed`, err);
            const failedRegion = { ...region, status: 'failed' as const };
            regionsMap.set(region.id, failedRegion);

            setImages(prev => prev.map(img => {
                if (img.id !== imageSnapshot.id) return img;
                return { ...img, regions: Array.from(regionsMap.values()) };
            }));
        } finally {
            globalSemaphore.release();
        }
    };

    await runWithConcurrency(
        regionsToProcess, 
        config.concurrencyLimit, 
        processRegionTask, 
        signal,
        0 
    );
  };

  const handleStop = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
      }
      
      setImages(prev => prev.map(img => ({
          ...img,
          regions: img.regions.map(r => 
              r.status === 'processing' ? { ...r, status: 'pending' } : r
          )
      })));

      setProcessingState(ProcessingStep.IDLE);
      setErrorMsg(t(config.language, 'stopped_by_user'));
  };

  const handleProcess = async (processAll: boolean) => {
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);

    const targets: UploadedImage[] = processAll 
        ? images.filter(img => !img.isSkipped)
        : (selectedImage ? [selectedImage] : []);

    if (targets.length === 0) {
        setProcessingState(ProcessingStep.IDLE);
        return;
    }

    const actualLimit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
    const globalSemaphore = new AsyncSemaphore(actualLimit);

    try {
        if (config.executionMode === 'concurrent') {
            await runWithConcurrency<UploadedImage, void>(
                targets, 
                config.concurrencyLimit, 
                (img) => processSingleImage(img, controller.signal, globalSemaphore),
                controller.signal,
                0 
            );
        } else {
            for (const img of targets) {
                if (controller.signal.aborted) break;
                await processSingleImage(img, controller.signal, globalSemaphore);
            }
        }
        
        if (controller.signal.aborted) {
             setErrorMsg(t(config.language, 'stopped_by_user'));
        }
        setProcessingState(ProcessingStep.DONE);
    } catch (e: any) {
        if (e.name === 'AbortError') {
             setErrorMsg(t(config.language, 'stopped_by_user'));
        } else {
             console.error("Global processing error", e);
             setErrorMsg(e.message || "Unknown error occurred");
        }
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

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
       await processFiles(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div 
      className="flex h-screen w-screen bg-skin-fill text-skin-text overflow-hidden font-sans relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        onSelectImage={handleSelectImage}
        onUpload={handleUpload}
        onProcess={handleProcess}
        onStop={handleStop}
        processingState={processingState}
        currentImage={selectedImage}
        onDownload={handleDownload}
        onManualPatchUpdate={handleManualPatchUpdate}
        onUpdateImagePrompt={handleUpdateImagePrompt}
        onDeleteImage={handleDeleteImage}
        onToggleSkip={handleToggleSkip}
        onAutoDetect={handleAutoDetect}
        isDetecting={isDetecting}
        onOpenEditor={(imageId, regionId) => handleOpenEditor(imageId, regionId)} 
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
                 {selectedImage.isSkipped && (
                     <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-500 text-white border border-zinc-500 backdrop-blur-md shadow-sm">
                        {t(config.language, 'skipped')}
                     </span>
                 )}
             </div>

             {viewMode === 'original' ? (
                <EditorCanvas
                    image={selectedImage}
                    onUpdateRegions={handleUpdateRegions}
                    disabled={processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE}
                    language={config.language}
                    onOpenEditor={(regionId) => handleOpenEditor(selectedImage.id, regionId)}
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
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-rose-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2 z-50">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-2 opacity-80 hover:opacity-100">✕</button>
            </div>
        )}
      </main>
      
      {/* GLOBAL PATCH EDITOR MODAL */}
      {editingRegion && (
         <PatchEditor 
            imageBase64={editingRegion.startBase64}
            onSave={handleEditorSave}
            onCancel={() => setEditingRegion(null)}
            language={config.language}
         />
      )}
      
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-skin-fill/80 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200 pointer-events-none">
           <div className="w-[80%] h-[80%] border-4 border-dashed border-skin-primary rounded-3xl flex flex-col items-center justify-center text-skin-primary">
              <svg className="w-24 h-24 mb-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
              <h2 className="text-3xl font-bold">{t(config.language, 'dropToUpload')}</h2>
           </div>
        </div>
      )}
    </div>
  );
}