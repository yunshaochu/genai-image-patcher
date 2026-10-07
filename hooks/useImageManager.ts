
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { UploadedImage, Region, ImageHistoryState, PerformanceMode, RedrawIntent, ViewMode } from '../types';
import { readFileAsDataURL, readFileAsObjectURL, loadImage, naturalSortCompare, stitchImage, cropRegion, compressImage, generateThumbnail, releaseObjectURL, cleanupImageUrls, base64ToObjectURLAsync, MAX_HISTORY_ENTRIES, PREVIEW_MAX_PX } from '../services/imageUtils';
import { saveSession, loadSession, clearSession, pruneEraseRecordsExcept } from '../services/sessionStore';

// ViewMode now lives in types.ts (it grew the per-workflow work tabs 重绘 / 修补).

// Normalized store: byId for O(1) lookups, order for stable iteration.
// Replaces the previous setImages(prev => prev.map(...)) pattern that did O(N)
// reference copies on every single-region change.
type ImageStore = {
  byId: Record<string, UploadedImage>;
  order: string[];
};

const EMPTY_STORE: ImageStore = { byId: {}, order: [] };

/** 提示词模块的三个 tab 对应的字段（见 prompts 模块 / RedrawIntent）。 */
export type PromptField = 'translate' | 'erase' | 'free';

/** 该 tab 的选区/图片提示词 patch（显式写法，避免动态 key 破坏类型）。 */
const promptPatch = (field: PromptField, value: string): Partial<Region & UploadedImage> =>
  field === 'erase' ? { customPromptErase: value }
    : field === 'free' ? { customPromptFree: value }
      : { customPrompt: value };

export function useImageManager(performanceMode: PerformanceMode, enableSessionPersistence: boolean = false) {
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

  // ---------------- Session persistence (survives tab discard / reload) ----------------
  // Everything in this hook is in-memory blob: URLs, so Chrome/Edge discarding
  // a background tab (Memory Saver / sleeping tabs) wipes out unsaved work.
  // We mirror the store into IndexedDB: debounced on every change, plus an
  // immediate flush when the page is hidden / frozen / unloaded.
  const restoredRef = useRef(false); // gates autosave until restore finished
  const savedRefsRef = useRef<Map<string, UploadedImage>>(new Map()); // id → last persisted object ref
  const storeRef = useRef(store);
  const selectedIdRef = useRef(selectedImageId);
  const savingRef = useRef(false);
  const saveQueuedRef = useRef(false);
  const persistenceEnabledRef = useRef(enableSessionPersistence);

  useEffect(() => {
    storeRef.current = store;
    selectedIdRef.current = selectedImageId;
  });

  // Track the persistence switch. Turning it OFF wipes the persisted session
  // immediately so no disk space is held — with persistence disabled there is
  // nothing to restore anyway.
  useEffect(() => {
    persistenceEnabledRef.current = enableSessionPersistence;
    if (!enableSessionPersistence) {
      savedRefsRef.current.clear();
      void clearSession().catch((e) => console.error('[session] Failed to clear session', e));
    }
  }, [enableSessionPersistence]);

  // Restore previous session once on mount (only when persistence is enabled).
  useEffect(() => {
    let cancelled = false;
    if (!enableSessionPersistence) {
      restoredRef.current = true;
      return;
    }
    loadSession()
      .then((session) => {
        if (cancelled) return;
        if (session && session.images.length > 0) {
          const byId: Record<string, UploadedImage> = {};
          const order: string[] = [];
          for (const img of session.images) {
            byId[img.id] = img;
            order.push(img.id);
          }
          setStore({ byId, order });
          setSelectedImageId(session.selectedImageId);
          console.info(`[session] Restored ${session.images.length} image(s) from previous session`);
        }
        // 擦除底图缓存按图库对账：图库恢复出来的那些留着（下次就不用再泛洪），
        // 已经对不上任何图的（图片被删、换过图库）当场丢掉，别一直占着 IndexedDB。
        const restoredIds = session?.images.map((img) => img.id) ?? [];
        void pruneEraseRecordsExcept(restoredIds)
          .catch((e) => console.error('[session] Failed to prune erase cache', e));
      })
      .catch((e) => console.error('[session] Failed to restore session', e))
      .finally(() => {
        if (!cancelled) restoredRef.current = true;
      });
    return () => { cancelled = true; };
    // Mount-only: config is read synchronously from localStorage, so the
    // initial value of enableSessionPersistence is the authoritative one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSave = useCallback(async () => {
    if (!restoredRef.current || !persistenceEnabledRef.current) return;
    if (savingRef.current) {
      saveQueuedRef.current = true;
      return;
    }
    savingRef.current = true;
    try {
      do {
        saveQueuedRef.current = false;
        await saveSession(storeRef.current, selectedIdRef.current, savedRefsRef.current);
      } while (saveQueuedRef.current);
    } catch (e) {
      console.error('[session] Autosave failed', e);
    } finally {
      savingRef.current = false;
    }
  }, []);

  // Debounced save on every store/selection change.
  useEffect(() => {
    if (!restoredRef.current) return;
    const timer = setTimeout(() => { void doSave(); }, 1500);
    return () => clearTimeout(timer);
  }, [store, selectedImageId, doSave]);

  // Flush immediately when the tab is hidden / frozen (about to be discarded) / unloaded.
  useEffect(() => {
    const flush = () => { void doSave(); };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('freeze', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('freeze', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [doSave]);

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

  const getStitchedUrl = useCallback(async (image: UploadedImage, honorPatchOverflow = true): Promise<string> => {
    // The overflow flag changes the output pixels, so it is part of the cache
    // key: switching workflows must not hand back the other variant's URL.
    const signature = `${honorPatchOverflow ? 'ovf' : 'clip'}|${computeStitchSignature(image)}`;
    const cached = stitchCacheRef.current.get(image.id);
    if (cached && cached.signature === signature) {
      return cached.url;
    }
    const url = await stitchImage(image.previewUrl, image.regions, honorPatchOverflow);
    if (cached) releaseObjectURL(cached.url);
    stitchCacheRef.current.set(image.id, { signature, url });
    return url;
  }, []);

  // NOTE: there used to be a guard here that bounced viewMode back to
  // 'original' whenever the selected image had nothing to show in the result
  // view. The result tab is now always rendered (consistent tab set across
  // images, see App.tsx) and shows the untouched original when there is no
  // patch yet, so the guard only made the tab look broken — clicking it flipped
  // the state and was reverted by this effect in the same commit.

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
          // Compress preview: output is now also an Object URL. The cap is
          // shared with previewPixelSize(), which converts the original's
          // pixels into the preview's — the space region patches (and thus
          // typeset font sizes) are composited in.
          previewUrl = await compressImage(originalUrl, { maxWidth: PREVIEW_MAX_PX, maxHeight: PREVIEW_MAX_PX, quality: 0.8 });
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
    // viewMode is intentionally preserved so the "已完成" tab stays selected
    // when switching images; the guard effect above reverts it if the newly
    // selected image has no result to show.
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

  const handleUpdateRegionPrompt = useCallback((imageId: string, regionId: string, prompt: string, field: PromptField = 'translate') => {
    const patch = promptPatch(field, prompt);
    updateImage(imageId, (img) => {
      const newRegions = img.regions.map((r) => (r.id === regionId ? { ...r, ...patch } : r));
      const currentHistory = [...img.history];
      if (currentHistory[img.historyIndex]) {
        currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: newRegions };
      }
      return { ...img, regions: newRegions, history: currentHistory };
    });
  }, [updateImage]);

  const handleUpdateImagePrompt = useCallback((imageId: string, prompt: string, field: PromptField = 'translate') => {
    const patch = promptPatch(field, prompt);
    updateImage(imageId, (img) => ({ ...img, ...patch }));
  }, [updateImage]);

  /** 记录某格的重绘场景覆盖（undefined = 清除覆盖，跟随全局默认场景）。 */
  const handleUpdateRegionIntent = useCallback((imageId: string, regionId: string, intent: RedrawIntent | undefined) => {
    updateImage(imageId, (img) => {
      const newRegions = img.regions.map((r) => (r.id === regionId ? { ...r, redrawIntent: intent } : r));
      const currentHistory = [...img.history];
      if (currentHistory[img.historyIndex]) {
        currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: newRegions };
      }
      return { ...img, regions: newRegions, history: currentHistory };
    });
  }, [updateImage]);

  /** 全图遮罩模式下的图片级场景覆盖（undefined = 清除覆盖）。 */
  const handleUpdateImageIntent = useCallback((imageId: string, intent: RedrawIntent | undefined) => {
    updateImage(imageId, (img) => ({ ...img, redrawIntent: intent }));
  }, [updateImage]);

  /** 手动修正某格译文（脱离提示词字段后的独立槽）。 */
  const handleUpdateRegionTranslation = useCallback((imageId: string, regionId: string, translation: string) => {
    updateImage(imageId, (img) => ({
      ...img,
      regions: img.regions.map((r) => (r.id === regionId ? { ...r, customTranslation: translation } : r)),
    }));
  }, [updateImage]);

  /** 手动修正图片级译文（全图遮罩模式）。 */
  const handleUpdateImageTranslation = useCallback((imageId: string, translation: string) => {
    updateImage(imageId, (img) => ({ ...img, customTranslation: translation }));
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
    savedRefsRef.current.clear();
    void clearSession(); // wipe the persisted session so it isn't restored next launch
    setSelectedImageId(null);
    setSelectedRegionId(null);
  }, []);

  /**
   * Replace the whole gallery with `newImages` (work-state import).
   *
   * The previous images' Object URLs are revoked and the stitch cache dropped.
   * `savedRefsRef` is deliberately left untouched: the next autosave then sees
   * the old ids as removed (deleting their IndexedDB records instead of
   * orphaning them) and re-serializes every imported image, because imported
   * objects are always fresh references.
   */
  const replaceStore = useCallback((newImages: UploadedImage[], newSelectedId: string | null) => {
    setStore((s) => {
      for (const id of s.order) cleanupImageUrls(s.byId[id]);
      const byId: Record<string, UploadedImage> = {};
      const order: string[] = [];
      for (const img of newImages) {
        byId[img.id] = img;
        order.push(img.id);
      }
      return { byId, order };
    });
    stitchCacheRef.current.forEach((v) => releaseObjectURL(v.url));
    stitchCacheRef.current.clear();
    setSelectedImageId(newSelectedId ?? newImages[0]?.id ?? null);
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
        appliedAsOriginal: true,
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
        appliedAsOriginal: true,
        // 画面整个换掉了（选区也清空）：旧的自动检测记忆描述的是上一张图，留着会
        // 让这页在整批检测里被永久跳过。清空 = 下次整批检测会重新看这张新图。
        detectionStatus: undefined,
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
        appliedAsOriginal: prevState.appliedAsOriginal,
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
        appliedAsOriginal: nextState.appliedAsOriginal,
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
    handleUpdateRegionIntent,
    handleUpdateImageIntent,
    handleUpdateRegionTranslation,
    handleUpdateImageTranslation,
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages,
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage,
    getStitchedUrl,
    replaceStore
  };
}
