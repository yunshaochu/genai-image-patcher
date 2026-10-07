import { useCallback, useEffect, useRef, useState } from 'react';
import { AppConfig, Region, UploadedImage, RedrawIntent, effectiveIntentOf, EMPTY_TEXT_MARK, isTranslationHandled } from '../types';
import { loadImage, releaseObjectURL, cloneObjectUrl } from '../services/imageUtils';
import { translateEditorRegions } from '../services/editorTranslate';
import { PageTerm } from '../services/glossaryBook';
import {
  compositeRegionPatch,
  regionNeedsComposite,
  findCoveringCompletedBubble,
  findContainedTextRegions,
  syncBubbleStatuses,
  eraseBaseUrlOf,
  ErasedCacheEntry,
} from '../services/mangaEditor';
import { editorFontStack, ensureEditorFontLoaded, fontIdFromStack } from '../services/fontService';
import { runWithConcurrency } from '../services/concurrencyUtils';


/**
 * 「跑完再回头重试」轮数的兜底默认值（编辑器批量翻译）。
 *
 * 实际轮数由 config.maxRetryRounds 配置（设置面板「整批重试轮数」可调，0 = 关闭）；
 * 这里只在配置缺失时兜底。机制本身：一整批翻译结束后再扫一遍图库，只要还有未翻译
 * 成功的框（对应页的调用失败 / 返回空），就再跑一整批，最多这么多轮。译文已经落地
 * 的框会被 pickTranslateTargets 过滤掉，所以重复扫描是幂等且几乎零成本的。
 */
const DEFAULT_MAX_END_RETRY_ROUNDS = 3;

/**
 * AI-owned region: completed by the image-generation pipeline, not by the
 * editor. Editor operations (erase / text / brush / translate) must
 * never touch these — the AI patch always wins. Conversely, editor-completed
 * regions (editorComposited=true) are excluded from AI processing because the
 * AI only picks up pending/failed regions.
 */
export const isAiOwned = (r: Region): boolean =>
  r.status === 'completed' && !r.editorComposited && !r.aiErasedBase;

/**
 * Detected `bubble` boxes of an image (kept as context-only regions). They are
 * handed to the compositor so erasure runs on the whole bubble instead of the
 * bare text box.
 */
const getContextBubbles = (img: UploadedImage): Region[] =>
  img.regions.filter(r => r.detectedClass === 'bubble');

/** AI「擦除」产物的干净底图（定义在 services/mangaEditor，合成器也要用）。 */

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
  // AI「擦除」意图：本框那份干净底图 —— 先按锚点铺回整图，后续排版直接落在它
  // 上面，而且不再做泛洪擦除（原文早被 AI 抹掉）。底图尺寸就是当时的框，不带
  // 编辑器的溢出边距（patchMargin* 是合成结果的属性，不是底图的）。
  const eraseBaseUrl = eraseBaseUrlOf(region);
  if (region.aiErasedBase && eraseBaseUrl) {
    const base = document.createElement('canvas');
    base.width = imageEl.naturalWidth;
    base.height = imageEl.naturalHeight;
    const bctx = base.getContext('2d');
    if (!bctx) return imageEl;
    bctx.drawImage(imageEl, 0, 0);
    try {
      const patchImg = await loadImage(eraseBaseUrl);
      const ax = ((region.anchorX ?? region.x) / 100) * base.width;
      const ay = ((region.anchorY ?? region.y) / 100) * base.height;
      const aw = ((region.anchorWidth ?? region.width) / 100) * base.width;
      const ah = ((region.anchorHeight ?? region.height) / 100) * base.height;
      bctx.drawImage(patchImg, ax, ay, aw, ah);
    } catch (e) {
      console.warn('Failed to overlay AI erased base for region', region.id, e);
    }
    return base;
  }
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
  /** 每页翻译的术语落地口（术语表 v2）：本页刚翻完的框（sourceText/editorText
   *  已写好）+ AI 上报的术语。实现方负责合并进术语树，并（glossaryAutoUnify
   *  开着时）按已选标准译名改写本页框文本——返回值会替换原数组进入后续的
   *  状态提交与合成，所以自动统一的页面第一次上屏就是统一后的样子。 */
  onPageTerms?: (imageId: string, regions: Region[], terms: PageTerm[]) => Region[];
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
export function useMangaEditor({ images, updateImage, config, setErrorMsg, onPageTerms }: UseMangaEditorParams) {
  const [busy, setBusy] = useState(false);
  // True while an auto-translate run (single page or batch) is in flight —
  // drives the dock's stop button. Distinct from `busy`, which erase
  // operations also set.
  const [translating, setTranslating] = useState(false);
  // AbortController of the in-flight translation (single-page runs own it;
  // batch runs share one controller across images).
  const translateAbortRef = useRef<AbortController | null>(null);
  // Images whose translation is currently in flight. The dock keys per-region
  // editing off this: during a BATCH run the pages already finished (and the
  // ones not started yet) stay editable — only the pages being translated are
  // locked, because their regions are about to be overwritten by the AI. A Set
  // (not a single id) because 处理选项的「并发执行」sends several pages at once.
  const [translatingImageIds, setTranslatingImageIds] = useState<Set<string>>(() => new Set());

  /** Add / remove one page from the in-flight translate set (并发批次会同时有多个). */
  const markTranslatingImage = useCallback((imageId: string, on: boolean) => {
    setTranslatingImageIds(prev => {
      if (on === prev.has(imageId)) return prev;
      const next = new Set(prev);
      if (on) next.add(imageId); else next.delete(imageId);
      return next;
    });
  }, []);
  // regionId → last resolved font size (auto-fit or manual), for panel display.
  const [computedFontSizes, setComputedFontSizes] = useState<Record<string, number>>({});
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const configRef = useRef(config);
  configRef.current = config;

  /**
   * Per-image flavour of the global `busy` lock, mirroring the dock's
   * `regionEditLocked`: during a translate run only the page(s) actually being
   * translated are frozen (their regions are about to be overwritten by the AI),
   * while erase still locks every page. Used by the region operations the
   * user may run mid-batch (freeze / unfreeze) so a completed page stays
   * editable while the next one renders.
   */
  const isImageLocked = useCallback(
    (imageId: string) => busy && (!translating || translatingImageIds.has(imageId)),
    [busy, translating, translatingImageIds],
  );

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
   * 有效重绘场景：本框覆盖 ?? 全局默认场景。
   * 已完成的框用**完成时**的场景（effectiveIntentOf），不跟随当前默认场景。
   */
  const intentOf = useCallback((r: Region): RedrawIntent =>
    effectiveIntentOf(r, configRef.current.defaultRedrawIntent ?? 'translate', configRef.current.enableMangaMode), []);

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
        configRef.current.editorAutoTextColor,
        onStage
      );
      const url = result?.url ?? null;
      // 自动取色量到的墨色写回区域：本版贴图已经用它画过了（合成器先擦除再
      // 排版），所以这里只是把同一个值落到数据上 —— dock 的色块、画笔预览、
      // 会话持久化因此都能看到它，而且之后再合成时不必依赖擦除缓存。
      const measuredColor = result?.textColor;

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

      // Only explicitly written text makes the region "final" — the region
      // stays pending until the user confirms text into editorText.
      const hasWrittenText = !!region.editorText?.trim();

      updateImage(imageId, current => ({
        ...current,
        regions: current.regions.map(r => {
          if (r.id !== regionId) return r;
          // 实测墨色只在「不是用户手动钉住的」且确实变了的时候写回，避免每次
          // 合成都造一个新 region 对象（dock / 画笔预览会跟着白重建一遍）。
          const base = measuredColor
            && r.editorStyle?.colorSource !== 'manual'
            && r.editorStyle?.color !== measuredColor
            ? {
                ...r,
                editorStyle: {
                  ...r.editorStyle,
                  color: measuredColor,
                  outlineColor: undefined,
                  outlineWidth: undefined,
                  colorSource: 'auto' as const,
                },
              }
            : r;
          if (url && result) {
            // 老会话兜底：还没迁出独立底图槽（aiEraseBaseUrl）时，processedImageUrl
            // 可能是 AI「擦除」产物的唯一副本 —— 释放它等于把底图也删了。
            const keepAsBase = base.aiErasedBase && !base.aiEraseBaseUrl && !base.editorComposited;
            if (base.processedImageUrl && base.processedImageUrl !== url && !keepAsBase) {
              releaseObjectURL(base.processedImageUrl);
            }
            return {
              ...base,
              processedImageUrl: url,
              // 本框贴着 AI「擦除」产物时，即使现在没有字也仍然是"AI 已产出"：
              // 冻结翻译只是把译文撤出来，画面（那张干净底图）还在。
              status: (hasWrittenText || !!eraseBaseUrlOf(base)) ? ('completed' as const) : ('pending' as const),
              editorComposited: true,
              patchMarginX: result.marginXPct,
              patchMarginY: result.marginYPct,
              anchorX: base.x,
              anchorY: base.y,
              anchorWidth: base.width,
              anchorHeight: base.height,
            };
          }
          // Nothing left to composite: revert only patches WE produced.
          // 但绝不能顺手删掉 AI「擦除」产物 —— 冻结翻译 / 清空文字时它是这格的
          // 画面本体，只有 AI 重绘 / 手动修补页上那个 ↺ 重置按钮才能丢掉它。
          if (base.editorComposited && !eraseBaseUrlOf(base)) {
            if (base.processedImageUrl) releaseObjectURL(base.processedImageUrl);
            return {
              ...base,
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

  // 老会话 / 老路径迁移：把「贴图上就是干净底图」的框补成真正的擦除底图框。
  // 两类：
  //  1) aiErasedBase 已打但没有独立底图槽（本版本之前，AI「擦除」产物只存在
  //     processedImageUrl 里）→ 趁还没被编辑器合成（贴图仍是干净底图）复制一份；
  //     已经合成过的框救不回来（底图里已经有字了），只能重置后重跑一次擦除。
  //  2) 场景是「擦除」且已完成、又不是编辑器合成出来的 —— 手动修补工坊粘回来的
  //     干净底图就是这一类（老版本回填时没写 aiErasedBase，于是被当成 AI 独占
  //     只读、解冻不了）。这里补上标记，之后就能排版 / 解冻填入。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const img of imagesRef.current) {
        for (const r of img.regions) {
          const isEraseProduct =
            (r.aiErasedBase && !r.aiEraseBaseUrl) ||
            (!r.aiErasedBase && !r.editorComposited && r.status === 'completed' && intentOf(r) === 'erase');
          if (!isEraseProduct) continue;
          if (r.editorComposited || !r.processedImageUrl) continue;
          const url = await cloneObjectUrl(r.processedImageUrl);
          if (!url) continue;
          if (cancelled) { releaseObjectURL(url); return; }
          updateImage(img.id, current => ({
            ...current,
            regions: current.regions.map(x =>
              x.id === r.id && !x.aiEraseBaseUrl && !x.editorComposited
                ? { ...x, aiErasedBase: true, editorErased: false, aiEraseBaseUrl: url }
                : x),
          }));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [images, updateImage, intentOf]);

  // AI「擦除」场景产出干净底图后，编辑器这边自动接手：
  //  1. 自动解冻 —— 该框若挂着 held-back 译文，把底图已无原文，直接放出来排版
  //     （不泛洪擦除、不会和图上文字重叠）；
  //  2. 已有 editorText 的，把文字排到 AI 抹干净的底图上（合成器用 aiErasedBase
  //     作底图并跳过擦除）。
  // 每次 (region, patch URL) 只处理一次，避免 update → effect → recomposite 自激；
  // 也保证用户此后手动重新冻结的决定不会被再次覆盖。
  const erasedBaseCompositedRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const img of images) {
      for (const r of img.regions) {
        // 底图用独立槽里的那一份（见 eraseBaseUrlOf），并用底图 URL 作"已接过手"
        // 的键 —— 合成会换掉 processedImageUrl，用它当键会漏判/重复判。
        const baseUrl = eraseBaseUrlOf(r);
        if (!r.aiErasedBase || !baseUrl) continue;
        if (erasedBaseCompositedRef.current.get(r.id) === baseUrl) continue;

        const frozen = r.editorFrozenText?.trim();
        if (frozen && !r.editorText?.trim()) {
          erasedBaseCompositedRef.current.set(r.id, baseUrl);
          const next: Region = {
            ...r,
            editorText: frozen,
            editorFrozenText: undefined,
            // 底图是 AI 擦出来的干净图，不需要再泛洪擦除。
            editorErased: false,
          };
          updateImage(img.id, current => ({
            ...current,
            regions: current.regions.map(x => (x.id === r.id ? next : x)),
          }));
          void recompositeRegion(img.id, r.id, next);
          continue;
        }

        if (r.editorComposited || !r.editorText?.trim()) continue;
        erasedBaseCompositedRef.current.set(r.id, baseUrl);
        void recompositeRegion(img.id, r.id);
      }
    }
  }, [images, recompositeRegion, updateImage]);

  // 气泡框 ⇄ 文字框共享完成状态：气泡内的 text_bubble 全部完成 → 气泡完成；
  // 有一个被重置 → 气泡回到 pending（见 syncBubbleStatuses 的升降级规则）。
  // 两个工作流因此看到同一个"已完成"：编辑器嵌字完成后，AI 重绘里那颗泡泡不
  // 再是待处理目标（管线只挑 pending / failed），也就不会被重画覆盖。
  // 只在状态确实变了时才写回（无变化返回 null），images → effect →
  // updateImage → images 因此不会自激。
  useEffect(() => {
    for (const img of images) {
      if (!syncBubbleStatuses(img.regions)) continue;
      updateImage(img.id, current => {
        // Recompute on the live state: updateImage may run against a newer
        // commit than the one this effect rendered from.
        const synced = syncBubbleStatuses(current.regions);
        return synced ? { ...current, regions: synced } : current;
      });
    }
  }, [images, updateImage]);

  /**
   * Drop a region's cached erased base (the blob URL + the decoded copy).
   *
   * The cache is only advisory: it invalidates on geometry / original-vs-AI-base
   * change, so it must be dropped EXPLICITLY when the user takes an erasure back
   * — otherwise re-erasing the same box would silently reuse the stale result
   * and never ask the backend again (a backend algorithm update or a residue-y
   * pass would stay on screen forever).
   */
  const dropErasedCache = useCallback((regionId: string) => {
    const entry = erasedCacheRef.current.get(regionId);
    if (entry) {
      releaseObjectURL(entry.url);
      erasedCacheRef.current.delete(regionId);
    }
  }, []);

  // AI「擦除」产物 vs 编辑器加的底图层：只要本框拿到了 AI 抹干净的底图
  // （aiErasedBase），编辑器那两份会盖住底图的图层就全部作废 —— 泛洪擦除
  // （editorErased）和画笔修补（editorBrushUrl，全涂白 / 涂黑 / 笔画都会糊住
  // 这张干净底图）。擦除缓存一并丢弃（否则再次合成会复用"在原图上擦出来的"
  // 旧结果），然后重建贴图。
  // 兜底用：管线写回完成时已经清过 editorErased，这里替老会话 / 导入的工态收尾；
  // 两个标记都清掉后本 effect 自然不再命中。
  useEffect(() => {
    for (const img of images) {
      const stale = img.regions.filter(r => r.aiErasedBase && (r.editorErased || r.editorBrushUrl));
      if (stale.length === 0) continue;
      stale.forEach(r => dropErasedCache(r.id));
      // 画笔 blob 不在这里 release：history 快照可能还引用着同一份（与 handBack
      // 同一处理）。清空字段即可，免得撤销时贴图指向已回收的 URL。
      const nextById = new Map<string, Region>(
        stale.map(r => [r.id, { ...r, editorErased: false, editorBrushUrl: undefined } as Region])
      );
      updateImage(img.id, current => ({
        ...current,
        regions: current.regions.map(r => nextById.get(r.id) ?? r),
      }));
      for (const nr of nextById.values()) {
        void recompositeRegion(img.id, nr.id, nr);
      }
    }
  }, [images, updateImage, recompositeRegion, dropErasedCache]);

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
    // 撤回擦除（editorErased: false）—— 这一版擦除结果不要了，缓存一并丢弃，
    // 之后再点擦除就会重新请求后端。缓存不能等几何变化才失效，见上。
    if (updates.editorErased === false) dropErasedCache(regionId);
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
  }, [getImage, updateImage, scheduleRecomposite, dropErasedCache]);

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
    // aiErasedBase = AI「擦除」产物就是这一格的画面：画笔层会盖住它，一律拒绝
    // （UI 已禁用；这里再兜一道，防止老会话 / 快捷键等旁路绕进来）。
    if (target.aiErasedBase) return;
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

  /** Drop the per-region erase cache + any pending composite (region deleted). */
  const dropRegionCache = useCallback((imageId: string, regionId: string) => {
    dropErasedCache(regionId);
    const key = `${imageId}|${regionId}`;
    const timer = debounceRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      debounceRef.current.delete(key);
    }
  }, [dropErasedCache]);

  /**
   * Translate-target picker: every editable text region (text_bubble +
   * text_free + manual boxes) — the AI translates the whole page in one call,
   * so a bubble-only scope would just drop text without saving anything.
   * AI-owned regions are always excluded (their content is final), and so are
   * regions that already hold a translation (editorText typeset / manually
   * typed, or editorFrozenText held back) — re-sending those would burn API
   * quota AND overwrite the user's own edits. A page whose regions are all
   * done therefore yields zero targets and the whole call is skipped.
   * 「AI 判定无文字」的空框同样算已处理（editorText 里存着一枚占位空格，
   * 见 EMPTY_TEXT_MARK）—— 否则这类框永远没有被处理的痕迹，翻译按钮会一直
   * 可按、每点一次都整页重发。To force a re-translation of one box, clear its
   * text first (清空后 editorText 为 ''，即回到未处理)。
   */
  const pickTranslateTargets = useCallback((img: UploadedImage): Region[] =>
    img.regions.filter(r => {
      if (r.contextOnly) return false;
      // AI「翻译」意图的完成框也要翻译：译文会 held back（冻结）在编辑器里，不会
      // 和图上 AI 已经画好的中文重叠。其它 AI 独占框（自定义 / 旧版）跳过 ——
      // 它们的内容已经是最终形态。
      if (isAiOwned(r) && intentOf(r) !== 'translate') return false;
      // 「已处理」用存在性判断，不是 trim：AI 判定无文字的空框里存着一个占位
      // 空格（EMPTY_TEXT_MARK），trim 之后同样为空 —— 用 trim 判断的话这些框
      // 永远算未翻译，按钮一直可按、每次点都把整页重发一遍。
      if (isTranslationHandled(r)) return false;
      return true;
    }), [intentOf]);

  /** Stop button: aborts the in-flight translation (single page or batch). */
  const stopTranslation = useCallback(() => {
    translateAbortRef.current?.abort();
  }, []);

  /**
   * Auto-translate one image: a single vision-AI call over all editable
   * regions (annotated full image + numbered skeleton). Every text-bearing
   * region gets a translation; how it lands depends on the AI's freeze flag:
   *  - Normal: source → sourceText (展示用), translation → editorText, region
   *    erased and typeset (status completed).
   *  - Frozen (sfx / stylized lettering / text_free on complex backgrounds):
   *    translation → editorFrozenText only; the original artwork stays
   *    untouched and the region keeps pending status so the AI redraw
   *    pipeline can still pick it up. Manual unfreeze / the 临时预览译文 batch
   *    promote the frozen text into a real typeset patch later.
   * Regions the AI reports as empty (misdetections) are skipped.
   *
   * `outerSignal` is the batch controller's signal when called from
   * translateAllImages; single-page runs create their own controller so the
   * dock's stop button can abort the vision call / gate wait.
   */
  const translateImageRegions = useCallback(async (
    imageId: string,
    outerSignal?: AbortSignal,
    /** Batch-scoped synchronous mirror of the regions this run already
     *  translated. The store commit lags behind updateImage, so the batch's
     *  end-retry hands it in to avoid re-translating a page whose update has
     *  not rendered back into imagesRef yet. Undefined = single-page run. */
    skipRegionIds?: Set<string>
  ) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = pickTranslateTargets(img).filter(r => !skipRegionIds?.has(r.id));
    if (targets.length === 0) return;

    // Batch runs share their controller; single-page runs own one.
    const ownCtrl = outerSignal ? null : new AbortController();
    const signal = outerSignal ?? ownCtrl!.signal;
    if (ownCtrl) translateAbortRef.current = ownCtrl;

    // Mark this page in-flight so the dock locks it while the AI overwrites its
    // regions. `busy` / `translating` are owned by the run driver
    // (translateAllImages / translateSingleImage): under 并发执行 several pages
    // run at once, so resetting them per call here would unlock the whole UI the
    // instant the first page finished, while others are still running.
    markTranslatingImage(imageId, true);
    try {
      const imageEl = await loadImage(img.previewUrl);
      const { results, terms } = await translateEditorRegions(imageEl, targets, configRef.current, signal);

      // Compute post-update region objects up-front (updaters must stay pure,
      // and recomposite needs them explicitly — the store commit lags behind
      // updateImage). fontSize is never touched: undefined means the layout
      // engine auto-fits the new text.
      const translated: Region[] = [];
      const frozen: Region[] = [];
      /** AI 判定「框内没有文字」的框：写入占位空格标记为已处理（EMPTY_TEXT_MARK）。 */
      const emptied: Region[] = [];
      /** 自动识别选中的字体 id：合成前要先从后端取回来。 */
      const neededFontIds = new Set<string>();
      for (const r of targets) {
        const res = results.get(r.id);
        // 模型明确回答「这个框里没有文字」（source 与 zh 都是空串）= 误检/空框。
        // 这是一个**合法的终结答案**，不是失败：往 editorText 写一枚占位空格把
        // 它标成「已处理」，翻译按钮不再一直可按，整批重试也不会反复重发它。
        if (res && !res.source?.trim() && !res.zh?.trim()) {
          emptied.push({ ...r, editorText: EMPTY_TEXT_MARK });
          continue;
        }
        if (!res || !res.zh?.trim()) continue; // 响应不完整 / 模型漏了这个 id
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
          // colorSource 'auto'：这是模型看图猜的粗判（黑/白）。开着自动取色时
          // 擦除量到的实测墨色会覆盖它；用户手动选过的（'manual'）不会被覆盖。
          ...(textColor
            ? { color: textColor, outlineColor: textColor === '#000000' ? '#ffffff' : '#000000', colorSource: 'auto' as const }
            : {}),
          ...(aiFontStack ? { fontFamily: aiFontStack } : {}),
        };
        // AI「翻译」意图已经把这格的中文画进图了：译文一律 held back（冻结），
        // 绝不重新排版 —— 否则会和图上的 AI 文字重叠。
        const isAiTranslated = intentOf(r) === 'translate' && r.status === 'completed' && !r.editorComposited;
        if (res.freeze || r.aiBubbleBase || isAiTranslated) {
          // aiBubbleBase forces the frozen landing even when the AI would
          // typeset: the translation is held back (editorFrozenText) so the
          // AI-redrawn bubble stays untouched until the user reveals the
          // text. The frozen branch's field clearing is exactly right here —
          // no erasure/whiteout may touch the AI base.
          frozen.push({
            ...r,
            sourceText: res.source ?? r.sourceText,
            editorFrozenText: res.zh,
            customTranslation: res.zh,
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
            sourceText: res.source ?? r.sourceText,
            editorText: res.zh,
            customTranslation: res.zh,
            editorFrozenText: undefined,
            // aiBubbleBase / aiErasedBase：底图已经是 AI 重绘出来的干净图
            // （泡底 / 本框擦除产物），直接把译文排上去，不再泛洪擦除。
            editorErased: r.aiBubbleBase || r.aiErasedBase ? false : true,
            editorStyle: style,
          });
        }
      }
      // Land what this call resolved into the batch mirror right away (译文 +
      // 「无文字」标记), so the end-retry scan counts it as done even before
      // React commits the store.
      if (skipRegionIds) for (const nr of [...translated, ...frozen, ...emptied]) skipRegionIds.add(nr.id);

      // 「AI 判定无文字」的标记必须真正落库：它就是这一格的终结答案。不落库的话
      // 空框没有任何已处理的痕迹，翻译按钮会一直可按、每次点都整页重发。
      if (emptied.length > 0) {
        const marksById = new Map(emptied.map(r => [r.id, r]));
        updateImage(imageId, current => ({
          ...current,
          regions: current.regions.map(r => marksById.get(r.id) ?? r),
        }));
      }

      if (translated.length === 0 && frozen.length === 0) {
        // 每个目标框都被模型明确判为空框 → 合法结果：标记已落地，不报错、不重试。
        const allConfirmedEmpty = targets.every(r => {
          const res = results.get(r.id);
          return !!res && !res.source?.trim() && !res.zh?.trim();
        });
        if (allConfirmedEmpty) {
          console.warn('[translate] 本页目标框均被判定无文字，已标记，跳过');
          return;
        }
        // 否则是「响应不完整」（模型漏了某些框，或给了原文却没给译文）：抛出去
        // 让整批重试再试一轮。已标记的空框不会跟着一起重发。
        throw new Error('AI 没有识别到任何文字（可能全部为空框/误检）');
      }

      // 术语表 v2：上报本页术语（合并进术语树）；glossaryAutoUnify 开着时实现方
      // 会顺手把本页框文本按已选标准译名改写并返回新数组 —— 用它替换原数组，
      // 后续的状态提交 / 合成看到的就是统一后的文本。
      if (onPageTerms && (terms.length > 0 || translated.length + frozen.length > 0)) {
        const unified = onPageTerms(imageId, [...translated, ...frozen], terms);
        const unifiedById = new Map(unified.map(r => [r.id, r]));
        for (let i = 0; i < translated.length; i++) translated[i] = unifiedById.get(translated[i].id) ?? translated[i];
        for (let i = 0; i < frozen.length; i++) frozen[i] = unifiedById.get(frozen[i].id) ?? frozen[i];
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
      markTranslatingImage(imageId, false);
      if (ownCtrl && translateAbortRef.current === ownCtrl) {
        translateAbortRef.current = null;
      }
    }
  }, [busy, getImage, recompositeRegion, updateImage, setErrorMsg, pickTranslateTargets, onPageTerms, markTranslatingImage]);

  /**
   * Manual unfreeze (fix an AI false positive): move the frozen translation
   * into editorText, erase the original and typeset — the regular path.
   * aiBubbleBase / aiErasedBase regions skip the erasure: their base is
   * already text-free (an AI-redrawn bubble, or this box's own AI「擦除」
   * patch), so the flood fill has nothing to do — and must not touch the AI
   * result.
   */
  const unfreezeTranslation = useCallback(async (imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || isImageLocked(imageId)) return;
    if (isAiOwned(region) || !region.editorFrozenText?.trim()) return;
    const next: Region = {
      ...region,
      editorText: region.editorFrozenText,
      editorFrozenText: undefined,
      editorErased: region.aiBubbleBase || region.aiErasedBase ? false : true,
    };
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => r.id === regionId ? next : r),
    }));
    await recompositeRegion(imageId, regionId, next);
  }, [isImageLocked, getImage, recompositeRegion, updateImage]);

  /**
   * Manual freeze (the reverse of unfreeze): pull the typeset translation
   * OUT of the image — the translation is held in editorFrozenText and every
   * layer this box painted over the base comes off (erasure / whiteout /
   * brush).
   *
   * 冻结只撤"译文和编辑器自己加的图层"，**不撤 AI 重绘 / 手动修补的产物**：
   * 本框若贴着 AI「擦除」产出的干净底图，冻结后画面就是那张底图，状态仍是
   * 'completed'（合成器保证这一格永远有图）。要丢掉产物只能去那两个页面点框上
   * 的 ↺ 重置。
   *
   * "Restore the original" means EVERY background layer this box put over the
   * artwork comes back off, not just the erasure: the flood-fill erase
   * (editorErased), the brute-force whiteout (editorWhitedOut) AND the brush
   * layer (editorBrushUrl — 全涂白 / 涂黑 / 涂抹). Leaving the brush layer
   * behind used to keep a white box on screen after the translation was pulled
   * out, which defeats the point of freezing.
   */
  const freezeTranslation = useCallback(async (imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || isImageLocked(imageId)) return;
    if (isAiOwned(region) || !region.editorText?.trim()) return;
    // Hand the erasure back: the next erase must re-run the backend instead of
    // reusing the cached (pre-freeze) erased base.
    dropErasedCache(regionId);
    if (region.editorBrushUrl) releaseObjectURL(region.editorBrushUrl);
    const next: Region = {
      ...region,
      editorFrozenText: region.editorText,
      editorText: undefined,
      editorErased: false,
      editorWhitedOut: false,
      editorBrushUrl: undefined,
    };
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => r.id === regionId ? next : r),
    }));
    // Recomposite with nothing left to render → tears the patch down.
    await recompositeRegion(imageId, regionId, next);
  }, [isImageLocked, getImage, recompositeRegion, updateImage, dropErasedCache]);

  /**
   * 重置 one region (the canvas' Reset / Redo button).
   *
   * 语义 = 「把这一格交回 AI 重绘」，落点和 dock 的「冻结翻译」一致：
   *  - 产物消失：贴图丢掉、editorComposited 复位、status 回到 'pending'
   *    （结果视图与拼接都只认 'completed'），于是管线可以重新挑到它；
   *  - 原图复原：擦除（editorErased）、涂白（editorWhitedOut）以及 AI 底图
   *    标记（aiBubbleBase / aiErasedBase）全部撤回 —— 不撤回的话，贴图已经
   *    没了，编辑器却还把它显示成「已擦除」；
   *  - 已嵌的字转为冻结译文（editorText → editorFrozenText），绝不随重置一起
   *    丢掉。原本就挂着 editorFrozenText 的 AI「翻译」产物同理保留。
   *
   * A `bubble` ALSO resets the text_bubble regions it contains: the bubble
   * derives its own completion from them (see syncBubbleStatuses), so resetting
   * only the bubble would be undone by the very next sync pass and the bubble
   * could never be handed back to the AI.
   *
   * The brush layer is deliberately kept — it is background touch-up the user
   * painted, not a generated result. The dropped patch's blob URL is NOT
   * released here: the history entry of the current state shares the very same
   * URL (handleUpdateRegions keeps history[historyIndex].regions in sync), so
   * revoking it would break undo/redo.
   */
  const resetRegion = useCallback((imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || region.status === 'processing') return;
    // Same containment rule the AI pipeline uses to mark aiBubbleBase children.
    const children = region.detectedClass === 'bubble'
      ? findContainedTextRegions(img.regions, region)
      : [];

    /**
     * Back to "nothing generated here yet" + 原图复原 + 已嵌的字转冻结。
     * See the doc comment above for why each flag is dropped.
     */
    const handBack = (r: Region): Region => {
      // 撤回擦除 = 这份结果不要了，缓存一并丢弃（见 dropErasedCache）：之后
      // 再点擦除会重新请求后端，而不是复用"重置前那张"的旧结果。
      if (r.editorErased) dropErasedCache(r.id);
      return {
        ...r,
        status: 'pending' as const,
        processedImageUrl: undefined,
        editorComposited: false,
        patchMarginX: undefined,
        patchMarginY: undefined,
        restoreBoxes: undefined,
        editorErased: false,
        editorWhitedOut: false,
        aiBubbleBase: undefined,
        aiErasedBase: undefined,
        // 擦除产物一起作废（不 release：history 里可能还引用着同一份 blob）。
        aiEraseBaseUrl: undefined,
        // 「AI 判定无文字」的占位空格：重置 = 这一格整个交回 AI，标记一并清掉，
        // 否则它会一直算「已处理」，再也不会被翻译选中。
        ...(r.editorText !== undefined && !r.editorText.trim() ? { editorText: undefined } : {}),
        ...(r.editorText?.trim()
          ? { editorFrozenText: r.editorText, editorText: undefined }
          : {}),
      };
    };

    // A run owns a 'processing' child — never pull it out from under the API.
    const targets = [region, ...children.filter(c => c.status !== 'processing')];
    const nextById = new Map<string, Region>(targets.map(t => [t.id, handBack(t)]));
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => nextById.get(r.id) ?? r),
    }));
  }, [getImage, updateImage, dropErasedCache]);

  /**
   * 「临时预览译文」：把被 AI 标记为冻结的框粗暴涂白（editorWhitedOut —— 泛洪擦除
   * 啃不动的复杂背景就靠这张白底）再把译文排上去，只为先看一眼前译文。
   *
   * Rewrites EVERY frozen box in the image — 气泡内的复杂文字同样会被 AI 标记为
   * 冻结，所以这里**不再限定 text_free** —— including boxes the user froze by
   * hand from the dock, so the preview is a true page-wide batch. 反向就是
   * `refreezeInImage`（「结束预览」），两者互为精确逆操作，所以不需要撤销栈。
   */
  const whitenInImage = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      // aiErasedBase 是 AI「擦除」的产物：底图已经是干净图，涂白反而盖掉它 ——
      // 跳过（这类框用逐框「解冻填入」直接排字更合适）。
      !r.aiErasedBase &&
      !!r.editorFrozenText?.trim()
    );
    if (targets.length === 0) return;

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
  }, [getImage, recompositeRegion, updateImage]);

  /** 临时预览译文 on the current image. */
  const previewFrozenText = useCallback(async (imageId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await whitenInImage(imageId);
    } finally {
      setBusy(false);
    }
  }, [busy, whitenInImage]);

  /** Batch variant: the same 临时预览 over every loaded image. */
  const previewFrozenTextAllImages = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const img of imagesRef.current) {
        await whitenInImage(img.id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, whitenInImage]);

  /**
   * Reverse of the preview: freeze the boxes that 「临时预览译文」whitened back
   * up — the whiteout and the typeset text are removed (the original artwork
   * comes back) and the translation is held in editorFrozenText again, ready for
   * the AI redraw pipeline.
   *
   * Recognition is state-based, not remembered: editorWhitedOut is only ever set
   * by the preview, so "whited out + has text" is exactly its output. 这里也**不
   * 限定 text_free** —— 识别靠的是 editorWhitedOut，与检测类别无关。
   */
  const refreezeInImage = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      !!r.editorWhitedOut && !!r.editorText?.trim()
    );
    if (targets.length === 0) return;

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
  }, [getImage, recompositeRegion, updateImage]);

  /** 结束预览 on the current image. */
  const endPreview = useCallback(async (imageId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await refreezeInImage(imageId);
    } finally {
      setBusy(false);
    }
  }, [busy, refreezeInImage]);

  /** Batch variant: the same 结束预览 over every loaded image. */
  const endPreviewAllImages = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const img of imagesRef.current) {
        await refreezeInImage(img.id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, refreezeInImage]);

  /**
   * Shared driver for one translate run: sweep `pickIds()` and, when the sweep
   * ends with pages still holding untranslated boxes (their vision call failed
   * / returned nothing), sweep them again — at most `config.maxRetryRounds`
   * extra rounds. Used by both the 「全部图片」 batch and the 「当前图片」
   * single-page entry, so the end-retry applies to either scope.
   *
   * A run-scoped synchronous mirror (`skipRegionIds`) keeps a box the store has
   * not rendered as done yet from being re-sent (imagesRef lags updateImage).
   *
   * Each page is one vision call, so the sweep runs pages through
   * `runWithConcurrency` honouring 处理选项: 「并发执行」 with `concurrencyLimit`
   * pages in flight at once, 「串行执行」 one page at a time. Timeout per
   * request comes from `config.apiTimeout` (see editorTranslate).
   */
  const runTranslateRounds = useCallback(async (pickIds: () => string[], ctrl: AbortController) => {
    const skipRegionIds = new Set<string>();
    // 整批重试轮数（0 = 关闭），由设置面板配置。
    const endRetryBudget = Math.max(0, configRef.current.maxRetryRounds ?? DEFAULT_MAX_END_RETRY_ROUNDS);
    for (let attempt = 0; ; attempt++) {
      if (ctrl.signal.aborted) break;
      // Re-pick targets every round: boxes still untranslated are swept again.
      const ids = pickIds().filter(id => {
        const img = imagesRef.current.find(i => i.id === id);
        return !!img && pickTranslateTargets(img).some(r => !skipRegionIds.has(r.id));
      });
      if (ids.length === 0) break;
      const cfg = configRef.current;
      const limit = cfg.executionMode === 'serial'
        ? 1
        : Math.max(1, Math.floor(cfg.concurrencyLimit) || 1);
      // runWithConcurrency never rejects: a page that throws is logged and
      // skipped (translateImageRegions already surfaces the error itself), so
      // one bad page can't abort the whole batch.
      await runWithConcurrency(ids, limit, id => translateImageRegions(id, ctrl.signal, skipRegionIds), ctrl.signal, 0);
      if (ctrl.signal.aborted) break;
      if (attempt >= endRetryBudget) break;
    }
  }, [translateImageRegions, pickTranslateTargets]);

  /**
   * Batch variant: translate every loaded image that has editable regions.
   * The sweep runs 串行 or 并发 per 处理选项 (see runTranslateRounds). Per-image
   * failures surface via setErrorMsg but do not abort the batch. One shared
   * AbortController lets the stop button cancel the in-flight requests AND skip
   * the remaining images.
   */
  const translateAllImages = useCallback(async () => {
    if (busy) return;
    const ctrl = new AbortController();
    translateAbortRef.current = ctrl;
    setBusy(true);
    setTranslating(true);
    try {
      await runTranslateRounds(() => imagesRef.current.map(img => img.id), ctrl);
    } finally {
      setBusy(false);
      setTranslating(false);
      setTranslatingImageIds(new Set());
      if (translateAbortRef.current === ctrl) translateAbortRef.current = null;
    }
  }, [busy, runTranslateRounds]);

  /**
   * Single-image variant (作用范围 = 当前图片): same sweep + end-retry as the
   * batch, just scoped to one page. The retry matters here too — a failed
   * vision call leaves the page's boxes untranslated, and without a re-sweep
   * this is the only attempt the user gets.
   */
  const translateSingleImage = useCallback(async (imageId: string) => {
    if (busy) return;
    const ctrl = new AbortController();
    translateAbortRef.current = ctrl;
    setBusy(true);
    setTranslating(true);
    try {
      await runTranslateRounds(() => [imageId], ctrl);
    } finally {
      setBusy(false);
      setTranslating(false);
      setTranslatingImageIds(new Set());
      if (translateAbortRef.current === ctrl) translateAbortRef.current = null;
    }
  }, [busy, runTranslateRounds]);

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

  /**
   * Drop every in-memory editor cache. Called when the gallery is wholesale
   * replaced (work-state import): the erased-base cache is keyed by region
   * geometry only (`regionGeomKey`), so leftovers from the previous gallery
   * could otherwise be reused for restored images that happen to share a
   * region id and box.
   */
  const clearEditorCaches = useCallback(() => {
    erasedCacheRef.current.forEach(e => releaseObjectURL(e.url));
    erasedCacheRef.current.clear();
    debounceRef.current.forEach(t => clearTimeout(t));
    debounceRef.current.clear();
    editStampRef.current.clear();
    compositingRef.current.clear();
    compositedAtRef.current.clear();
    aiBaseRebasedRef.current.clear();
    erasedBaseCompositedRef.current.clear();
    setComputedFontSizes(prev => (Object.keys(prev).length === 0 ? prev : {}));
  }, []);

  return {
    busy,
    translating,
    translatingImageIds,
    computedFontSizes,
    updateEditorRegion,
    setBrushLayer,
    dropRegionCache,
    translateImageRegions,
    translateAllImages,
    translateSingleImage,
    stopTranslation,
    unfreezeTranslation,
    freezeTranslation,
    resetRegion,
    previewFrozenText,
    previewFrozenTextAllImages,
    endPreview,
    endPreviewAllImages,
    resyncEditedRegions,
    refreshEditorPatches,
    buildBrushBase,
    clearEditorCaches,
    recompositeRegion,
  };
}
