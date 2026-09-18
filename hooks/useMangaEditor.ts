import { useCallback, useEffect, useRef, useState } from 'react';
import { AppConfig, Region, UploadedImage } from '../types';
import { loadImage, cropRegion, releaseObjectURL } from '../services/imageUtils';
import { recognizeText } from '../services/detectionService';
import { translateEditorRegions } from '../services/editorTranslate';
import {
  compositeRegionPatch,
  regionNeedsComposite,
  ErasedCacheEntry,
} from '../services/mangaEditor';

export type EraseScope = 'all' | 'bubbleOnly' | 'selected';
export type RestoreScope = 'all' | 'textFree' | 'selected';

interface UseMangaEditorParams {
  images: UploadedImage[];
  updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void;
  config: AppConfig;
  setErrorMsg: (msg: string | null) => void;
}

const RECOMPOSITE_DEBOUNCE_MS = 400;

/**
 * State engine for the in-place manga text editor (editor workflow mode).
 *
 * All editor data lives on Region fields (editorText / editorErased /
 * editorStyle / editorBrushUrl) so it survives re-renders and is captured by
 * image history. This hook only owns two volatile things: the erased-base
 * cache (purely a performance cache — rebuildable at any time) and per-region
 * debounce timers.
 */
export function useMangaEditor({ images, updateImage, config, setErrorMsg }: UseMangaEditorParams) {
  const [busy, setBusy] = useState(false);
  // regionId → last resolved font size (auto-fit or manual), for panel display.
  const [computedFontSizes, setComputedFontSizes] = useState<Record<string, number>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const configRef = useRef(config);
  configRef.current = config;

  // regionId → { geomKey, url } — cache of the erased base crop.
  const erasedCacheRef = useRef<Map<string, ErasedCacheEntry>>(new Map());
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Release all cached erased bases on unmount.
  useEffect(() => {
    const cache = erasedCacheRef.current;
    const timers = debounceRef.current;
    return () => {
      cache.forEach(e => releaseObjectURL(e.url));
      cache.clear();
      timers.forEach(t => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const getImage = useCallback(
    (imageId: string) => imagesRef.current.find(i => i.id === imageId),
    []
  );

  /**
   * Rebuild the region's patch from its editor fields and write the result
   * into processedImageUrl (status 'completed'), so the existing result /
   * stitch / download machinery picks it up unchanged. When nothing remains
   * to composite, restores the region to its un-edited state.
   *
   * `regionOverride` passes the just-committed region state, because
   * imagesRef lags one React commit behind updateImage — without it the
   * first recomposite after a state flip would read the stale editor fields.
   */
  const recompositeRegion = useCallback(async (imageId: string, regionId: string, regionOverride?: Region) => {
    const img = getImage(imageId);
    const region = regionOverride ?? img?.regions.find(r => r.id === regionId);
    if (!img || !region) return;

    try {
      const imageEl = await loadImage(img.previewUrl);
      const result = await compositeRegionPatch(
        imageEl,
        region,
        erasedCacheRef.current,
        configRef.current.enableVerticalTextDefault,
        configRef.current.editorBackendUrl
      );
      const url = result?.url ?? null;

      // Publish the resolved font size so the panel can show the auto-fit
      // value as a reference for manual sizing.
      setComputedFontSizes(prev => {
        const next = { ...prev };
        if (result?.fontSize) next[regionId] = result.fontSize;
        else delete next[regionId];
        return next;
      });

      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => {
          if (r.id !== regionId) return r;
          if (url && result) {
            if (r.processedImageUrl && r.processedImageUrl !== url) {
              releaseObjectURL(r.processedImageUrl);
            }
            return {
              ...r,
              processedImageUrl: url,
              status: 'completed' as const,
              editorComposited: true,
              patchMarginX: result.marginXPct,
              patchMarginY: result.marginYPct,
              anchorX: r.x,
              anchorY: r.y,
              anchorWidth: r.width,
              anchorHeight: r.height,
            };
          }
          // Nothing left to composite: revert only patches WE produced.
          if (r.editorComposited) {
            if (r.processedImageUrl) releaseObjectURL(r.processedImageUrl);
            return {
              ...r,
              processedImageUrl: undefined,
              status: 'pending' as const,
              editorComposited: false,
              patchMarginX: undefined,
              patchMarginY: undefined,
            };
          }
          return r;
        }),
      }));
    } catch (e: any) {
      console.error('Editor composite failed', e);
      setErrorMsg('Editor composite failed: ' + (e?.message || e));
    }
  }, [getImage, updateImage, setErrorMsg]);

  const scheduleRecomposite = useCallback((imageId: string, regionId: string, delay = RECOMPOSITE_DEBOUNCE_MS) => {
    const key = `${imageId}|${regionId}`;
    const existing = debounceRef.current.get(key);
    if (existing) clearTimeout(existing);
    debounceRef.current.set(key, setTimeout(() => {
      debounceRef.current.delete(key);
      recompositeRegion(imageId, regionId);
    }, delay));
  }, [recompositeRegion]);

  /** Merge editor field updates into a region and schedule a recomposite. */
  const updateEditorRegion = useCallback((
    imageId: string,
    regionId: string,
    updates: Partial<Pick<Region, 'editorText' | 'editorErased' | 'editorBrushUrl'>> & { editorStyle?: Region['editorStyle'] }
  ) => {
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => {
        if (r.id !== regionId) return r;
        const next: Region = { ...r, ...updates };
        if (updates.editorStyle !== undefined) {
          next.editorStyle = { ...r.editorStyle, ...updates.editorStyle };
        }
        return next;
      }),
    }));
    scheduleRecomposite(imageId, regionId);
  }, [updateImage, scheduleRecomposite]);

  /** Replace (or clear) the brush-stroke layer of a region. */
  const setBrushLayer = useCallback((imageId: string, regionId: string, brushUrl: string | null) => {
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => {
        if (r.id !== regionId) return r;
        if (r.editorBrushUrl && r.editorBrushUrl !== brushUrl) releaseObjectURL(r.editorBrushUrl);
        return { ...r, editorBrushUrl: brushUrl ?? undefined };
      }),
    }));
    scheduleRecomposite(imageId, regionId, 0);
  }, [updateImage, scheduleRecomposite]);

  const pickEraseTargets = useCallback((
    img: UploadedImage,
    scope: EraseScope,
    selectedRegionId?: string | null
  ): Region[] => {
    if (scope === 'selected') {
      const r = img.regions.find(r => r.id === selectedRegionId);
      return r && !r.editorErased ? [r] : [];
    }
    return img.regions.filter(r => {
      if (r.contextOnly || r.editorErased) return false;
      if (scope === 'bubbleOnly') return r.detectedClass === 'text_bubble';
      return true; // 'all' — manual boxes + text_bubble + text_free
    });
  }, []);

  /** Erase the original text inside regions (flood-fill, frontend-only). */
  const eraseRegions = useCallback(async (
    imageId: string,
    scope: EraseScope,
    selectedRegionId?: string | null
  ) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = pickEraseTargets(img, scope, selectedRegionId);
    if (targets.length === 0) return;

    setBusy(true);
    try {
      // Flag first so recomposite reads consistent state.
      const ids = new Set(targets.map(t => t.id));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => ids.has(r.id) ? { ...r, editorErased: true } : r),
      }));
      // Recomposite sequentially (erasure is CPU-bound per region). Pass the
      // flipped region explicitly — the store commit lags behind updateImage.
      for (const t of targets) {
        await recompositeRegion(imageId, t.id, { ...t, editorErased: true });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, pickEraseTargets, recompositeRegion, updateImage]);

  /** Undo erasure: 'all' restores every region, 'textFree' only text_free,
   *  'selected' only the selected region. Typeset text is kept. */
  const restoreErase = useCallback(async (
    imageId: string,
    scope: RestoreScope,
    selectedRegionId?: string | null
  ) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r => {
      if (!r.editorErased) return false;
      if (scope === 'selected') return r.id === selectedRegionId;
      if (scope === 'textFree') return r.detectedClass === 'text_free';
      return true;
    });
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const ids = new Set(targets.map(t => t.id));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => ids.has(r.id) ? { ...r, editorErased: false } : r),
      }));
      // Pass the flipped region explicitly — the store commit lags behind
      // updateImage, so reading it here would see the pre-restore state.
      for (const t of targets) {
        await recompositeRegion(imageId, t.id, { ...t, editorErased: false });
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * Auto-translate one image: a single vision-AI call over all editable
   * regions (annotated full image + numbered skeleton). The returned source
   * text doubles as OCR (→ ocrText); the translation lands in editorText and
   * the region is erased so the typeset composite shows cleanly. Regions the
   * AI flags as skip (sfx / decorations / misdetections) are left untouched.
   */
  const translateImageRegions = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r => !r.contextOnly);
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const imageEl = await loadImage(img.previewUrl);
      const results = await translateEditorRegions(imageEl, targets, configRef.current);

      // Compute post-update region objects up-front (updaters must stay pure,
      // and recomposite needs them explicitly — the store commit lags behind
      // updateImage). editorStyle is left untouched: undefined fontSize /
      // isVertical mean the layout engine auto-fits size and direction for
      // the new text.
      const translated: Region[] = [];
      for (const r of targets) {
        const res = results.get(r.id);
        if (!res || res.skip || !res.zh?.trim()) continue;
        translated.push({
          ...r,
          ocrText: res.source ?? r.ocrText,
          editorText: res.zh,
          editorErased: true,
          // AI judges the original's direction; when it doesn't say, keep the
          // existing style (undefined = layout auto-heuristic).
          editorStyle: res.vertical === undefined
            ? r.editorStyle
            : { ...r.editorStyle, isVertical: res.vertical },
        });
      }
      if (translated.length === 0) throw new Error('AI 没有翻译任何区域（可能全部被判定为拟声词/误检）');

      const byId = new Map(translated.map(t => [t.id, t]));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => byId.get(r.id) ?? r),
      }));
      // Typeset composite per translated region (erasure included), sequential.
      for (const nr of translated) {
        await recompositeRegion(imageId, nr.id, nr);
      }
    } catch (e: any) {
      console.error('Auto translate failed', e);
      setErrorMsg(e?.message || '翻译失败');
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage, setErrorMsg]);

  /**
   * Batch variant: translate every loaded image that has editable regions,
   * sequentially. Per-image failures surface via setErrorMsg but do not
   * abort the batch.
   */
  const translateAllImages = useCallback(async () => {
    if (busy) return;
    const ids = imagesRef.current
      .filter(img => img.regions.some(r => !r.contextOnly))
      .map(img => img.id);
    for (const id of ids) {
      await translateImageRegions(id);
    }
  }, [busy, translateImageRegions]);

  /** OCR every non-context region that doesn't have text yet. */
  const ocrAllRegions = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !(r.editorText ?? r.ocrText)?.trim()
    );
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const imageEl = await loadImage(img.previewUrl);
      for (const region of targets) {
        try {
          updateImage(imageId, current => ({
            ...current,
            regions: current.regions.map(r => r.id === region.id ? { ...r, isOcrLoading: true } : r),
          }));
          const cropUrl = await cropRegion(imageEl, region);
          const text = await recognizeText(cropUrl, configRef.current);
          releaseObjectURL(cropUrl);
          updateImage(imageId, current => ({
            ...current,
            regions: current.regions.map(r => r.id === region.id ? { ...r, ocrText: text, isOcrLoading: false } : r),
          }));
          // OCR text becomes the typeset source — refresh the patch.
          await recompositeRegion(imageId, region.id);
        } catch (e: any) {
          console.error('OCR failed for region', region.id, e);
          updateImage(imageId, current => ({
            ...current,
            regions: current.regions.map(r => r.id === region.id ? { ...r, isOcrLoading: false } : r),
          }));
        }
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * Called after regions change on the canvas (drag/resize in editor mode):
   * any region whose editor content exists but whose composite anchor no
   * longer matches its geometry gets re-laid-out and re-rendered.
   * `regionsOverride` passes the just-committed region array, because
   * imagesRef lags one React commit behind the canvas' onUpdateRegions.
   */
  const resyncEditedRegions = useCallback((imageId: string, regionsOverride?: Region[]) => {
    const img = getImage(imageId);
    const regions = regionsOverride ?? img?.regions;
    if (!regions) return;
    for (const r of regions) {
      if (!regionNeedsComposite(r)) continue;
      const moved =
        r.anchorX === undefined ||
        Math.abs((r.anchorX ?? 0) - r.x) > 0.01 ||
        Math.abs((r.anchorY ?? 0) - r.y) > 0.01 ||
        Math.abs((r.anchorWidth ?? 0) - r.width) > 0.01 ||
        Math.abs((r.anchorHeight ?? 0) - r.height) > 0.01;
      if (moved) scheduleRecomposite(imageId, r.id, 600);
    }
  }, [getImage, scheduleRecomposite]);

  /**
   * Build the region's composite WITHOUT the brush layer — used as the base
   * image under the brush painter. Returns null when nothing but the brush
   * would be composited (caller falls back to the plain crop). The returned
   * Object URL is owned by the caller.
   */
  const buildBrushBase = useCallback(async (imageId: string, regionId: string): Promise<string | null> => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region) return null;
    const noBrush: Region = { ...region, editorBrushUrl: undefined };
    if (!regionNeedsComposite(noBrush)) return null;
    const imageEl = await loadImage(img.previewUrl);
    // allowMargin=false: the painter canvas must stay exactly crop-sized so
    // brush coordinates map 1:1 onto the crop area of the final patch.
    const result = await compositeRegionPatch(
      imageEl,
      noBrush,
      erasedCacheRef.current,
      configRef.current.enableVerticalTextDefault,
      configRef.current.editorBackendUrl,
      false
    );
    return result?.url ?? null;
  }, [getImage]);

  return {
    busy,
    computedFontSizes,
    updateEditorRegion,
    setBrushLayer,
    eraseRegions,
    restoreErase,
    ocrAllRegions,
    translateImageRegions,
    translateAllImages,
    resyncEditedRegions,
    buildBrushBase,
  };
}
