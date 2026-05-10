
import { useState, useEffect, useRef, useCallback } from 'react';
import { UploadedImage, Region, ImageHistoryState, PerformanceMode } from '../types';
import { readFileAsDataURL, readFileAsObjectURL, loadImage, naturalSortCompare, stitchImage, cropRegion, compressImage, generateThumbnail, releaseObjectURL, cleanupImageUrls, MAX_HISTORY_ENTRIES } from '../services/imageUtils';

type ViewMode = 'original' | 'result';

export function useImageManager(performanceMode: PerformanceMode) {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('original');
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  const selectedImage = images.find((img) => img.id === selectedImageId);

  // Auto-switch view mode when result is ready
  useEffect(() => {
    if (!selectedImage?.regions.some(r => r.status === 'completed') && viewMode === 'result') {
      setViewMode('original');
    }
  }, [selectedImage?.regions, viewMode]);

  const addImageFiles = async (fileList: File[]) => {
    const imageFiles = fileList.filter(f => f.type.startsWith('image/') && !f.name.startsWith('.'));
    
    if (imageFiles.length === 0) return;

    setUploadProgress({ current: 0, total: imageFiles.length });
    const newImages: UploadedImage[] = [];

    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      try {
        // Use Object URL for the original — NO base64 string in memory
        const originalUrl = readFileAsObjectURL(file);
        const imgEl = await loadImage(originalUrl);

        const thumbnailUrl = await generateThumbnail(imgEl);

        let previewUrl = originalUrl;
        if (performanceMode === 'balanced') {
          // Compress preview: output is now also an Object URL
          previewUrl = await compressImage(originalUrl, { maxWidth: 2048, maxHeight: 2048, quality: 0.8 });
        }

        const initialState: ImageHistoryState = {
            previewUrl: previewUrl,
            regions: [],
            finalResultUrl: undefined,
            width: imgEl.naturalWidth,
            height: imgEl.naturalHeight,
            fullAiResultUrl: undefined
        };

        newImages.push({
          id: crypto.randomUUID(),
          file,
          previewUrl,
          originalUrl,
          thumbnailUrl,
          originalWidth: imgEl.naturalWidth,
          originalHeight: imgEl.naturalHeight,
          regions: [],
          isSkipped: false,
          history: [initialState],
          historyIndex: 0
        });
      } catch (e) {
        console.error("Failed to load image", file.name, e);
      }
      setUploadProgress({ current: i + 1, total: imageFiles.length });
    }

    if (newImages.length > 0) {
      setImages((prev) => {
        const updated = [...prev, ...newImages];
        return updated.sort(naturalSortCompare);
      });
      if (!selectedImageId) {
         handleSelectImage(newImages[0].id);
      }
    }
    setUploadProgress(null);
  };

  const handleSelectImage = useCallback((id: string) => {
    setSelectedImageId(id);
    setSelectedRegionId(null);
    setViewMode('original');
  }, []);

  const handleUpdateRegions = (imageId: string, regions: Region[]) => {
    setImages(prev => {
        const nextState = prev.map(img => {
          if (img.id !== imageId) return img;
          const updated = { ...img, regions };
          const currentHistory = [...updated.history];
          if (currentHistory[updated.historyIndex]) {
              currentHistory[updated.historyIndex] = {
                  ...currentHistory[updated.historyIndex],
                  regions: regions
              };
          }
          return { ...updated, history: currentHistory };
        });
        
        return nextState;
    });
  };

  const handleUpdateRegionPrompt = (imageId: string, regionId: string, prompt: string) => {
    setImages(prev => prev.map(img => {
      if (img.id !== imageId) return img;
      const newRegions = img.regions.map(r => r.id === regionId ? { ...r, customPrompt: prompt } : r);
      
      const currentHistory = [...img.history];
      if (currentHistory[img.historyIndex]) {
          currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: newRegions };
      }
      return { ...img, regions: newRegions, history: currentHistory };
    }));
  };

  const handleUpdateImagePrompt = (imageId: string, prompt: string) => {
      setImages(prev => prev.map(img => {
          if (img.id !== imageId) return img;
          return { ...img, customPrompt: prompt };
      }));
  };

  const handleToggleSkip = (imageId: string) => {
    setImages(prev => prev.map(img => 
        img.id === imageId ? { ...img, isSkipped: !img.isSkipped } : img
    ));
  };

  const handleDeleteImage = (imageId: string) => {
    setImages(prev => {
      // Release Object URLs for the deleted image BEFORE removing from state
      const deleted = prev.find(img => img.id === imageId);
      if (deleted) cleanupImageUrls(deleted);

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

  const handleClearAllImages = () => {
    // Release ALL Object URLs before clearing
    setImages(prev => {
      prev.forEach(img => cleanupImageUrls(img));
      return prev; // Return same ref; the setImages below replaces it
    });
    setImages([]);
    setSelectedImageId(null);
    setSelectedRegionId(null);
  };

  const handleManualPatchUpdate = (imageId: string, regionId: string, base64: string) => {
    // Convert incoming base64 to Object URL (from paste or PatchEditor save)
    const objectUrl = base64.startsWith('data:') ? 
      (() => { const url = URL.createObjectURL(dataURLtoBlob(base64)); return url; })() : 
      base64;

    setImages(prev => {
        return prev.map(img => {
            if (img.id !== imageId) return img;
            
            let updatedRegions: Region[];
            if (regionId === 'manual-full-image') {
               const fullRegion: Region = {
                   id: crypto.randomUUID(),
                   x: 0, y: 0, width: 100, height: 100,
                   type: 'rect',
                   status: 'completed',
                    processedImageBase64: objectUrl,
                    source: 'manual' as const,
                    anchorX: 0, anchorY: 0, anchorWidth: 100, anchorHeight: 100,
                };
               updatedRegions = [...img.regions, fullRegion];
            } else {
               // Release old region URL before replacing
               const oldRegion = img.regions.find(r => r.id === regionId);
               if (oldRegion?.processedImageBase64) releaseObjectURL(oldRegion.processedImageBase64);

               updatedRegions = img.regions.map(r => 
                  r.id === regionId ? { ...r, processedImageBase64: objectUrl, status: 'completed' as const, anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height } : r
               );
            }

            const currentHistory = [...img.history];
            if (currentHistory[img.historyIndex]) {
                currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
            }

            return { ...img, regions: updatedRegions, history: currentHistory };
        });
    });
  };

  // --- HISTORY ACTIONS ---

  const handleApplyResultAsOriginal = (imageId: string, stitchedUrl: string) => {
      setImages(prev => prev.map(img => {
          if (img.id !== imageId) return img;

          const newState: ImageHistoryState = {
              previewUrl: stitchedUrl,
              regions: [],
              finalResultUrl: undefined,
              width: img.originalWidth,
              height: img.originalHeight,
              fullAiResultUrl: undefined 
          };

          let newHistory = img.history.slice(0, img.historyIndex + 1);
          newHistory.push(newState);
          
          // Cap history at MAX_HISTORY_ENTRIES — release URLs for evicted entries
          while (newHistory.length > MAX_HISTORY_ENTRIES) {
              const evicted = newHistory.shift();
              if (evicted) {
                  releaseObjectURL(evicted.previewUrl);
                  releaseObjectURL(evicted.fullAiResultUrl);
                  releaseObjectURL(evicted.finalResultUrl);
                  evicted.regions.forEach(r => {
                      releaseObjectURL(r.processedImageBase64);
                      releaseObjectURL(r.restoreMaskBase64);
                  });
              }
          }
          
          const newIndex = Math.min(img.historyIndex + 1, newHistory.length - 1);

          return {
              ...img,
              previewUrl: newState.previewUrl,
              regions: newState.regions,
              finalResultUrl: undefined,
              fullAiResultUrl: undefined,
              history: newHistory,
              historyIndex: newIndex
          };
      }));
      setViewMode('original');
  };

  const handleUndoImage = (imageId: string) => {
      setImages(prev => prev.map(img => {
          if (img.id !== imageId || img.historyIndex <= 0) return img;

          const newIndex = img.historyIndex - 1;
          const prevState = img.history[newIndex];

          return {
              ...img,
              previewUrl: prevState.previewUrl,
              regions: prevState.regions,
              originalWidth: prevState.width,
              originalHeight: prevState.height,
              finalResultUrl: prevState.finalResultUrl,
              fullAiResultUrl: prevState.fullAiResultUrl,
              historyIndex: newIndex
          };
      }));
  };

  const handleRedoImage = (imageId: string) => {
      setImages(prev => prev.map(img => {
          if (img.id !== imageId || img.historyIndex >= img.history.length - 1) return img;

          const newIndex = img.historyIndex + 1;
          const nextState = img.history[newIndex];

          return {
              ...img,
              previewUrl: nextState.previewUrl,
              regions: nextState.regions,
              originalWidth: nextState.width,
              originalHeight: nextState.height,
              finalResultUrl: nextState.finalResultUrl,
              fullAiResultUrl: nextState.fullAiResultUrl,
              historyIndex: newIndex
          };
      }));
  };

  return {
    images,
    setImages,
    selectedImage,
    selectedImageId,
    selectedRegionId,
    setSelectedRegionId,
    viewMode,
    setViewMode,
    addImageFiles,
    uploadProgress,
    handleSelectImage,
    handleUpdateRegions,
    handleUpdateRegionPrompt,
    handleUpdateImagePrompt,
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages, 
    handleManualPatchUpdate,
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage
  };
}

// Helper: convert data URL to Blob (used for paste/patch editor save)
function dataURLtoBlob(dataURL: string): Blob {
  const [header, data] = dataURL.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
