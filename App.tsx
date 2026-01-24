import React, { useState, useEffect } from 'react';
import { AppConfig, UploadedImage, Region, ProcessingStep } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import { loadImage, cropRegion, stitchImage, readFileAsDataURL, naturalSortCompare } from './services/imageUtils';
import { generateRegionEdit } from './services/aiService';

const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";
const CONFIG_STORAGE_KEY = 'genai_patcher_config_v1';

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  executionMode: 'concurrent',
  concurrencyLimit: 3,
  
  // Default to OpenAI as requested
  provider: 'openai',
  
  // OpenAI Defaults
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiApiKey: '',
  openaiModel: 'dall-e-3',

  // Gemini Defaults
  geminiApiKey: process.env.API_KEY || '',
  geminiModel: 'gemini-2.5-flash-image', 
};

type ViewMode = 'original' | 'result';

// Helper for concurrency control
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
    
    // Cleanup finished promise
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
  // Initialize config from localStorage if available, otherwise use defaults
  const [config, setConfig] = useState<AppConfig>(() => {
    try {
      const saved = localStorage.getItem(CONFIG_STORAGE_KEY);
      if (saved) {
        // Merge saved config with default config to handle potential new fields in future updates
        return { ...DEFAULT_CONFIG, ...JSON.parse(saved) };
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

  // Persist config to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }, [config]);

  const selectedImage = images.find((img) => img.id === selectedImageId);

  // Reusable function to process a list of files
  const processFiles = async (fileList: File[]) => {
    const newImages: UploadedImage[] = [];
    
    // Filter for images only
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
        // Ensure natural sort order whenever new images are added
        return updated.sort(naturalSortCompare);
      });
      
      // Auto-select if nothing was selected
      if (!selectedImageId && newImages.length > 0) {
         setSelectedImageId(newImages[0].id);
      }
    }
  };

  // Handle file uploads from input
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await processFiles(Array.from(e.target.files));
    }
    // Reset input
    e.target.value = '';
  };

  // Handle global paste
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
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
            e.preventDefault(); // Stop default paste (e.g. into prompt text area if focused)
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

  const handleProcess = async (processAll: boolean) => {
    if (!selectedImage && !processAll) return;

    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);
    if (!processAll) setViewMode('original'); 

    try {
      // 1. Collect all pending regions based on scope
      interface Task {
        imageId: string;
        region: Region;
        imageUrl: string;
      }

      const tasks: Task[] = [];
      const imagesToProcess = processAll ? images : (selectedImage ? [selectedImage] : []);

      // If processing all, images are already sorted via natural sort in setImages state
      // but let's ensure we are iterating the current state list
      
      for (const img of imagesToProcess) {
        const pending = img.regions.filter(r => r.status === 'pending' || r.status === 'failed');
        pending.forEach(r => {
           tasks.push({
             imageId: img.id,
             region: r,
             imageUrl: img.previewUrl
           });
        });
      }

      if (tasks.length === 0) {
        alert("No new regions found to process.");
        setProcessingState(ProcessingStep.IDLE);
        return;
      }

      setProcessingState(ProcessingStep.API_CALLING);

      // Helper to update specific region status in state
      const updateRegionStatus = (imgId: string, regId: string, status: Region['status'], resultBase64?: string) => {
         setImages(prev => prev.map(img => {
            if (img.id !== imgId) return img;
            return {
              ...img,
              regions: img.regions.map(r => r.id === regId ? { ...r, status, processedImageBase64: resultBase64 } : r)
            };
         }));
      };

      // Mark all as processing first (optional, but good UX)
      setImages(prev => prev.map(img => ({
         ...img,
         regions: img.regions.map(r => tasks.find(t => t.imageId === img.id && t.region.id === r.id) ? { ...r, status: 'processing' } : r)
      })));

      // Task Processor
      const processTask = async (task: Task) => {
        try {
          // 1. Load Image Element for cropping
          // Note: In a heavy batch, loading many images might consume memory, 
          // but browser cache handles repeated loads of the same URL well.
          const imgEl = await loadImage(task.imageUrl);
          
          // 2. Crop
          const croppedBase64 = await cropRegion(imgEl, task.region);
          
          // 3. API Call
          const resultBase64 = await generateRegionEdit(
            croppedBase64,
            config.prompt,
            config
          );

          // 4. Update Status Success
          updateRegionStatus(task.imageId, task.region.id, 'completed', resultBase64);
          
          return { ...task, success: true };
        } catch (error) {
          console.error(`Failed region ${task.region.id}`, error);
          updateRegionStatus(task.imageId, task.region.id, 'failed');
          return { ...task, success: false };
        }
      };

      // Execute with concurrency limit
      const limit = config.executionMode === 'concurrent' ? config.concurrencyLimit : 1;
      await runWithConcurrency(tasks, limit, processTask);

      // 3. Stitching
      setProcessingState(ProcessingStep.STITCHING);
      
      // Determine which images need stitching (unique IDs from tasks)
      const affectedImageIds = Array.from(new Set(tasks.map(t => t.imageId)));
      
      // Stitch affected images
      await new Promise<void>(resolve => {
        setImages(currentImages => {
          const runStitch = async () => {
             const updatedImages = [...currentImages];
             for (const id of affectedImageIds) {
                const imgIndex = updatedImages.findIndex(i => i.id === id);
                if (imgIndex === -1) continue;
                
                const img = updatedImages[imgIndex];
                // Stitch using the regions present in this latest state
                try {
                  const finalUrl = await stitchImage(img.previewUrl, img.regions);
                  updatedImages[imgIndex] = { ...img, finalResultUrl: finalUrl };
                } catch(e) {
                  console.error("Stitch failed for", img.file.name, e);
                }
             }
             setImages(updatedImages);
             resolve();
          };
          runStitch();
          return currentImages; // Return unchanged for now
        });
      });

      setProcessingState(ProcessingStep.DONE);
      if (!processAll) setViewMode('result');

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

  // Determine what to show in canvas
  const displayImage = selectedImage 
    ? {
        ...selectedImage,
        previewUrl: (viewMode === 'result' && selectedImage.finalResultUrl) 
          ? selectedImage.finalResultUrl 
          : selectedImage.previewUrl
      }
    : null;

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800 font-sans selection:bg-indigo-100 selection:text-indigo-900">
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
      />

      <div className="flex-1 flex flex-col relative bg-slate-50">
        {/* Header/Status Bar */}
        <div className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6 shadow-sm z-10">
            <div className="flex items-center gap-6">
              <div className="flex flex-col">
                 <div className="text-sm font-semibold text-slate-800 flex items-center gap-2">
                    {selectedImage ? (
                        <>
                           <span>{selectedImage.file.name}</span>
                           <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 text-slate-500 font-mono border border-slate-200">
                               {selectedImage.originalWidth}x{selectedImage.originalHeight}
                           </span>
                        </>
                    ) : 'No image selected'}
                 </div>
                 <div className="text-xs text-slate-500">
                    {selectedImage ? `${selectedImage.regions.length} regions defined` : 'Select an image to begin editing'}
                 </div>
              </div>
              
              {/* View Toggle */}
              {selectedImage?.finalResultUrl && (
                <div className="flex bg-slate-100 rounded-lg p-1 border border-slate-200">
                  <button
                    onClick={() => setViewMode('original')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
                      viewMode === 'original' 
                        ? 'bg-white text-slate-800 shadow-sm border border-slate-200' 
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                    }`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => setViewMode('result')}
                    className={`px-4 py-1.5 text-xs font-medium rounded-md transition-all ${
                      viewMode === 'result' 
                        ? 'bg-emerald-50 text-emerald-700 shadow-sm border border-emerald-200' 
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200/50'
                    }`}
                  >
                    Result
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              {errorMsg && (
                  <div className="flex items-center gap-2 text-red-600 text-xs bg-red-50 px-3 py-1.5 rounded-full border border-red-200">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                      {errorMsg}
                  </div>
              )}
            </div>
        </div>

        {/* Main Workspace */}
        <div className="flex-1 relative bg-checkerboard overflow-hidden">
          {displayImage ? (
            <EditorCanvas
              image={displayImage}
              onUpdateRegions={handleUpdateRegions}
              disabled={viewMode === 'result' || (processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
              <div className="w-20 h-20 bg-white rounded-2xl flex items-center justify-center mb-6 shadow-sm border border-slate-200 rotate-3">
                 <svg className="w-10 h-10 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
              </div>
              <p className="text-lg font-medium text-slate-600">Ready to Create</p>
              <p className="text-sm mt-1">Upload images via the sidebar or paste from clipboard (Ctrl+V)</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}