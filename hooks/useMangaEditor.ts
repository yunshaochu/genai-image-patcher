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

/**
 * AI-owned region: completed by the image-generation pipeline, not by the
 * editor. Editor operations (erase / text / brush / OCR / translate) must
 * never touch these — the AI patch always wins. Conversely, editor-completed
 * regions (editorComposited=true) are excluded from AI processing because the
 * AI only picks up pending/failed regions.
 */
const isAiOwned = (r: Region): boolean => r.status === 'completed' && !r.editorComposited;

/**
 * Detected `bubble` boxes of an image (kept as context-only regions). They are
 * handed to the compositor so erasure runs on the whole bubble instead of the
 * bare text box.
 */
const getContextBubbles = (img: UploadedImage): Region[] =>
  img.regions.filter(r => r.detectedClass === 'bubble');

interface UseMangaEditorParams {
  images: UploadedImage[];
  updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void;
  config: AppConfig;
  setErrorMsg: (msg: string | null) => void;
}

const RECOMPOSITE_DEBOUNCE_MS = 200;

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
   * into processedImageUrl. Completion semantics:
   *  - Text written (editorText non-empty) → status 'completed': the patch
   *    joins the result view / stitch / download machinery.
   *  - Erase/brush only (no written text) → stays 'pending': an intermediate
   *    state for typesetting, shown ONLY in the editor canvas tab; the AI
   *    pipeline can still pick the region up and overwrite it (AI wins).
   * When nothing remains to composite, restores the region to its un-edited
   * state.
   *
   * `regionOverride` passes the just-committed region state, because
   * imagesRef lags one React commit behind updateImage — without it the
   * first recomposite after a state flip would read the stale editor fields.
   */
  const recompositeRegion = useCallback(async (imageId: string, regionId: string, regionOverride?: Region) => {
    const img = getImage(imageId);
    const region = regionOverride ?? img?.regions.find(r => r.id === regionId);
    if (!img || !region) return;
    if (isAiOwned(region)) return;

    try {
      const imageEl = await loadImage(img.previewUrl);
      const result = await compositeRegionPatch(
        imageEl,
        region,
        erasedCacheRef.current,
        configRef.current.enableVerticalTextDefault,
        configRef.current.pythonBackendUrl,
        getContextBubbles(img)
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

      // Only explicitly written text makes the region "final". The OCR
      // fallback (ocrText) still renders in the editor tab, but the region
      // stays pending until the user confirms text into editorText.
      const hasWrittenText = !!region.editorText?.trim();

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
              status: hasWrittenText ? ('completed' as const) : ('pending' as const),
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
    const target = getImage(imageId)?.regions.find(r => r.id === regionId);
    if (target && isAiOwned(target)) return;
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => {
        if (r.id !== regionId) return r;
        const next: Region = { ...r, ...updates };
        // Typing text into a frozen region is an implicit unfreeze — the
        // held-back translation is superseded by the user's own text.
        if (updates.editorText?.trim()) next.editorFrozenText = undefined;
        if (updates.editorStyle !== undefined) {
          next.editorStyle = { ...r.editorStyle, ...updates.editorStyle };
        }
        return next;
      }),
    }));
    scheduleRecomposite(imageId, regionId);
  }, [getImage, updateImage, scheduleRecomposite]);

  /** Replace (or clear) the brush-stroke layer of a region. */
  const setBrushLayer = useCallback((imageId: string, regionId: string, brushUrl: string | null) => {
    const target = getImage(imageId)?.regions.find(r => r.id === regionId);
    if (target && isAiOwned(target)) return;
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => {
        if (r.id !== regionId) return r;
        if (r.editorBrushUrl && r.editorBrushUrl !== brushUrl) releaseObjectURL(r.editorBrushUrl);
        return { ...r, editorBrushUrl: brushUrl ?? undefined };
      }),
    }));
    scheduleRecomposite(imageId, regionId, 0);
  }, [getImage, updateImage, scheduleRecomposite]);

  const pickEraseTargets = useCallback((
    img: UploadedImage,
    scope: EraseScope,
    selectedRegionId?: string | null
  ): Region[] => {
    if (scope === 'selected') {
      const r = img.regions.find(r => r.id === selectedRegionId);
      return r && !r.editorErased && !isAiOwned(r) ? [r] : [];
    }
    return img.regions.filter(r => {
      if (r.contextOnly || r.editorErased || isAiOwned(r)) return false;
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
      if (!r.editorErased || isAiOwned(r)) return false;
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
   * Translate-target picker honoring the configured scope:
   *  - 'bubble': only detected text_bubble regions
   *  - 'all':    every editable text region (text_bubble + text_free + manual)
   * AI-owned regions are always excluded (their content is final).
   */
  const pickTranslateTargets = useCallback((img: UploadedImage): Region[] => {
    const scope = configRef.current.editorTranslationScope ?? 'all';
    return img.regions.filter(r => {
      if (r.contextOnly || isAiOwned(r)) return false;
      if (scope === 'bubble') return r.detectedClass === 'text_bubble';
      return true;
    });
  }, []);

  /**
   * Auto-translate one image: a single vision-AI call over all editable
   * regions (annotated full image + numbered skeleton). Every text-bearing
   * region gets a translation; how it lands depends on the AI's freeze flag:
   *  - Normal: source → ocrText, translation → editorText, region erased and
   *    typeset (status completed).
   *  - Frozen (sfx / stylized lettering / text_free on complex backgrounds):
   *    translation → editorFrozenText only; the original artwork stays
   *    untouched and the region keeps pending status so the AI redraw
   *    pipeline can still pick it up. Manual unfreeze / the whiten quick-fix
   *    promote the frozen text into a real typeset patch later.
   * Regions the AI reports as empty (misdetections) are skipped.
   */
  const translateImageRegions = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = pickTranslateTargets(img);
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const imageEl = await loadImage(img.previewUrl);
      const results = await translateEditorRegions(imageEl, targets, configRef.current);

      // Compute post-update region objects up-front (updaters must stay pure,
      // and recomposite needs them explicitly — the store commit lags behind
      // updateImage). fontSize is never touched: undefined means the layout
      // engine auto-fits the new text.
      const translated: Region[] = [];
      const frozen: Region[] = [];
      for (const r of targets) {
        const res = results.get(r.id);
        if (!res || !res.zh?.trim()) continue; // empty box / misdetection
        // AI judges the original's direction and dominant text colour; when
        // it doesn't say, keep the existing style (undefined = layout
        // auto-heuristic / default black). The typeset colour matches the
        // original; the outline is the opposite colour (黑字白边，白字黑边)
        // and outlineWidth stays unset so the layout engine auto-sizes it
        // from the resolved font size.
        const textColor = res.color === 'white' ? '#ffffff' : res.color === 'black' ? '#000000' : undefined;
        const style: Region['editorStyle'] = {
          ...r.editorStyle,
          ...(res.vertical === undefined ? {} : { isVertical: res.vertical }),
          ...(textColor
            ? { color: textColor, outlineColor: textColor === '#000000' ? '#ffffff' : '#000000' }
            : {}),
        };
        if (res.freeze) {
          frozen.push({
            ...r,
            ocrText: res.source ?? r.ocrText,
            editorFrozenText: res.zh,
            // Freeze = pull the translation OUT of the image: drop any
            // previously typeset text / erasure / whiteout so the original
            // artwork is restored untouched.
            editorText: undefined,
            editorErased: false,
            editorWhitedOut: false,
            editorStyle: style,
          });
        } else {
          translated.push({
            ...r,
            ocrText: res.source ?? r.ocrText,
            editorText: res.zh,
            editorFrozenText: undefined,
            editorErased: true,
            editorStyle: style,
          });
        }
      }
      if (translated.length === 0 && frozen.length === 0) {
        throw new Error('AI 没有识别到任何文字（可能全部为空框/误检）');
      }

      const byId = new Map([...translated, ...frozen].map(t => [t.id, t]));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => byId.get(r.id) ?? r),
      }));
      // Typeset composite per translated region (erasure included), sequential.
      for (const nr of translated) {
        await recompositeRegion(imageId, nr.id, nr);
      }
      // Frozen regions only need a recomposite when a previous patch must be
      // torn down (re-translating a region that was typeset before).
      for (const nr of frozen) {
        if (nr.editorComposited) await recompositeRegion(imageId, nr.id, nr);
      }
    } catch (e: any) {
      console.error('Auto translate failed', e);
      setErrorMsg(e?.message || '翻译失败');
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage, setErrorMsg, pickTranslateTargets]);

  /**
   * Manual unfreeze (fix an AI false positive): move the frozen translation
   * into editorText, erase the original and typeset — the regular path.
   */
  const unfreezeTranslation = useCallback(async (imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || busy) return;
    if (isAiOwned(region) || !region.editorFrozenText?.trim()) return;
    const next: Region = {
      ...region,
      editorText: region.editorFrozenText,
      editorFrozenText: undefined,
      editorErased: true,
    };
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => r.id === regionId ? next : r),
    }));
    await recompositeRegion(imageId, regionId, next);
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * Manual freeze (the reverse of unfreeze): pull the typeset translation
   * OUT of the image — the original artwork is restored, the translation is
   * held in editorFrozenText and the region goes back to pending so the AI
   * redraw pipeline can pick it up.
   */
  const freezeTranslation = useCallback(async (imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || busy) return;
    if (isAiOwned(region) || !region.editorText?.trim()) return;
    const next: Region = {
      ...region,
      editorFrozenText: region.editorText,
      editorText: undefined,
      editorErased: false,
      editorWhitedOut: false,
    };
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => r.id === regionId ? next : r),
    }));
    // Recomposite with nothing left to render → tears the patch down.
    await recompositeRegion(imageId, regionId, next);
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * No-redraw-model fallback for frozen text_free: brute-force whiten the
   * whole box (editorWhitedOut — flood-fill erasure can't handle complex
   * backgrounds) and fill in the frozen translation, all in one click.
   */
  const whitenFrozenTextFree = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      r.detectedClass === 'text_free' && !!r.editorFrozenText?.trim()
    );
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const nextList = targets.map(r => ({
        ...r,
        editorText: r.editorFrozenText,
        editorFrozenText: undefined,
        editorWhitedOut: true,
        // Whitening already covers everything; erasure would only waste the
        // expensive flood fill under an opaque white box.
        editorErased: false,
      }));
      const byId = new Map<string, Region>(nextList.map(t => [t.id, t]));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => byId.get(r.id) ?? r),
      }));
      for (const nr of nextList) {
        await recompositeRegion(imageId, nr.id, nr);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * Batch variant: translate every loaded image that has editable regions,
   * sequentially. Per-image failures surface via setErrorMsg but do not
   * abort the batch.
   */
  const translateAllImages = useCallback(async () => {
    if (busy) return;
    const ids = imagesRef.current
      .filter(img => pickTranslateTargets(img).length > 0)
      .map(img => img.id);
    for (const id of ids) {
      await translateImageRegions(id);
    }
  }, [busy, translateImageRegions, pickTranslateTargets]);

  /** OCR every non-context region that doesn't have text yet. */
  const ocrAllRegions = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) && !(r.editorText ?? r.ocrText)?.trim()
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
      if (isAiOwned(r)) continue;
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
    if (!img || !region || isAiOwned(region)) return null;
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
      configRef.current.pythonBackendUrl,
      getContextBubbles(img),
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
    unfreezeTranslation,
    freezeTranslation,
    whitenFrozenTextFree,
    resyncEditedRegions,
    buildBrushBase,
  };
}
