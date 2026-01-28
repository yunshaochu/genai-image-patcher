

import { useState, useEffect, useCallback } from 'react';
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
    if (selectedImage?.finalResultUrl && viewMode === 'original') {
       // Optional: Auto switch behavior can be added here if desired
    }
    if (!selectedImage?.finalResultUrl && viewMode === 'result') {
      setViewMode('original');
    }
  }, [selectedImage?.finalResultUrl, viewMode]);

  const addImageFiles = async (fileList: File[]) => {
    const newImages: UploadedImage[] = [];
    // Filter out hidden files (starting with dot) to prevent system files from being uploaded
    const imageFiles = fileList.filter(f => f.type.startsWith('image/') && !f.name.startsWith('.'));
    
    if (imageFiles.length === 0) return;

    for (const file of imageFiles) {
      try {
        const previewUrl = await readFileAsDataURL(file);
        const imgEl = await loadImage(previewUrl);

        // Initial History State
        const initialState: ImageHistoryState = {
            previewUrl: previewUrl,
            regions: [],
            finalResultUrl: undefined,
            width: imgEl.naturalWidth,
            height: imgEl.naturalHeight
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
    if (target?.finalResultUrl) {
        setViewMode('result');
    } else {
        setViewMode('original');
    }
  };

  const handleUpdateRegions = (imageId: string, regions: Region[]) => {
    setImages(prev => {
        const nextState = prev.map(img => {
          if (img.id !== imageId) return img;
          const updated = { ...img, regions };
          // Note: We do NOT push to history for simple region updates to avoid spamming memory.
          // History is reserved for "Apply" events.
          // However, we should update the CURRENT history head to reflect region changes if we want to save them across undo/redo steps
          // But strict undo/redo usually implies reverting to exact snapshots.
          // For now, let's update the current history tip so if we undo then redo, we get the regions back.
          const currentHistory = [...updated.history];
          if (currentHistory[updated.historyIndex]) {
              currentHistory[updated.historyIndex] = {
                  ...currentHistory[updated.historyIndex],
                  regions: regions
              };
          }
          return { ...updated, history: currentHistory };
        });
        
        // If updating regions on a completed image, re-stitch
        const targetImg = nextState.find(i => i.id === imageId);
        if (targetImg && targetImg.finalResultUrl) {
            stitchImage(targetImg.previewUrl, targetImg.regions).then(stitched => {
                setImages(current => current.map(i => i.id === imageId ? { ...i, finalResultUrl: stitched } : i));
            });
        }
        return nextState;
    });
  };

  const handleUpdateRegionPrompt = (imageId: string, regionId: string, prompt: string) => {
    setImages(prev => prev.map(img => {
      if (img.id !== imageId) return img;
      const newRegions = img.regions.map(r => r.id === regionId ? { ...r, customPrompt: prompt } : r);
      
      // Sync to history tip
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

            // Sync to history tip
            const currentHistory = [...img.history];
            if (currentHistory[img.historyIndex]) {
                currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
            }

            return { ...img, regions: updatedRegions, history: currentHistory };
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

  // --- HISTORY ACTIONS ---

  const handleApplyResultAsOriginal = (imageId: string) => {
      setImages(prev => prev.map(img => {
          if (img.id !== imageId || !img.finalResultUrl) return img;

          // 1. Create New State
          const newState: ImageHistoryState = {
              previewUrl: img.finalResultUrl, // The result becomes the new original
              regions: [], // Clear regions for the new base
              finalResultUrl: undefined,
              width: img.originalWidth, // Assuming dimemsions don't change
              height: img.originalHeight
          };

          // 2. Truncate History (remove future redos)
          const newHistory = img.history.slice(0, img.historyIndex + 1);
          
          // 3. Push New State
          newHistory.push(newState);
          
          // 4. Update Current State
          return {
              ...img,
              previewUrl: newState.previewUrl,
              regions: newState.regions,
              finalResultUrl: undefined, // Reset result
              history: newHistory,
              historyIndex: newHistory.length - 1
          };
      }));
      setViewMode('original'); // Switch back to editor view
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
              finalResultUrl: prevState.finalResultUrl, // Restore result if it existed
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
              historyIndex: newIndex
          };
      }));
  };

  return {
    images,
    setImages, // Exposed for heavy logic in App.tsx
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
    handleUpdateImagePrompt, // Exported
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages,
    handleManualPatchUpdate,
    // History Actions
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage
  };
}