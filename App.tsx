
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
  theme: 'light',
  language: 'zh',
  provider: 'openai',
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'dall-e-3',
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
  processingMode: 'api' // Default to API mode
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
        // Merge defaults to handle new fields
        return { ...DEFAULT_CONFIG, ...parsed, language: parsed.language || 'zh' };
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

  // Global Paste Listener for File Uploads
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
        // Safe check: If the event was already handled (stopPropagation called), do nothing
        // Or if the target is an input/textarea (like prompt or manual drop zone), ignore global file paste
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
    setImages((prev) =>
      prev.map((img) => (img.id === imageId ? { ...img, regions } : img))
    );
  };

  // Manual Mode: Handle patch update
  const handleManualPatchUpdate = async (imageId: string, regionId: string, base64: string) => {
      // 1. Update the region in state
      let updatedImage: UploadedImage | null = null;
      
      const newImagesState = images.map(img => {
          if (img.id !== imageId) return img;
          
          const newRegions = img.regions.map(r => 
              r.id === regionId 
              ? { ...r, status: 'completed' as const, processedImageBase64: base64 } 
              : r
          );
          updatedImage = { ...img, regions: newRegions };
          return updatedImage;
      });

      setImages(newImagesState);

      // 2. Stitch the image immediately (Hot Stitching for Manual Mode)
      if (updatedImage) {
          try {
             // Only stitch if we have completed regions
             const completedRegions = updatedImage.regions.filter(r => r.status === 'completed' && r.processedImageBase64);
             if (completedRegions.length > 0) {
                 const finalUrl = await stitchImage(updatedImage.previewUrl, updatedImage.regions);
                 setImages(prev => prev.map(img => 
                    img.id === imageId ? { ...img, finalResultUrl: finalUrl } : img
                 ));
                 
                 // If we are viewing original, switch to result to show the update
                 if (viewMode === 'original' && selectedImageId === imageId) {
                     setViewMode('result');
                 }
             }
          } catch (e) {
              console.error("Manual stitch failed", e);
              setErrorMsg("Stitching failed");
          }
      }
  };

  const handleProcess = async (processAll: boolean) => {
    if (processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE) return;
    if (!selectedImage && !processAll) return;

    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);
    setViewMode('original'); // Always reset to original view when starting

    try {
      // 1. Collect all pending regions
      interface Task {
        imageId: string;
        region: Region;
        imageUrl: string;
      }

      const tasks: Task[] = [];
      const imagesToProcess = processAll ? images : (selectedImage ? [selectedImage] : []);

      for (const img of imagesToProcess) {
        const pending = img.regions.filter(r => r.status === 'pending' || r.status === 'failed');
        pending.forEach(r => {
           tasks.push({ imageId: img.id, region: r, imageUrl: img.previewUrl });
        });
      }

      if (tasks.length === 0) {
        alert("No new regions found to process.");
        setProcessingState(ProcessingStep.IDLE);
        return;
      }

      setProcessingState(ProcessingStep.API_CALLING);

      // Mark regions as processing in UI
      setImages(prev => prev.map(img => ({
         ...img,
         regions: img.regions.map(r => tasks.find(t => t.imageId === img.id && t.region.id === r.id) ? { ...r, status: 'processing' } : r)
      })));

      // Process function for concurrency
      const processTask = async (task: Task) => {
        try {
          const imgEl = await loadImage(task.imageUrl);
          const croppedBase64 = await cropRegion(imgEl, task.region);
          const resultBase64 = await generateRegionEdit(croppedBase64, config.prompt, config);
          return { ...task, success: true, resultBase64 };
        } catch (error) {
          console.error(`Failed region ${task.region.id}`, error);
          // Fix: Ensure resultBase64 exists as undefined to allow safe property access on union result
          return { ...task, success: false, resultBase64: undefined };
        }
      };

      // Run API Calls
      const limit = config.executionMode === 'concurrent' ? config.concurrencyLimit : 1;
      const results = await runWithConcurrency(tasks, limit, processTask);

      setProcessingState(ProcessingStep.STITCHING);

      // 2. Update Image State & Stitch
      // We process all images to ensure everything is up to date
      const updatedImages = await Promise.all(images.map(async (img) => {
        const imgResults = results.filter(r => r.imageId === img.id);
        
        // If no results for this image and it wasn't being processed, return as is
        if (imgResults.length === 0 && !imagesToProcess.find(i => i.id === img.id)) {
            return img;
        }

        // Update regions
        const newRegions = img.regions.map(r => {
            const res = imgResults.find(res => res.region.id === r.id);
            if (res) {
                return { 
                    ...r, 
                    status: res.success ? 'completed' : 'failed', 
                    processedImageBase64: res.resultBase64 
                } as Region;
            }
            return r;
        });

        // Generate final stitched image if there are completed regions
        let finalUrl = img.finalResultUrl;
        if (newRegions.some(r => r.status === 'completed')) {
             try {
                finalUrl = await stitchImage(img.previewUrl, newRegions);
             } catch (e) {
                 console.error("Stitch failed for image", img.id, e);
             }
        }

        return { ...img, regions: newRegions, finalResultUrl: finalUrl };
      }));

      setImages(updatedImages);
      setProcessingState(ProcessingStep.DONE);
      
      // Auto switch to result view if we are on single image mode
      if (!processAll && selectedImage) {
          setViewMode('result');
      }

    } catch (err: any) {
      console.error(err);
      setErrorMsg(err.message || "An unexpected error occurred.");
      setProcessingState(ProcessingStep.IDLE);
    }
  };

  const handleDownload = () => {
    if (selectedImage?.finalResultUrl) {
      const link = document.createElement('a');
      link.href = selectedImage.finalResultUrl;
      link.download = `patched_${selectedImage.file.name}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const displayImage = selectedImage 
    ? {
        ...selectedImage,
        previewUrl: (viewMode === 'result' && selectedImage.finalResultUrl) 
          ? selectedImage.finalResultUrl 
          : selectedImage.previewUrl
      }
    : null;

  const statusKey = processingState.toLowerCase() as any;
  const processingText = processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE ? t(config.language, statusKey) : '';
  const isCurrentImageProcessing = selectedImage?.regions.some(r => r.status === 'processing');

  return (
    <div className="flex h-screen bg-skin-fill text-skin-text font-sans selection:bg-skin-primary-light selection:text-skin-primary transition-colors duration-300">
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        onSelectImage={(id) => { setSelectedImageId(id); setViewMode('original'); }}
        onUpload={handleUpload}
        onProcess={handleProcess}
        processingState={processingState}
        currentImage={selectedImage}
        onDownload={handleDownload}
        onManualPatchUpdate={handleManualPatchUpdate}
      />

      <div className="flex-1 flex flex-col relative bg-skin-fill transition-colors duration-300">
        {/* Header/Status Bar */}
        <div className="h-16 bg-skin-surface border-b border-skin-border flex items-center justify-between px-6 shadow-sm z-10 transition-colors duration-300">
            <div className="flex items-center gap-6">
              <div className="flex flex-col">
                 <div className="text-sm font-semibold text-skin-text flex items-center gap-2">
                    {selectedImage ? (
                        <>
                           <span>{selectedImage.file.name}</span>
                           <span className="px-1.5 py-0.5 rounded text-[10px] bg-skin-fill text-skin-muted font-mono border border-skin-border">
                               {selectedImage.originalWidth}x{selectedImage.originalHeight}
                           </span>
                        </>
                    ) : t(config.language, 'idle')}
                 </div>
                 <div className="text-xs text-skin-muted">
                    {selectedImage ? `${selectedImage.regions.length} regions` : 'Select an image'}
                 </div>
              </div>
              
              {/* View Toggle */}
              {selectedImage?.finalResultUrl && (
                <div className="flex bg-skin-fill rounded-lg p-1 border border-skin-border">
                  <button
                    onClick={() => setViewMode('original')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
                      viewMode === 'original' 
                        ? 'bg-skin-surface text-skin-text shadow-sm border border-skin-border' 
                        : 'text-skin-muted hover:text-skin-text hover:bg-skin-surface/50'
                    }`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => setViewMode('result')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
                      viewMode === 'result' 
                        ? 'bg-emerald-50 text-emerald-700 shadow-sm border border-emerald-200' 
                        : 'text-skin-muted hover:text-skin-text hover:bg-skin-surface/50'
                    }`}
                  >
                    Result
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              {errorMsg && (
                  <div className="flex items-center gap-2 text-rose-600 text-xs bg-rose-50 px-3 py-1.5 rounded-full border border-rose-200">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      {errorMsg}
                  </div>
              )}
            </div>
        </div>

        {/* Main Workspace */}
        <div className="flex-1 relative bg-checkerboard overflow-hidden transition-colors duration-300">
          {displayImage ? (
            <EditorCanvas
              image={displayImage}
              onUpdateRegions={handleUpdateRegions}
              disabled={viewMode === 'result' || (isCurrentImageProcessing === true)}
              language={config.language}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-skin-muted">
              <div className="w-20 h-20 bg-skin-surface rounded-2xl flex items-center justify-center mb-6 shadow-sm border border-skin-border rotate-3 transition-colors duration-300">
                 <svg className="w-10 h-10 text-skin-muted/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
              </div>
              <p className="text-lg font-medium text-skin-text">{t(config.language, 'readyToCreate')}</p>
              <p className="text-sm mt-1 text-skin-muted">{t(config.language, 'uploadHint')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
