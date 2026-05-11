
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { UploadedImage, Region, ImageHistoryState, PerformanceMode } from '../types';
import { readFileAsDataURL, readFileAsObjectURL, loadImage, naturalSortCompare, stitchImage, cropRegion, compressImage, generateThumbnail, releaseObjectURL, cleanupImageUrls, base64ToObjectURLAsync, MAX_HISTORY_ENTRIES } from '../services/imageUtils';

type ViewMode = 'original' | 'result';

// Normalized store: byId for O(1) lookups, order for stable iteration.
// Replaces the previous setImages(prev => prev.map(...)) pattern that did O(N)
// reference copies on every single-region change.
type ImageStore = {
  byId: Record<string, UploadedImage>;
  order: string[];
};

const EMPTY_STORE: ImageStore = { byId: {}, order: [] };

export function useImageManager(performanceMode: PerformanceMode) {
  const [store, setStore] = useState<ImageStore>(EMPTY_STORE);
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('original');
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number } | null>(null);

  // Derived array view for consumers that iterate (renderers, batch ops).
  // useMemo so consumers' useEffect deps remain stable across renders that
  // don't actually touch image data.
  const images = useMemo<UploadedImage[]>(
    () => store.order.map((id) => store.byId[id]).filter(Boolean),
    [store]
  );

  // O(1) selected image lookup — was O(N) Array.prototype.find before.
  const selectedImage = selectedImageId ? store.byId[selectedImageId] : undefined;

  // -------------------- Normalized mutation helpers --------------------

  /** Update a single image by id. If `updater` returns the same reference,
   * the store is not changed (cheap no-op). */
  const updateImage = useCallback(
    (id: string, updater: (img: UploadedImage) => UploadedImage) => {
      setStore((s) => {
        const prev = s.byId[id];
        if (!prev) return s;
        const next = updater(prev);
        if (next === prev) return s;
        return { byId: { ...s.byId, [id]: next }, order: s.order };
      });
    },
    []
  );

  /** Apply `updater` to every image. */
  const updateAllImages = useCallback(
    (updater: (img: UploadedImage) => UploadedImage) => {
      setStore((s) => {
        const newById: Record<string, UploadedImage> = {};
        let changed = false;
        for (const id of s.order) {
          const prev = s.byId[id];
          const next = updater(prev);
          if (next !== prev) changed = true;
          newById[id] = next;
        }
        return changed ? { byId: newById, order: s.order } : s;
      });
    },
    []
  );

  // ---------------- Standard-mode stitch result cache ----------------
  // handleDownload / handleApplyAsOriginalWrapper / handleDownloadAllZip used to
  // re-run stitchImage on every click. Cache by signature so repeated downloads
  // of the same state are instant. Inverted mode already keeps finalResultUrl
  // eagerly on the image, so this cache only covers standard mode.
  const stitchCacheRef = useRef<Map<string, { signature: string; url: string }>>(new Map());

  const computeStitchSignature = (image: UploadedImage): string => {
    const parts: string[] = [image.previewUrl];
    for (const r of image.regions) {
      if (r.status !== 'completed' || !r.processedImageUrl) continue;
      parts.push(
        r.id,
        r.processedImageUrl,
        `${r.x},${r.y},${r.width},${r.height}`,
        `${r.anchorX ?? r.x},${r.anchorY ?? r.y},${r.anchorWidth ?? r.width},${r.anchorHeight ?? r.height}`,
        r.restoreMaskUrl || '',
        // restoreBoxes is small (a handful of rects); JSON.stringify is cheap here.
        r.restoreBoxes ? JSON.stringify(r.restoreBoxes) : ''
      );
    }
    return parts.join('|');
  };

  const evictStitchCache = (imageId: string) => {
    const cached = stitchCacheRef.current.get(imageId);
    if (cached) {
      releaseObjectURL(cached.url);
      stitchCacheRef.current.delete(imageId);
    }
  };

  const getStitchedUrl = useCallback(async (image: UploadedImage): Promise<string> => {
    const signature = computeStitchSignature(image);
    const cached = stitchCacheRef.current.get(image.id);
    if (cached && cached.signature === signature) {
      return cached.url;
    }
    const url = await stitchImage(image.previewUrl, image.regions);
    if (cached) releaseObjectURL(cached.url);
    stitchCacheRef.current.set(image.id, { signature, url });
    return url;
  }, []);

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
      let firstAddedId: string | null = null;
      setStore((s) => {
        const mergedById: Record<string, UploadedImage> = { ...s.byId };
        for (const img of newImages) mergedById[img.id] = img;
        const merged: UploadedImage[] = [...s.order.map((id) => s.byId[id]), ...newImages];
        merged.sort(naturalSortCompare);
        const newOrder = merged.map((m) => m.id);
        return { byId: mergedById, order: newOrder };
      });
      firstAddedId = newImages[0].id;
      if (!selectedImageId && firstAddedId) {
        handleSelectImage(firstAddedId);
      }
    }
    setUploadProgress(null);
  };

  const handleSelectImage = useCallback((id: string) => {
    setSelectedImageId(id);
    setSelectedRegionId(null);
    setViewMode('original');
  }, []);

  const handleUpdateRegions = useCallback((imageId: string, regions: Region[]) => {
    updateImage(imageId, (img) => {
      const currentHistory = [...img.history];
      if (currentHistory[img.historyIndex]) {
        currentHistory[img.historyIndex] = {
          ...currentHistory[img.historyIndex],
          regions: regions,
        };
      }
      return { ...img, regions, history: currentHistory };
    });
  }, [updateImage]);

  const handleUpdateRegionPrompt = useCallback((imageId: string, regionId: string, prompt: string) => {
    updateImage(imageId, (img) => {
      const newRegions = img.regions.map((r) => (r.id === regionId ? { ...r, customPrompt: prompt } : r));
      const currentHistory = [...img.history];
      if (currentHistory[img.historyIndex]) {
        currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: newRegions };
      }
      return { ...img, regions: newRegions, history: currentHistory };
    });
  }, [updateImage]);

  const handleUpdateImagePrompt = useCallback((imageId: string, prompt: string) => {
    updateImage(imageId, (img) => ({ ...img, customPrompt: prompt }));
  }, [updateImage]);

  const handleToggleSkip = useCallback((imageId: string) => {
    updateImage(imageId, (img) => ({ ...img, isSkipped: !img.isSkipped }));
  }, [updateImage]);

  const handleDeleteImage = useCallback((imageId: string) => {
    setStore((s) => {
      const deleted = s.byId[imageId];
      if (!deleted) return s;
      cleanupImageUrls(deleted);
      evictStitchCache(imageId);

      const newById = { ...s.byId };
      delete newById[imageId];
      const newOrder = s.order.filter((id) => id !== imageId);

      if (selectedImageId === imageId) {
        setSelectedImageId(newOrder[0] ?? null);
      }
      return { byId: newById, order: newOrder };
    });
  }, [selectedImageId]);

  const handleClearAllImages = useCallback(() => {
    setStore((s) => {
      for (const id of s.order) cleanupImageUrls(s.byId[id]);
      return EMPTY_STORE;
    });
    stitchCacheRef.current.forEach((v) => releaseObjectURL(v.url));
    stitchCacheRef.current.clear();
    setSelectedImageId(null);
    setSelectedRegionId(null);
  }, []);

  // --- HISTORY ACTIONS ---

  const handleApplyResultAsOriginal = useCallback((imageId: string, stitchedUrl: string) => {
    updateImage(imageId, (img) => {
      const newState: ImageHistoryState = {
        previewUrl: stitchedUrl,
        regions: [],
        finalResultUrl: undefined,
        width: img.originalWidth,
        height: img.originalHeight,
        fullAiResultUrl: undefined,
      };

      const newHistory = img.history.slice(0, img.historyIndex + 1);
      newHistory.push(newState);

      while (newHistory.length > MAX_HISTORY_ENTRIES) {
        const evicted = newHistory.shift();
        if (evicted) {
          releaseObjectURL(evicted.previewUrl);
          releaseObjectURL(evicted.fullAiResultUrl);
          releaseObjectURL(evicted.finalResultUrl);
          evicted.regions.forEach((r) => {
            releaseObjectURL(r.processedImageUrl);
            releaseObjectURL(r.restoreMaskUrl);
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
        historyIndex: newIndex,
      };
    });
    setViewMode('original');
  }, [updateImage]);

  const handleUndoImage = useCallback((imageId: string) => {
    updateImage(imageId, (img) => {
      if (img.historyIndex <= 0) return img;
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
        historyIndex: newIndex,
      };
    });
  }, [updateImage]);

  const handleRedoImage = useCallback((imageId: string) => {
    updateImage(imageId, (img) => {
      if (img.historyIndex >= img.history.length - 1) return img;
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
        historyIndex: newIndex,
      };
    });
  }, [updateImage]);

  return {
    images,
    imagesById: store.byId,
    updateImage,
    updateAllImages,
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
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage,
    getStitchedUrl
  };
}
