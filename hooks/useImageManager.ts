
import { useState, useEffect, useRef } from 'react';
import { UploadedImage, Region, ImageHistoryState } from '../types';
import { readFileAsDataURL, loadImage, naturalSortCompare, stitchImage, cropRegion } from '../services/imageUtils';

type ViewMode = 'original' | 'result';

export function useImageManager() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('original');

  const selectedImage = images.find((img) => img.id === selectedImageId);

  // Auto-switch view mode when result is ready
  useEffect(() => {
    // If we have completed regions, user might want to see result, but we don't force auto-switch anymore 
    // unless explicit action.
    
    // However, if we cleared the result/regions, switch back to original
    if (!selectedImage?.regions.some(r => r.status === 'completed') && viewMode === 'result') {
      setViewMode('original');
    }
  }, [selectedImage?.regions, viewMode]);

  const addImageFiles = async (fileList: File[]) => {
    const newImages: UploadedImage[] = [];
    const imageFiles = fileList.filter(f => f.type.startsWith('image/') && !f.name.startsWith('.'));
    
    if (imageFiles.length === 0) return;

    for (const file of imageFiles) {
      try {
        const previewUrl = await readFileAsDataURL(file);
        const imgEl = await loadImage(previewUrl);

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
  };

  const handleSelectImage = (id: string) => {
    setSelectedImageId(id);
    setSelectedRegionId(null);
    const target = images.find(img => img.id === id);
    if (target?.regions.some(r => r.status === 'completed')) {
        // If it has results, default to result view is fine, or keep previous logic.
        // Let's default to original to avoid confusion.
        setViewMode('original'); 
    } else {
        setViewMode('original');
    }
  };

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
    setImages([]);
    setSelectedImageId(null);
    setSelectedRegionId(null);
  };

  const handleManualPatchUpdate = (imageId: string, regionId: string, base64: string) => {
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
                   processedImageBase64: base64,
                   source: 'manual'
               };
               updatedRegions = [...img.regions, fullRegion];
            } else {
               updatedRegions = img.regions.map(r => 
                 r.id === regionId ? { ...r, processedImageBase64: base64, status: 'completed' as const } : r
               );
            }

            const currentHistory = [...img.history];
            if (currentHistory[img.historyIndex]) {
                currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
            }

            return { ...img, regions: updatedRegions, history: currentHistory };
        });
    });
    // No auto-stitching
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

          const newHistory = img.history.slice(0, img.historyIndex + 1);
          newHistory.push(newState);
          
          return {
              ...img,
              previewUrl: newState.previewUrl,
              regions: newState.regions,
              finalResultUrl: undefined,
              fullAiResultUrl: undefined,
              history: newHistory,
              historyIndex: newHistory.length - 1
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
