import React, { useState, useEffect } from 'react';
import { AppConfig, UploadedImage, Region, ProcessingStep } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import { loadImage, cropRegion, stitchImage, readFileAsDataURL } from './services/imageUtils';
import { generateRegionEdit } from './services/aiService';

const DEFAULT_PROMPT = "Enhance this section with high detail, keeping realistic lighting.";
const CONFIG_STORAGE_KEY = 'genai_patcher_config_v1';

const DEFAULT_CONFIG: AppConfig = {
  prompt: DEFAULT_PROMPT,
  executionMode: 'concurrent',
  
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
        return updated;
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
  }, [selectedImageId]); // Re-bind if selected image changes to ensure closure freshness if needed, though processFiles is stable-ish

  const handleUpdateRegions = (imageId: string, regions: Region[]) => {
    setImages((prev) =>
      prev.map((img) => (img.id === imageId ? { ...img, regions } : img))
    );
  };

  const handleProcess = async () => {
    if (!selectedImage) return;

    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);
    setViewMode('original'); // Switch back to original to show progress

    try {
      // 1. Prepare pending regions
      const pendingRegions = selectedImage.regions.filter(
        (r) => r.status === 'pending' || r.status === 'failed'
      );

      if (pendingRegions.length === 0) {
        alert("No new regions to process. Draw a box on the image first.");
        setProcessingState(ProcessingStep.IDLE);
        return;
      }

      // 2. Load the base image element for cropping
      const imgElement = await loadImage(selectedImage.previewUrl);

      // Helper for processing a single region
      const processRegion = async (region: Region): Promise<Region> => {
        try {
          // Crop
          const croppedBase64 = await cropRegion(imgElement, region);
          
          // API Call (Generic)
          const resultBase64 = await generateRegionEdit(
            croppedBase64,
            config.prompt,
            config
          );

          return {
            ...region,
            status: 'completed',
            processedImageBase64: resultBase64,
          };
        } catch (error) {
          console.error(`Failed to process region ${region.id}`, error);
          return { ...region, status: 'failed' };
        }
      };

      // Set status to processing
      setImages((prev) =>
        prev.map((img) =>
          img.id === selectedImage.id
            ? {
                ...img,
                regions: img.regions.map((r) =>
                  pendingRegions.find((pr) => pr.id === r.id)
                    ? { ...r, status: 'processing' }
                    : r
                ),
              }
            : img
        )
      );

      setProcessingState(ProcessingStep.API_CALLING);

      let processedRegions: Region[] = [];

      if (config.executionMode === 'concurrent') {
        processedRegions = await Promise.all(pendingRegions.map(processRegion));
      } else {
        // Serial
        for (const region of pendingRegions) {
          const result = await processRegion(region);
          processedRegions.push(result);
        }
      }

      // Update state with results
      setImages((prev) =>
        prev.map((img) =>
          img.id === selectedImage.id
            ? {
                ...img,
                regions: img.regions.map((r) => {
                  const processed = processedRegions.find((pr) => pr.id === r.id);
                  return processed || r;
                }),
              }
            : img
        )
      );

      // 3. Stitching
      setProcessingState(ProcessingStep.STITCHING);
      
      // Get latest state of regions for this image to include any previously completed ones
      const currentRegions = images
        .find(i => i.id === selectedImage.id)
        ?.regions.map(r => {
             const newlyProcessed = processedRegions.find(pr => pr.id === r.id);
             return newlyProcessed || r;
        }) || [];

      const finalResultUrl = await stitchImage(selectedImage.previewUrl, currentRegions);

      setImages((prev) =>
        prev.map((img) =>
          img.id === selectedImage.id
            ? { ...img, finalResultUrl, regions: currentRegions }
            : img
        )
      );

      setProcessingState(ProcessingStep.DONE);
      setViewMode('result'); // Auto switch to result view

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
    <div className="flex h-screen bg-slate-950 text-slate-200 font-sans">
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

      <div className="flex-1 flex flex-col relative">
        {/* Header/Status Bar */}
        <div className="h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6">
            <div className="flex items-center gap-4">
              <div className="text-sm font-medium text-slate-300">
                  {selectedImage ? selectedImage.file.name : 'No image selected'}
              </div>
              
              {/* View Toggle */}
              {selectedImage?.finalResultUrl && (
                <div className="flex bg-slate-800 rounded p-1 border border-slate-700">
                  <button
                    onClick={() => setViewMode('original')}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      viewMode === 'original' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Original
                  </button>
                  <button
                    onClick={() => setViewMode('result')}
                    className={`px-3 py-1 text-xs rounded transition-colors ${
                      viewMode === 'result' ? 'bg-green-600 text-white shadow' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Result
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-4">
              {errorMsg && (
                  <div className="text-red-400 text-sm bg-red-400/10 px-3 py-1 rounded">
                      Error: {errorMsg}
                  </div>
              )}
              <div className="text-xs text-slate-500">
                  {selectedImage?.regions.filter(r => r.status === 'completed').length} / {selectedImage?.regions.length} regions processed
              </div>
            </div>
        </div>

        {/* Main Workspace */}
        <div className="flex-1 relative bg-grid-pattern">
          {displayImage ? (
            <EditorCanvas
              image={displayImage}
              onUpdateRegions={handleUpdateRegions}
              disabled={viewMode === 'result' || (processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE)}
            />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-slate-500">
              <svg className="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
              <p>Upload an image to start editing (or paste from clipboard)</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}