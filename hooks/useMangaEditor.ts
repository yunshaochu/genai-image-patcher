import { useCallback, useEffect, useRef, useState } from 'react';
import { AppConfig, Region, UploadedImage } from '../types';
import { loadImage, cropRegion, releaseObjectURL } from '../services/imageUtils';
import { recognizeText } from '../services/detectionService';
import { translateEditorRegions } from '../services/editorTranslate';
import {
  compositeRegionPatch,
  regionNeedsComposite,
  findCoveringCompletedBubble,
  ErasedCacheEntry,
} from '../services/mangaEditor';
import { editorFontStack, ensureEditorFontLoaded, fontIdFromStack } from '../services/fontService';

export type EraseScope = 'all' | 'bubbleOnly' | 'selected';
export type RestoreScope = 'all' | 'textFree' | 'selected';

/**
 * AI-owned region: completed by the image-generation pipeline, not by the
 * editor. Editor operations (erase / text / brush / OCR / translate) must
 * never touch these — the AI patch always wins. Conversely, editor-completed
 * regions (editorComposited=true) are excluded from AI processing because the
 * AI only picks up pending/failed regions.
 */
export const isAiOwned = (r: Region): boolean => r.status === 'completed' && !r.editorComposited;

/**
 * Detected `bubble` boxes of an image (kept as context-only regions). They are
 * handed to the compositor so erasure runs on the whole bubble instead of the
 * bare text box.
 */
const getContextBubbles = (img: UploadedImage): Region[] =>
  img.regions.filter(r => r.detectedClass === 'bubble');

/**
 * Base image the compositor builds a region's patch from. Normally the plain
 * preview; for aiBubbleBase regions the covering AI-redrawn bubble patch is
 * drawn in first, so typeset text sits on the clean bubble (and any explicit
 * re-erasure runs on the AI base instead of resurrecting original pixels).
 * Falls back to the plain preview when the bubble patch is unavailable.
 */
const buildEditorBase = async (
  img: UploadedImage,
  region: Region
): Promise<HTMLImageElement | HTMLCanvasElement> => {
  const imageEl = await loadImage(img.previewUrl);
  if (!region.aiBubbleBase) return imageEl;
  const bubble = findCoveringCompletedBubble(img.regions, region);
  if (!bubble?.processedImageUrl) return imageEl;
  const base = document.createElement('canvas');
  base.width = imageEl.naturalWidth;
  base.height = imageEl.naturalHeight;
  const bctx = base.getContext('2d');
  if (!bctx) return imageEl;
  bctx.drawImage(imageEl, 0, 0);
  try {
    const patchImg = await loadImage(bubble.processedImageUrl);
    const ax = ((bubble.anchorX ?? bubble.x) / 100) * base.width;
    const ay = ((bubble.anchorY ?? bubble.y) / 100) * base.height;
    const aw = ((bubble.anchorWidth ?? bubble.width) / 100) * base.width;
    const ah = ((bubble.anchorHeight ?? bubble.height) / 100) * base.height;
    bctx.drawImage(patchImg, ax, ay, aw, ah);
  } catch (e) {
    console.warn('Failed to overlay AI bubble base for region', region.id, e);
  }
  return base;
};

interface UseMangaEditorParams {
  images: UploadedImage[];
  updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void;
  config: AppConfig;
  setErrorMsg: (msg: string | null) => void;
}

/**
 * Wait after the last keystroke before a text/style edit is composited.
 *
 * Was 200 ms. Measured (see the editorPerf instrumentation): a composite costs
 * ~10–38 ms wall time, of which only the canvas draws (~1–5 ms) block the main
 * thread — the WebP encode in toBlob runs off it. Coalescing is still useful
 * (it keeps one composite per typing pause), but 200 ms made the debounce 80%
 * of the perceived "type → see it" latency, so it is down to 120 ms.
 */
const RECOMPOSITE_DEBOUNCE_MS = 120;
/**
 * Debounce for DISCRETE editor actions (± font size, direction flip, erase
 * toggle, Ctrl+wheel step). They always come in short bursts (rapid clicks /
 * a wheel gesture), so a shorter window still coalesces them into one
 * composite while cutting the feedback latency from ~285 ms to ~150 ms.
 */
export const DISCRETE_RECOMPOSITE_DEBOUNCE_MS = 80;

// ---------------------------------------------------------------------------
// Timing instrumentation for the recomposite pipeline (temporary — delete this
// block and its call sites once tuned, or silence it at runtime with
// `window.__editorPerf = false` in the console).
//
// Every composite logs one line:
//   输入→开始合成(=防抖) | 合成[各阶段明细] | 提交→上屏 | 总计
// and emits performance marks for the DevTools timeline, so the perceived
// "edit → the picture actually changes" delay can be attributed to a stage.
// ---------------------------------------------------------------------------
export const editorPerfOn = (): boolean =>
  (globalThis as { __editorPerf?: boolean }).__editorPerf !== false;

const editorPerfMark = (name: string) => {
  try { performance.mark(name); } catch { /* ignore */ }
};

/** 0.1 ms resolution — keeps the console lines short. */
const perfMs = (v: number) => Math.round(v * 10) / 10;

/** Editor fields a caller may merge into a region. */
type EditorFieldUpdates =
  Partial<Pick<Region, 'editorText' | 'editorErased' | 'editorBrushUrl'>> & { editorStyle?: Region['editorStyle'] };

/**
 * Apply editor field updates to a region.
 *
 * Shared by the state update and by the explicit region handed to an IMMEDIATE
 * composite: a composite that runs before React commits the update would
 * otherwise read the previous region out of the store and re-render the old
 * content (the "picture is one edit behind" bug).
 */
const mergeEditorUpdates = (region: Region, updates: EditorFieldUpdates): Region => {
  const next: Region = { ...region, ...updates };
  // Typing text into a frozen region is an implicit unfreeze — the held-back
  // translation is superseded by the user's own text.
  if (updates.editorText?.trim()) next.editorFrozenText = undefined;
  if (updates.editorStyle !== undefined) {
    next.editorStyle = { ...region.editorStyle, ...updates.editorStyle };
  }
  return next;
};

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
  // True while an auto-translate run (single page or batch) is in flight —
  // drives the dock's stop button. Distinct from `busy`, which erase/OCR
  // operations also set.
  const [translating, setTranslating] = useState(false);
  // AbortController of the in-flight translation (single-page runs own it;
  // batch runs share one controller across images).
  const translateAbortRef = useRef<AbortController | null>(null);
  // regionId → last resolved font size (auto-fit or manual), for panel display.
  const [computedFontSizes, setComputedFontSizes] = useState<Record<string, number>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const configRef = useRef(config);
  configRef.current = config;

  // regionId → { geomKey, url } — cache of the erased base crop.
  const erasedCacheRef = useRef<Map<string, ErasedCacheEntry>>(new Map());
  const debounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** `imageId|regionId` → timestamp of that box's last user edit, consumed by
   *  the recomposite timing (measures the whole input → painted latency). */
  const editStampRef = useRef<Map<string, number>>(new Map());
  /** Regions whose composite is currently running — two overlapping composites
   *  could write their patches out of order and leave the older one on screen. */
  const compositingRef = useRef<Set<string>>(new Set());
  /** Key → when its last composite STARTED (drives the leading-edge rule). */
  const compositedAtRef = useRef<Map<string, number>>(new Map());

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

    // 该区域指定了特殊字体（dock 手选 / AI 自动识别 / 会话恢复）时先确保字体
    // 已加载：字体没就位时 canvas 量的是兜底字体的字宽，自动字号会算错、贴图也会
    // 画错。已加载时这里只是一次 Map 查询 + 已 resolve 的 await。
    const regionFontId = fontIdFromStack(region.editorStyle?.fontFamily);
    if (regionFontId) {
      await ensureEditorFontLoaded(regionFontId, configRef.current.pythonBackendUrl)
        .catch(() => { /* 下载失败就用字体栈里的兜底字体，不阻塞编辑 */ });
    }

    // --- timing: last input → debounce → stages → commit → painted frame ----
    const perfKey = `${imageId}|${regionId}`;
    const editedAt = editStampRef.current.get(perfKey);
    editStampRef.current.delete(perfKey);
    const t0 = performance.now();
    let stageAt = t0;
    const stages: string[] = [];
    const onStage = (stage: string) => {
      const now = performance.now();
      if (editorPerfOn()) {
        stages.push(`${stage} ${perfMs(now - stageAt)}ms`);
        editorPerfMark(`editor:${stage}`);
      }
      stageAt = now;
    };

    try {
      const imageEl = await buildEditorBase(img, region);
      onStage('预览解码+底色');
      const result = await compositeRegionPatch(
        imageEl,
        region,
        erasedCacheRef.current,
        configRef.current.enableVerticalTextDefault,
        configRef.current.pythonBackendUrl,
        getContextBubbles(img),
        true,
        true,
        onStage
      );
      const url = result?.url ?? null;

      // Publish the resolved font size so the panel can show the auto-fit
      // value as a reference for manual sizing. Keep the record's identity when
      // nothing changed: the dock is memo'd on this prop, so publishing a fresh
      // object on every recomposite would re-render the whole panel.
      setComputedFontSizes(prev => {
        if (result?.fontSize) {
          if (prev[regionId] === result.fontSize) return prev;
          return { ...prev, [regionId]: result.fontSize };
        }
        if (!(regionId in prev)) return prev;
        const next = { ...prev };
        delete next[regionId];
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

      // --- timing: state written → ~first painted frame ---------------------
      // Two rAFs ≈ React commit + the browser decoding the new patch blob and
      // painting it (an approximation — the decode can land one frame later).
      onStage('写回状态');
      if (editorPerfOn()) {
        const commitAt = performance.now();
        const label = `${img.file?.name ?? ''}#${regionId.slice(0, 6)}`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const paintedAt = performance.now();
          const wait = editedAt !== undefined ? `${perfMs(t0 - editedAt)}ms` : '—(非防抖路径)';
          console.log(
            `[editorPerf] ${label} | 输入→合成 ${wait} | ` +
            `合成 ${perfMs(commitAt - t0)}ms [${stages.join(', ')}] | ` +
            `提交→上屏 ${perfMs(paintedAt - commitAt)}ms | ` +
            `总计 ${perfMs(paintedAt - (editedAt ?? t0))}ms`
          );
        }));
      }
    } catch (e: any) {
      console.error('Editor composite failed', e);
      setErrorMsg('Editor composite failed: ' + (e?.message || e));
    }
  }, [getImage, updateImage, setErrorMsg]);

  /** Run one composite, tracking the region as "compositing" while it runs. */
  const runRecomposite = useCallback((imageId: string, regionId: string, regionOverride?: Region) => {
    const key = `${imageId}|${regionId}`;
    compositedAtRef.current.set(key, performance.now());
    compositingRef.current.add(key);
    void recompositeRegion(imageId, regionId, regionOverride).finally(() => compositingRef.current.delete(key));
  }, [recompositeRegion]);

  /**
   * Schedule a recomposite for one region.
   *
   * Trailing edge (as before): edits within `delay` of each other collapse into
   * one composite, so continuous typing costs a single pass on the final text.
   * It reads the region back from the store, which is correct there because the
   * timer always fires after React committed the update.
   *
   * Leading edge: an ISOLATED edit — nothing composited recently, nothing in
   * flight — runs immediately, so "change one character / press ± once and
   * stop" does not wait for a window that has nothing to coalesce. Because it
   * runs BEFORE React commits, the caller MUST pass the updated region as
   * `regionOverride` (that is what the store will hold a moment later);
   * otherwise the composite re-renders the previous content.
   */
  const scheduleRecomposite = useCallback((
    imageId: string,
    regionId: string,
    delay = RECOMPOSITE_DEBOUNCE_MS,
    regionOverride?: Region
  ) => {
    const key = `${imageId}|${regionId}`;
    // Timing: remember when the user touched this box, so the composite can
    // report the full "input → painted" latency (see recompositeRegion).
    editStampRef.current.set(key, performance.now());
    const pending = debounceRef.current.get(key);
    const idleFor = performance.now() - (compositedAtRef.current.get(key) ?? -Infinity);
    if (!pending && !compositingRef.current.has(key) && idleFor >= delay) {
      runRecomposite(imageId, regionId, regionOverride);
      return;
    }
    if (pending) clearTimeout(pending);
    const fire = () => {
      debounceRef.current.delete(key);
      // Never overlap composites for one region — re-queue briefly instead.
      if (compositingRef.current.has(key)) {
        debounceRef.current.set(key, setTimeout(fire, 40));
        return;
      }
      // Post-commit: read the (newer) region back instead of a stale override.
      runRecomposite(imageId, regionId);
    };
    debounceRef.current.set(key, setTimeout(fire, delay));
  }, [runRecomposite]);

  // Rebase editor patches that were baked before their AI bubble base
  // completed (or before the bubble was re-redrawn): the stale patch still
  // carries original pixels and would cover the AI redraw. One recomposite
  // per (region, bubble patch URL) pair — the guard map breaks the
  // update → effect → recomposite → update loop.
  const aiBaseRebasedRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const img of images) {
      for (const r of img.regions) {
        if (!r.aiBubbleBase || !r.editorComposited) continue;
        const bubble = findCoveringCompletedBubble(img.regions, r);
        if (!bubble?.processedImageUrl) continue;
        if (aiBaseRebasedRef.current.get(r.id) === bubble.processedImageUrl) continue;
        aiBaseRebasedRef.current.set(r.id, bubble.processedImageUrl);
        void recompositeRegion(img.id, r.id);
      }
    }
  }, [images, recompositeRegion]);

  /**
   * Merge editor field updates into a region and schedule a recomposite.
   *
   * `opts.debounceMs` overrides the wait before that recomposite: typing wants
   * the long window (every keystroke restarts it, so nothing composites until
   * the user pauses), while discrete actions want the short one — see
   * DISCRETE_RECOMPOSITE_DEBOUNCE_MS.
   */
  const updateEditorRegion = useCallback((
    imageId: string,
    regionId: string,
    updates: EditorFieldUpdates,
    opts?: { debounceMs?: number }
  ) => {
    const target = getImage(imageId)?.regions.find(r => r.id === regionId);
    if (target && isAiOwned(target)) return;
    // The region as it will look once this update commits. It is handed to
    // scheduleRecomposite because the leading-edge composite may run before
    // React commits, and reading the store back at that point would compose the
    // PREVIOUS content (the "picture is one edit behind" bug).
    const nextRegion = target ? mergeEditorUpdates(target, updates) : undefined;
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => (r.id === regionId ? mergeEditorUpdates(r, updates) : r)),
    }));
    scheduleRecomposite(imageId, regionId, opts?.debounceMs, nextRegion);
  }, [getImage, updateImage, scheduleRecomposite]);

  /**
   * Replace (or clear) the brush-stroke layer of a region.
   *
   * The recomposite runs immediately with the explicitly-built next region
   * (no debounce): a debounced/timer-based call would read imagesRef, which
   * lags one React commit behind updateImage — the first paint after a
   * geometry/text change then composed the OLD region and the strokes never
   * made it into the patch (paint, release, nothing written back).
   */
  const setBrushLayer = useCallback(async (imageId: string, regionId: string, brushUrl: string | null) => {
    const target = getImage(imageId)?.regions.find(r => r.id === regionId);
    if (!target || isAiOwned(target)) return;
    const next: Region = { ...target, editorBrushUrl: brushUrl ?? undefined };
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => {
        if (r.id !== regionId) return r;
        if (r.editorBrushUrl && r.editorBrushUrl !== brushUrl) releaseObjectURL(r.editorBrushUrl);
        return { ...r, editorBrushUrl: brushUrl ?? undefined };
      }),
    }));
    await recompositeRegion(imageId, regionId, next);
  }, [getImage, updateImage, recompositeRegion]);

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
      // aiBubbleBase regions sit on an AI-redrawn (already text-free) bubble —
      // batch erasure would burn the expensive flood fill for nothing. The
      // single-region 'selected' scope above stays available as a manual
      // override when the AI redraw left residue.
      if (r.aiBubbleBase) return false;
      if (scope === 'bubbleOnly') return r.detectedClass === 'text_bubble';
      return true; // 'all' — manual boxes + text_bubble + text_free
    });
  }, []);

  /** Erase the original text inside one image (flood-fill, frontend-only).
   *  Busy bookkeeping is owned by the public wrappers below. */
  const eraseInImage = useCallback(async (
    imageId: string,
    scope: EraseScope,
    selectedRegionId?: string | null
  ) => {
    const img = getImage(imageId);
    if (!img) return;
    const targets = pickEraseTargets(img, scope, selectedRegionId);
    if (targets.length === 0) return;

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
  }, [getImage, pickEraseTargets, recompositeRegion, updateImage]);

  /** Erase regions of the current image. */
  const eraseRegions = useCallback(async (
    imageId: string,
    scope: EraseScope,
    selectedRegionId?: string | null
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await eraseInImage(imageId, scope, selectedRegionId);
    } finally {
      setBusy(false);
    }
  }, [busy, eraseInImage]);

  /** Batch: same erasure over every loaded image, in gallery order. */
  const eraseAllImages = useCallback(async (scope: EraseScope) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const img of imagesRef.current) {
        await eraseInImage(img.id, scope, null);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, eraseInImage]);

  /** Restore erasure inside one image ('all' / 'textFree' / 'selected').
   *  Typeset text is kept. Busy bookkeeping is owned by the wrappers. */
  const restoreEraseInImage = useCallback(async (
    imageId: string,
    scope: RestoreScope,
    selectedRegionId?: string | null
  ) => {
    const img = getImage(imageId);
    if (!img) return;
    const targets = img.regions.filter(r => {
      if (!r.editorErased || isAiOwned(r)) return false;
      if (scope === 'selected') return r.id === selectedRegionId;
      if (scope === 'textFree') return r.detectedClass === 'text_free';
      return true;
    });
    if (targets.length === 0) return;

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
  }, [getImage, recompositeRegion, updateImage]);

  /** Undo erasure on the current image. */
  const restoreErase = useCallback(async (
    imageId: string,
    scope: RestoreScope,
    selectedRegionId?: string | null
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      await restoreEraseInImage(imageId, scope, selectedRegionId);
    } finally {
      setBusy(false);
    }
  }, [busy, restoreEraseInImage]);

  /** Batch: undo erasure on every loaded image. */
  const restoreEraseAllImages = useCallback(async (scope: RestoreScope) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const img of imagesRef.current) {
        await restoreEraseInImage(img.id, scope, null);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, restoreEraseInImage]);

  /** Drop the per-region erase cache + any pending composite (region deleted). */
  const dropRegionCache = useCallback((imageId: string, regionId: string) => {
    const entry = erasedCacheRef.current.get(regionId);
    if (entry) {
      releaseObjectURL(entry.url);
      erasedCacheRef.current.delete(regionId);
    }
    const key = `${imageId}|${regionId}`;
    const timer = debounceRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      debounceRef.current.delete(key);
    }
  }, []);

  /**
   * Translate-target picker: every editable text region (text_bubble +
   * text_free + manual boxes) — the AI translates the whole page in one call,
   * so a bubble-only scope would just drop text without saving anything.
   * AI-owned regions are always excluded (their content is final), and so are
   * regions that already hold a translation (editorText typeset / manually
   * typed, or editorFrozenText held back) — re-sending those would burn API
   * quota AND overwrite the user's own edits. A page whose regions are all
   * done therefore yields zero targets and the whole call is skipped.
   * To force a re-translation of one box, clear its text first.
   */
  const pickTranslateTargets = useCallback((img: UploadedImage): Region[] =>
    img.regions.filter(r => {
      if (r.contextOnly || isAiOwned(r)) return false;
      if (r.editorText?.trim() || r.editorFrozenText?.trim()) return false;
      return true;
    }), []);

  /** Stop button: aborts the in-flight translation (single page or batch). */
  const stopTranslation = useCallback(() => {
    translateAbortRef.current?.abort();
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
   *
   * `outerSignal` is the batch controller's signal when called from
   * translateAllImages; single-page runs create their own controller so the
   * dock's stop button can abort the vision call / gate wait.
   */
  const translateImageRegions = useCallback(async (imageId: string, outerSignal?: AbortSignal) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = pickTranslateTargets(img);
    if (targets.length === 0) return;

    // Batch runs share their controller; single-page runs own one.
    const ownCtrl = outerSignal ? null : new AbortController();
    const signal = outerSignal ?? ownCtrl!.signal;
    if (ownCtrl) translateAbortRef.current = ownCtrl;

    setBusy(true);
    setTranslating(true);
    try {
      const imageEl = await loadImage(img.previewUrl);
      const results = await translateEditorRegions(imageEl, targets, configRef.current, signal);

      // Compute post-update region objects up-front (updaters must stay pure,
      // and recomposite needs them explicitly — the store commit lags behind
      // updateImage). fontSize is never touched: undefined means the layout
      // engine auto-fits the new text.
      const translated: Region[] = [];
      const frozen: Region[] = [];
      /** 自动识别选中的字体 id：合成前要先从后端取回来。 */
      const neededFontIds = new Set<string>();
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
        // 字体自动识别：res.font 为具体字体 id 时覆盖本框字体；空串是「常规
        // 印刷体」——不覆盖，让该框继续跟随全局「编辑器字体」。
        const aiFontStack = res.font ? editorFontStack(res.font) : undefined;
        if (res.font) neededFontIds.add(res.font);
        const style: Region['editorStyle'] = {
          ...r.editorStyle,
          ...(res.vertical === undefined ? {} : { isVertical: res.vertical }),
          ...(textColor
            ? { color: textColor, outlineColor: textColor === '#000000' ? '#ffffff' : '#000000' }
            : {}),
          ...(aiFontStack ? { fontFamily: aiFontStack } : {}),
        };
        if (res.freeze || r.aiBubbleBase) {
          // aiBubbleBase forces the frozen landing even when the AI would
          // typeset: the translation is held back (editorFrozenText) so the
          // AI-redrawn bubble stays untouched until the user reveals the
          // text. The frozen branch's field clearing is exactly right here —
          // no erasure/whiteout may touch the AI base.
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
            // A fresh AI decision owns the box again — drop any earlier manual
            // freeze/unfreeze exemption so the batch quick-fix applies to it.
            freezeManual: undefined,
            editorStyle: style,
          });
        } else {
          translated.push({
            ...r,
            ocrText: res.source ?? r.ocrText,
            editorText: res.zh,
            editorFrozenText: undefined,
            editorErased: true,
            freezeManual: undefined,
            editorStyle: style,
          });
        }
      }
      if (translated.length === 0 && frozen.length === 0) {
        throw new Error('AI 没有识别到任何文字（可能全部为空框/误检）');
      }

      const byId = new Map<string, Region>([...translated, ...frozen].map(nr => [nr.id, nr]));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => byId.get(r.id) ?? r),
      }));
      // 自动识别选中的字体先取回来再合成：字体没就位时 canvas 量不到正确字宽
      // （自动字号会算错），贴图也会先用兜底字体画一遍。个别字体下载失败不阻塞
      // 整批翻译——那几框会落到字体栈里的兜底字体上。
      if (neededFontIds.size > 0) {
        await Promise.all([...neededFontIds].map(id =>
          ensureEditorFontLoaded(id, configRef.current.pythonBackendUrl).catch(e => {
            console.warn(`字体 ${id} 加载失败，相关区域将回退到兜底字体`, e);
          })
        ));
      }

      // Typeset composite per translated region (erasure included), sequential.
      // Note: once the API call has returned, composites always run to
      // completion — the translations are already paid for, and stopping
      // mid-typeset would leave regions with text but no rendered patch
      // (torn state). The stop button therefore only interrupts the network
      // wait (and skips the remaining images in a batch).
      for (const nr of translated) {
        await recompositeRegion(imageId, nr.id, nr);
      }
      // Frozen regions only need a recomposite when a previous patch must be
      // torn down (re-translating a region that was typeset before).
      for (const nr of frozen) {
        if (nr.editorComposited) await recompositeRegion(imageId, nr.id, nr);
      }
    } catch (e: any) {
      // User-stopped (AbortError) is intentional — not an error.
      if (e?.name !== 'AbortError') {
        console.error('Auto translate failed', e);
        setErrorMsg(e?.message || '翻译失败');
      }
    } finally {
      setBusy(false);
      setTranslating(false);
      if (ownCtrl && translateAbortRef.current === ownCtrl) {
        translateAbortRef.current = null;
      }
    }
  }, [busy, getImage, recompositeRegion, updateImage, setErrorMsg, pickTranslateTargets]);

  /**
   * Manual unfreeze (fix an AI false positive): move the frozen translation
   * into editorText, erase the original and typeset — the regular path.
   * aiBubbleBase regions skip the erasure: their base is the AI-redrawn
   * bubble, which is already text-free (residue can be erased manually via
   * the single-region erase afterwards).
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
      editorErased: region.aiBubbleBase ? false : true,
      // Explicit manual decision: the batch 涂白 / 再次冻结 shortcuts must skip it.
      freezeManual: true,
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
      // Explicit manual decision: the batch 涂白 / 再次冻结 shortcuts must skip it.
      freezeManual: true,
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
   *
   * Manual decisions win: boxes the user froze / unfroze explicitly from the
   * dock (freezeManual) are skipped, so a page-wide quick fix never overrides
   * a per-box choice. The reverse direction lives in refreezeWhitedTextFree.
   */
  const whitenFrozenTextFree = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) && !r.freezeManual &&
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
   * Reverse of the whiten quick-fix: freeze the text_free boxes that
   * 「涂白并解冻」whitened back up — the whiteout and the typeset text are
   * removed (the original artwork comes back) and the translation is held in
   * editorFrozenText again, ready for the AI redraw pipeline.
   *
   * Recognition is state-based, not remembered: editorWhitedOut is only ever
   * set by whitenFrozenTextFree, so "whited out + has text" is exactly its
   * output. Boxes the user froze / unfroze by hand (freezeManual) are excluded
   * in both directions.
   */
  const refreezeWhitedTextFree = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) && !r.freezeManual &&
      r.detectedClass === 'text_free' && !!r.editorWhitedOut && !!r.editorText?.trim()
    );
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const nextList = targets.map(r => ({
        ...r,
        editorFrozenText: r.editorText,
        editorText: undefined,
        editorWhitedOut: false,
        editorErased: false,
      }));
      const byId = new Map<string, Region>(nextList.map(t => [t.id, t]));
      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => byId.get(r.id) ?? r),
      }));
      // Nothing left to render → each recomposite tears its patch back down.
      for (const nr of nextList) {
        await recompositeRegion(imageId, nr.id, nr);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, recompositeRegion, updateImage]);

  /**
   * One-click reveal of every held-back translation on aiBubbleBase regions:
   * typeset all frozen translations onto their (already text-free) AI bubble
   * base — no erasure anywhere.
   */
  const unfreezeAiBubbleRegions = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = img.regions.filter(r =>
      r.aiBubbleBase && !isAiOwned(r) && !!r.editorFrozenText?.trim()
    );
    if (targets.length === 0) return;

    setBusy(true);
    try {
      const nextList = targets.map(r => ({
        ...r,
        editorText: r.editorFrozenText,
        editorFrozenText: undefined,
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
   * abort the batch. One shared AbortController lets the stop button cancel
   * the in-flight request AND skip the remaining images.
   */
  const translateAllImages = useCallback(async () => {
    if (busy) return;
    const ids = imagesRef.current
      .filter(img => pickTranslateTargets(img).length > 0)
      .map(img => img.id);
    if (ids.length === 0) return;
    const ctrl = new AbortController();
    translateAbortRef.current = ctrl;
    setTranslating(true);
    try {
      for (const id of ids) {
        if (ctrl.signal.aborted) break;
        await translateImageRegions(id, ctrl.signal);
      }
    } finally {
      setTranslating(false);
      if (translateAbortRef.current === ctrl) translateAbortRef.current = null;
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
          // OCR text becomes the typeset source — refresh the patch with the
          // region as it now stands (it was just written to the store).
          await recompositeRegion(imageId, region.id, { ...region, ocrText: text, isOcrLoading: false });
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
      // `r` comes from the just-committed region array: pass it explicitly so an
      // immediate composite can't read the pre-drag geometry back out of the store.
      if (moved) scheduleRecomposite(imageId, r.id, 600, r);
    }
  }, [getImage, scheduleRecomposite]);

  /**
   * 重建所有已嵌字区域的贴图（全部图片）。
   *
   * 典型场景：切换「编辑器字体」——已生成的贴图是用旧字体栅格化好的位图，只改
   * 配置不会让它们自动重画，必须显式重建。擦除底色是按几何缓存的，所以这里只
   * 会重跑排版 + 编码，不会重新做耗时的擦除。
   */
  const refreshEditorPatches = useCallback(async () => {
    for (const img of imagesRef.current) {
      for (const r of img.regions) {
        if (isAiOwned(r) || !regionNeedsComposite(r)) continue;
        await recompositeRegion(img.id, r.id);
      }
    }
  }, [recompositeRegion]);

  /**
   * Build the region's background patch — WITHOUT the brush layer and WITHOUT
   * the typeset text — used as the base image under the brush painter. The
   * painter draws its strokes on top of this base and the text above those, so
   * its preview matches the final composite (brush = background touch-up).
   * Returns null when there is nothing to composite (caller falls back to the
   * plain crop). The returned Object URL is owned by the caller.
   */
  const buildBrushBase = useCallback(async (imageId: string, regionId: string): Promise<string | null> => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || isAiOwned(region)) return null;
    const noBrush: Region = { ...region, editorBrushUrl: undefined };
    if (!regionNeedsComposite(noBrush)) return null;
    const imageEl = await buildEditorBase(img, region);
    // allowMargin=false: the painter canvas must stay exactly crop-sized so
    // brush coordinates map 1:1 onto the crop area of the final patch.
    // includeText=false: the painter typesets the text itself, above the
    // strokes — the composite reverses that (it draws the brush first).
    const result = await compositeRegionPatch(
      imageEl,
      noBrush,
      erasedCacheRef.current,
      configRef.current.enableVerticalTextDefault,
      configRef.current.pythonBackendUrl,
      getContextBubbles(img),
      false,
      false
    );
    return result?.url ?? null;
  }, [getImage]);

  return {
    busy,
    translating,
    computedFontSizes,
    updateEditorRegion,
    setBrushLayer,
    eraseRegions,
    eraseAllImages,
    restoreErase,
    restoreEraseAllImages,
    dropRegionCache,
    ocrAllRegions,
    translateImageRegions,
    translateAllImages,
    stopTranslation,
    unfreezeTranslation,
    freezeTranslation,
    whitenFrozenTextFree,
    refreezeWhitedTextFree,
    unfreezeAiBubbleRegions,
    resyncEditedRegions,
    refreshEditorPatches,
    buildBrushBase,
  };
}
