import { useCallback, useEffect, useRef, useState } from 'react';
import { AppConfig, Region, UploadedImage, RedrawIntent, effectiveIntentOf, EMPTY_TEXT_MARK, isTranslationHandled } from '../types';
import { loadImage, releaseObjectURL, cloneObjectUrl } from '../services/imageUtils';
import { translateEditorRegions } from '../services/editorTranslate';
import { PageTerm } from '../services/glossaryBook';
import {
  compositeRegionPatch,
  measureRegionInk,
  regionNeedsComposite,
  findCoveringCompletedBubble,
  findContainedTextRegions,
  syncBubbleStatuses,
  eraseBaseUrlOf,
  buildErasedPageCanvas,
  ErasedCacheEntry,
  EraseCachePersist,
} from '../services/mangaEditor';
import { editorFontStack, ensureEditorFontLoaded, fontIdFromStack } from '../services/fontService';
import { runWithConcurrency } from '../services/concurrencyUtils';
import {
  loadEraseRecord,
  saveEraseRecord,
  deleteEraseRecordsForRegion,
  clearEraseRecords,
} from '../services/sessionStore';


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
 * 「编辑器泛洪擦除」过的框 —— 「重新擦除」的作用目标（见 reeraseInImage）。
 *
 * 只认 editorErased（编辑器自己擦出来的那层）。AI 重绘的「擦除」产物
 * （aiErasedBase）不是编辑器擦的，绝不能重做；AI 独占框同理跳过。
 *
 * `onlyInsideBubble`（AppConfig.eraseOnlyInsideBubble）打开时再掐一道：只要检测为
 * 气泡内文字的框（text_bubble）。气泡外的自由文字 / 拟声词用本地擦除往往越擦越糊，
 * 那一类留给 AI 重绘的「擦除」场景或冻结更合适。判定只看检测类别，手画框
 * （没有 detectedClass）按「气泡外」处理。
 */
export const isReerasableRegion = (r: Region, onlyInsideBubble = false): boolean =>
  !r.contextOnly && !isAiOwned(r) && !r.aiErasedBase && !!r.editorErased &&
  (!onlyInsideBubble || r.detectedClass === 'text_bubble');

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
  /** 后台补色已经排队过的 `imageId|regionId|几何` —— 首帧用黑字白边出图后，
   *  同一几何只打一次 /erase，避免每次重绘都重复请求。 */
  const inkFetchRef = useRef<Set<string>>(new Set());

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
   * 擦除底图的持久化适配器（见 EraseCachePersist）。
   *
   * 泛洪擦除一次要跑完整条像素管线（后端不可用时是主线程同步算法，秒级），而结果
   * 只跟「图片 + 底图变体 + 框几何 + ROI」有关 —— 会话恢复出来的图库这些全都一样，
   * 所以把上次的结果落盘复用，重开编辑器不必再泛洪一遍。
   *
   * 只在开着「会话持久化」时启用：关掉时图库本来就不会恢复，imageId 每次都是新的，
   * 写了也永远不会被读到（白占空间）。
   */
  const buildErasePersist = useCallback((
    imageId: string,
    appliedAsOriginal: boolean
  ): EraseCachePersist | undefined => {
    if (!configRef.current.enableSessionPersistence) return undefined;
    // 持久键包含底图变体：应用为原图之后像素变了，旧结果不能再用。
    const keyOf = (regionId: string, geomKey: string) =>
      `${imageId}|${appliedAsOriginal ? 'applied' : 'src'}|${regionId}|${geomKey}`;
    return {
      load: async (regionId, geomKey) => {
        // 读不到 / 读坏了都只是「这次重新擦」：绝不让缓存问题打断合成。
        try {
          const rec = await loadEraseRecord(keyOf(regionId, geomKey));
          if (!rec) return null;
          // 每个会话一份新的 Object URL（老的已随上次会话消失），解码仍由调用方懒做。
          return {
            geomKey,
            url: URL.createObjectURL(rec.blob),
            dx: rec.dx,
            dy: rec.dy,
            w: rec.w,
            h: rec.h,
            textColor: rec.textColor,
            bgColor: rec.bgColor,
          };
        } catch (e) {
          console.warn('[erase-cache] 恢复失败，将重新擦除', e);
          return null;
        }
      },
      save: (regionId, entry, blob) => {
        void saveEraseRecord({
          key: keyOf(regionId, entry.geomKey),
          imageId,
          regionId,
          blob,
          dx: entry.dx,
          dy: entry.dy,
          w: entry.w,
          h: entry.h,
          textColor: entry.textColor,
          bgColor: entry.bgColor,
          savedAt: Date.now(),
        });
      },
    };
  }, []);

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
        onStage,
        buildErasePersist(imageId, !!img.appliedAsOriginal),
        !!(configRef.current.detectionTextMask || configRef.current.editorAutoTextColor)
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

      // 首帧已经用黑字白边出图了。检测没给色、又没走过擦除的框（手画框 / 旧
      // 会话）在后台补一次取色：拿到墨色再写回样式并重建这一格，期间文字
      // 立即可见，只有颜色会稍后跳变一次，不再让用户盯着空白等 /erase。
      const inkCfg = configRef.current;
      const hasMeasuredInk = region.editorStyle?.colorSource === 'auto'
        && !!region.editorStyle.color
        && region.editorStyle.color !== '#000000'
        && region.editorStyle.color !== '#ffffff';
      if (inkCfg.editorAutoTextColor && inkCfg.pythonBackendUrl
          && !region.inkColor && !region.editorErased && !hasMeasuredInk
          && region.editorStyle?.colorSource !== 'manual') {
        const geom = `${region.x},${region.y},${region.width},${region.height}`;
        const inkKey = `${imageId}|${regionId}|${geom}`;
        if (!inkFetchRef.current.has(inkKey)) {
          inkFetchRef.current.add(inkKey);
          const imgW = imageEl instanceof HTMLImageElement
            ? imageEl.naturalWidth : imageEl.width;
          const imgH = imageEl instanceof HTMLImageElement
            ? imageEl.naturalHeight : imageEl.height;
          void (async () => {
            try {
              const color = await measureRegionInk(imageEl, region, {
                imgW, imgH,
                contextBubbles: getContextBubbles(img),
                pythonBackendUrl: inkCfg.pythonBackendUrl,
                useTextMask: !!(inkCfg.detectionTextMask || inkCfg.editorAutoTextColor),
              });
              if (!color) return;
              // 取色回来时框可能已被删 / 拖动 / 改成手动色 / 开关被关掉。
              const cur = getImage(imageId)?.regions.find(r => r.id === regionId);
              if (!cur || !configRef.current.editorAutoTextColor
                  || cur.editorStyle?.colorSource === 'manual'
                  || `${cur.x},${cur.y},${cur.width},${cur.height}` !== geom) return;
              updateEditorRegion(imageId, regionId, {
                editorStyle: {
                  ...cur.editorStyle,
                  color,
                  outlineColor: undefined,
                  outlineWidth: undefined,
                  colorSource: 'auto' as const,
                },
              }, { debounceMs: 0 });
            } catch {
              // 量不到就保持黑字白边，不打断编辑。
            }
          })();
        }
      }

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
  }, [getImage, updateImage, setErrorMsg, buildErasePersist]);

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

  // AI「擦除」场景产出干净底图后，编辑器这边自动接手。三件事必须在**同一个
  // effect、同一次合成**里做完：
  //  1. 自动解冻 —— 该框若挂着 held-back 译文，底图已经没有原文，直接放出来排版
  //     （不泛洪擦除、不会和图上文字重叠）；
  //  2. 作废会盖住这张干净底图的编辑器图层（泛洪擦除 editorErased / 画笔层）；
  //  3. 已有 editorText 的，把文字排到 AI 抹干净的底图上（合成器用 aiErasedBase
  //     作底图并跳过擦除）。
  //
  // 为什么必须合并成一个 effect：以前 1+3 一个、2 另一个，各自拿「本批 commit 的
  // 快照」整块覆盖这一格 —— 解冻刚写进 store 的 editorText 会被另一个 effect 的
  // 清图层写入抹掉（症状：只擦了文字、没有台词，而且「已接手」的键已经记下，再也
  // 不会重试）；两者的 recomposite 还会互抢：先发起的那次若最后落地，就把没字的
  // 贴图盖回来了。
  //
  // 写回一律走**字段级补丁**（updater 里只改自己那几个字段），同一批 commit 里
  // 编辑器写的别的字段（译文、字色…）因此不会被快照覆盖。
  // 「已接手」的键用底图 URL：合成会换掉 processedImageUrl，用它当键会漏判/重复判；
  // 键也保证用户此后手动重新冻结的决定不会被再次覆盖。
  const erasedBaseCompositedRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const img of images) {
      for (const r of img.regions) {
        if (!r.aiErasedBase) continue;
        // 底图用独立槽里的那一份（见 eraseBaseUrlOf）。
        const baseUrl = eraseBaseUrlOf(r);
        const alreadyHandled = !!baseUrl && erasedBaseCompositedRef.current.get(r.id) === baseUrl;

        // 1) 解冻填入：有独立底图槽、挂着冻结译文、还没排字。
        const canUnfreeze = !alreadyHandled && !!baseUrl
          && !!r.editorFrozenText?.trim() && !r.editorText?.trim();
        // 2) 清图层：这两层会盖住 AI 抹干净的底图，**不限次数** —— 用户之后又涂了
        //    画笔，照样要清掉。
        const needsLayerCleanup = !!r.editorErased || !!r.editorBrushUrl;
        // 3) 已有文字、但还没排到**这张**底图上 → 重排一次。
        //    刻意不看 editorComposited：贴图换成 AI 干净底图之后，旧的那张合成结果
        //    已经作废（图上文字没了），而 editorComposited 仍然是 true —— 以前正是
        //    这个条件让「之前合成过的框」永远不再重排，表现为「只擦了字、没台词」。
        //    「是否已经接手过」由上面的 baseUrl 键判断，不会来回自激。
        const needsTypeset = !alreadyHandled && !!baseUrl && !!r.editorText?.trim();

        if (!canUnfreeze && !needsLayerCleanup && !needsTypeset) continue;
        if (baseUrl) erasedBaseCompositedRef.current.set(r.id, baseUrl);

        // 合成用的那一版（effect 快照 + 本次改动）。写回不用它，见下面的字段级补丁。
        const patched: Region = {
          ...r,
          ...(canUnfreeze
            ? { editorText: r.editorFrozenText, editorFrozenText: undefined, editorFrozenByErase: undefined }
            : {}),
          // 底图是 AI 擦出来的干净图，不需要再泛洪擦除。
          ...(needsLayerCleanup ? { editorErased: false, editorBrushUrl: undefined } : {}),
        };

        updateImage(img.id, current => ({
          ...current,
          regions: current.regions.map(x => {
            if (x.id !== r.id || !x.aiErasedBase) return x;
            // 解冻用**当前**的冻结译文（本轮可能刚被翻译写进来），不用快照里的。
            const unfreeze = canUnfreeze && !x.editorText?.trim() && !!x.editorFrozenText?.trim();
            if (!unfreeze && !needsLayerCleanup) return x;
            return {
              ...x,
              ...(unfreeze
                ? { editorText: x.editorFrozenText, editorFrozenText: undefined, editorFrozenByErase: undefined }
                : {}),
              ...(needsLayerCleanup ? { editorErased: false, editorBrushUrl: undefined } : {}),
            };
          }),
        }));
        void recompositeRegion(img.id, r.id, patched);
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
   *
   * 落盘的那份一起删：这个方法就是「用户主动要求重擦」的信号（撤回擦除 / 冻结 /
   * 重置），留着持久记录会让同一个几何永远命中旧结果，用户的重擦点了也没用。
   */
  const dropErasedCache = useCallback((regionId: string) => {
    const entry = erasedCacheRef.current.get(regionId);
    if (entry) {
      releaseObjectURL(entry.url);
      erasedCacheRef.current.delete(regionId);
    }
    void deleteEraseRecordsForRegion(regionId);
  }, []);

  // AI「擦除」产物 vs 编辑器的擦除缓存：本框拿到 AI 抹干净的底图后，编辑器那份
  // 泛洪擦除结果就作废了（合成器对 aiErasedBase 根本不会再擦）。
  // 这里**只丢缓存、不写任何状态** —— 清图层与自动解冻由上面那个「擦除底图接手」
  // effect 负责；以前这一步是连同状态一起写的，用的却是本批 commit 的快照，会把
  // 解冻刚写进去的 editorText 整块覆盖掉（「只擦了字、没台词」的根因之一）。
  useEffect(() => {
    for (const img of images) {
      for (const r of img.regions) {
        if (!r.aiErasedBase) continue;
        if (!erasedCacheRef.current.has(r.id)) continue;
        dropErasedCache(r.id);
      }
    }
  }, [images, dropErasedCache]);

  /**
   * Merge editor field updates into a region and schedule a recomposite.
   *
   * `opts.debounceMs` overrides the wait before that recomposite: typing wants
   * the long window (every keystroke restarts it, so nothing composites until
   * the user pauses), while discrete actions want the short one — see
   * DISCRETE_RECOMPOSITE_DEBOUNCE_MS.
   */
  /**
   * 「擦除成功后自动冻结」（AppConfig.freezeErasedBoxes）：编辑器擦除一落地，就把
   * 已经排上的译文搬进 editorFrozenText —— 画面上只留擦干净的底图，译文转成冻结态
   * 等 AI 重绘去画中文（本地擦除在气泡里很准，本地嵌字却常常还原不了观感）。
   *
   * 没有译文的框没有可冻结的东西，原样返回。打 editorFrozenByErase 标记：关掉开关
   * 时要靠它认出「这些冻结是本功能造成的」，才敢还原成编辑器擦除（见 syncEraseFreeze）。
   */
  const freezeErasedIfNeeded = useCallback((r: Region, updates: EditorFieldUpdates): Region => {
    if (!configRef.current.freezeErasedBoxes) return r;
    // 只认「这一次更新把擦除打开」：擦完之后用户在框里手打译文不该被抢进冻结区
    // （那时候他要的是自己嵌字，不是交给 AI）。批次对齐走 syncEraseFreeze。
    if (updates.editorErased !== true) return r;
    if (!r.editorErased || !r.editorText?.trim() || r.aiErasedBase) return r;
    return { ...r, editorFrozenText: r.editorText, editorText: undefined, editorFrozenByErase: true };
  }, []);

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
    const nextRegion = target ? freezeErasedIfNeeded(mergeEditorUpdates(target, updates), updates) : undefined;
    updateImage(imageId, img => ({
      ...img,
      regions: img.regions.map(r => (r.id === regionId ? freezeErasedIfNeeded(mergeEditorUpdates(r, updates), updates) : r)),
    }));
    scheduleRecomposite(imageId, regionId, opts?.debounceMs, nextRegion);
  }, [getImage, updateImage, scheduleRecomposite, dropErasedCache, freezeErasedIfNeeded]);

  /**
   * 批量编辑：对一批框施加同一套 editor 字段更新（多选面板用）。
   *
   * 与单框的 updateEditorRegion 同一套规则，只是"更新内容"由调用方按每个框的
   * **当前值**现算 —— 字号步进这类操作必须按各自的基准走（一个框 20px、另一个
   * 30px，一起 +5 应该是 25 / 35，不是统一成某一个值）。`buildUpdates` 返回
   * null / {} 表示这一框跳过（例如字号已到边界）。
   *
   * AI 独占框一律跳过（与单框路径同一规则）；每个被改动的框单独排队合成。
   * 返回实际改动的框数（0 = 什么都没做，调用方据此决定是否提示）。
   */
  const updateEditorRegions = useCallback((
    imageId: string,
    regionIds: string[],
    buildUpdates: (region: Region) => EditorFieldUpdates | null,
    opts?: { debounceMs?: number }
  ): number => {
    const img = getImage(imageId);
    if (!img || regionIds.length === 0) return 0;
    const idSet = new Set(regionIds);
    const nextById = new Map<string, Region>();
    for (const r of img.regions) {
      if (!idSet.has(r.id) || isAiOwned(r)) continue;
      const updates = buildUpdates(r);
      if (!updates || Object.keys(updates).length === 0) continue;
      // 撤回擦除（editorErased: false）与单框路径一样要丢掉擦除缓存。
      if (updates.editorErased === false) dropErasedCache(r.id);
      nextById.set(r.id, freezeErasedIfNeeded(mergeEditorUpdates(r, updates), updates));
    }
    if (nextById.size === 0) return 0;
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => nextById.get(r.id) ?? r),
    }));
    // 每个框单独排队合成（防抖键是 imageId|regionId，互不影响）。
    for (const [id, nr] of nextById) {
      scheduleRecomposite(imageId, id, opts?.debounceMs, nr);
    }
    return nextById.size;
  }, [getImage, updateImage, scheduleRecomposite, dropErasedCache, freezeErasedIfNeeded]);

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
  /**
   * 显式选区翻译（「翻译此框」/「翻译选中」）的目标过滤。
   *
   * 与 pickTranslateTargets 同一套排除规则，**只少一条**：不再排除「已经处理过」
   * 的框 —— 用户点这个按钮就是在明确要求翻译 / 重新翻译这几格，已经翻过的必须
   * 重新送一遍（否则「重新翻译」点了等于没点）。
   */
  const pickExplicitTranslateTargets = useCallback((img: UploadedImage, ids: Set<string>): Region[] =>
    img.regions.filter(r => {
      if (!ids.has(r.id)) return false;
      // 翻译不理会「置信度过滤」：见 pickTranslateTargets 的说明。
      if (r.contextOnly) return false;
      if (isAiOwned(r) && intentOf(r) !== 'translate') return false;
      return true;
    }), [intentOf]);

  /**
   * 整页翻译的目标框。
   *
   * **不套用「置信度过滤」阈值** —— 翻译一律按检测下限（0.3）取框，也就是把检测
   * 返回的所有文字框都翻掉。理由：
   *  - 导出成品本来就不含被过滤的框（见 App.resolveResultUrl / stitchImage），
   *    多翻它们不会污染结果；
   *  - 译文是「先备好、随时可用」的资产：用户把某张图的阈值从 0.9 临时降到 0.3
   *    时，那些刚露出来的框已经有译文 / 已嵌字，直接就能用，不必再等一轮翻译。
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
    skipRegionIds?: Set<string>,
    /** 只翻这几格（「翻译此框」/「翻译选中」）：给了就用 pickExplicitTranslateTargets
     *  —— 已翻过的框也重新送一遍（重新翻译）。undefined = 整页翻译。 */
    onlyRegionIds?: Set<string>
  ) => {
    const img = getImage(imageId);
    if (!img || busy) return;
    const targets = (onlyRegionIds
      ? pickExplicitTranslateTargets(img, onlyRegionIds)
      : pickTranslateTargets(img)
    ).filter(r => !skipRegionIds?.has(r.id));
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
      // 擦除判定（默认关）：先把这批框的原文擦一遍，产出一张干净整页当**第二张图**，
      // 让模型在翻译的同时判断每框擦得干不干净 —— 判定完全由模型负责，本地不否决。
      let erasedPage: HTMLCanvasElement | undefined;
      if (configRef.current.enableEraseJudgedFreeze) {
        try {
          erasedPage = await buildErasedPageCanvas(imageEl, targets, {
            imgW: imageEl.naturalWidth,
            imgH: imageEl.naturalHeight,
            contextBubbles: getContextBubbles(img),
            pythonBackendUrl: configRef.current.pythonBackendUrl,
            useTextMask: !!(configRef.current.detectionTextMask || configRef.current.editorAutoTextColor),
            signal,
          });
        } catch (e) {
          // 预擦除整条挂掉不能让翻译跟着挂：退回「不带第二张图」的今天行为。
          console.warn('[翻译] 预擦除失败，本次翻译不带擦除对照图', e);
        }
      }
      // 预擦除期间被停掉：别再往下做标注图（两张整页编码不便宜）。
      if (signal.aborted) return;
      const { results, terms } = await translateEditorRegions(imageEl, targets, configRef.current, signal, erasedPage);

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
        // 检测阶段已经量到真实墨色、自动取色又开着时，别让模型「黑/白」的
        // 粗判把样式冲掉 —— 否则 dock 色块会在翻译之后突然变回黑色。
        const hasDetectedInk = configRef.current.editorAutoTextColor && !!r.inkColor;
        // 字体自动识别：res.font 为具体字体 id 时覆盖本框字体；空串是「常规
        // 印刷体」——不覆盖，让该框继续跟随全局「编辑器字体」。
        const aiFontStack = res.font ? editorFontStack(res.font) : undefined;
        if (res.font) neededFontIds.add(res.font);
        const style: Region['editorStyle'] = {
          ...r.editorStyle,
          ...(res.vertical === undefined ? {} : { isVertical: res.vertical }),
          // colorSource 'auto'：这是模型看图猜的粗判（黑/白）。用户手动选过的
          // （'manual'）不会被覆盖。
          ...(textColor && !hasDetectedInk
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
            // 重绘标记：模型给这一格指了场景（艺术字→translate / 普通字体→erase），
            // 之后重绘管线按它分流。
            // 两个前提：① 只在真的给了标记时才写 —— 没给就保持该框原有的值，绝不清空
            // （开关关掉之后，用户以前标好的场景不该被一次翻译抹掉）；② 只给「模型这次
            // 自己判定要冻结」的框写 —— aiBubbleBase / isAiTranslated 的框是**已经画过**
            // 的 AI 重绘产物，它们的场景是既成事实，按这次的翻译重新推导会把编辑器的
            // 显示态（已冻结 / 已擦除 / 已完成）带偏。
            ...(res.freeze && res.intent ? { redrawIntent: res.intent } : {}),
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
  }, [busy, getImage, recompositeRegion, updateImage, setErrorMsg, pickTranslateTargets, pickExplicitTranslateTargets, onPageTerms, markTranslatingImage]);

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
      // 手动解冻 = 用户接手这一格，自动冻结的标记一并清掉（否则关掉开关时会被
      // 当成「本功能冻结的」再还原一次）。
      editorFrozenByErase: undefined,
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
   * 硬重置 one region：把整个框回退到「刚检测出来」的干净状态。
   *
   * 与 resetRegion（框上的「交回 AI 重绘」）的区别：resetRegion 会把已嵌的字转成
   * **冻结译文**留下来（不丢用户的字），于是那一格仍然算「已翻译过」—— 用户接着点
   * 「重新翻译」，模型多半还是给同一句 freeze，看起来就像点了没反应。这里连译文一起
   * 清掉：
   *  - 产出：贴图、editorComposited、锚点、patch 边距、状态 → 'pending'；
   *  - 文字：editorText / editorFrozenText / customTranslation / sourceText；
   *  - 画面：editorErased（连擦除缓存）、editorWhitedOut、editorBrushUrl；
   *  - AI 底图与场景：aiBubbleBase / aiErasedBase / aiEraseBaseUrl / redrawIntent；
   *  - 排版样式与重试诊断（editorStyle / retryCount / errorHistory）。
   *
   * 保留「框本身」的属性：几何、检测类别与置信度、文字掩码、三套 tab 提示词 ——
   * 它们不是产出状态，清掉等于把框重新画一遍。
   *
   * Blob URL 一律不 release：history 里可能还引用着同一份（与 resetRegion 同理）。
   */
  const hardResetRegion = useCallback((imageId: string, regionId: string) => {
    const img = getImage(imageId);
    const region = img?.regions.find(r => r.id === regionId);
    if (!img || !region || region.status === 'processing' || isImageLocked(imageId)) return;
    // 擦除缓存与待跑的合成计时器描述的都是「重置前那一次」，一起丢掉。
    dropRegionCache(imageId, regionId);
    const next: Region = {
      ...region,
      status: 'pending',
      processedImageUrl: undefined,
      editorComposited: false,
      anchorX: undefined,
      anchorY: undefined,
      anchorWidth: undefined,
      anchorHeight: undefined,
      patchMarginX: undefined,
      patchMarginY: undefined,
      restoreBoxes: undefined,
      editorText: undefined,
      editorFrozenText: undefined,
      editorFrozenByErase: undefined,
      customTranslation: undefined,
      sourceText: undefined,
      editorErased: false,
      editorWhitedOut: false,
      editorWhiteoutFill: undefined,
      editorPreviewRefreeze: undefined,
      editorPreviewPrevErased: undefined,
      editorBrushUrl: undefined,
      aiBubbleBase: undefined,
      aiErasedBase: undefined,
      aiEraseBaseUrl: undefined,
      redrawIntent: undefined,
      editorStyle: undefined,
      retryCount: undefined,
      errorHistory: undefined,
    };
    updateImage(imageId, current => ({
      ...current,
      regions: current.regions.map(r => (r.id === regionId ? next : r)),
    }));
  }, [getImage, updateImage, dropRegionCache, isImageLocked]);

  /**
   * 「临时预览译文」：给框铺一层底色（白 / 黑，见高级设置）再把译文排上去，只为
   * 先看一眼译文。泛洪擦除啃不动的复杂背景就靠这层底色。
   *
   * 目标集由 `editorPreviewOnlyFrozen` 决定：
   *  - 打开（默认）：只处理挂着冻结译文的框 —— 气泡内的复杂文字同样会被 AI 标记
   *    为冻结，所以这里**不限定 text_free**，包括用户在面板上手动冻结的框；
   *  - 关闭：连已经嵌好字的框一起卷进来，整页统一成预览底色，一次看完整体效果。
   *
   * 反向就是 `refreezeInImage`（「结束预览」）。两者互为精确逆操作，所以不需要
   * 撤销栈 —— 但「文字是从冻结区搬来的」与「本来就在画面上」必须分开记，否则
   * 结束预览会把正常嵌好的框误冻结（见 Region.editorPreviewRefreeze）。
   */
  const whitenInImage = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img) return;
    const onlyFrozen = configRef.current.editorPreviewOnlyFrozen !== false;
    const fill = configRef.current.editorPreviewFillColor === 'black' ? 'black' : 'white';
    const targets = img.regions.filter(r => {
      if (r.contextOnly || isAiOwned(r)) return false;
      // aiErasedBase 是 AI「擦除」的产物：底图已经是干净图，涂白反而盖掉它 ——
      // 跳过（这类框用逐框「解冻填入」直接排字更合适）。
      if (r.aiErasedBase) return false;
      if (r.editorFrozenText?.trim()) return true;
      // 「不只预览冻结的」：已经有译文的框一起预览（它本来就排着字，这里只是把
      // 底色统一成预览样式）。没有文字的框不碰 —— 铺一块空白膏药没有意义。
      return !onlyFrozen && !!r.editorText?.trim();
    });
    if (targets.length === 0) return;

    const nextList = targets.map(r => {
      const fromFrozen = !!r.editorFrozenText?.trim();
      // 已经处在预览里的框（改底色后重按一次预览，或「含已嵌字框」模式下再按一次）
      // 必须沿用第一次留下的标记：这时它已经有 editorText、看不出文字本来是从冻结区
      // 搬来的，重算会把「结束预览要搬回去」误判成「本来就已嵌字」。
      const alreadyPreviewed = !!r.editorWhitedOut;
      return {
        ...r,
        editorText: fromFrozen ? r.editorFrozenText : r.editorText,
        editorFrozenText: fromFrozen ? undefined : r.editorFrozenText,
        editorWhitedOut: true,
        // 底色每次都按当前设置写 —— 「改成涂黑再预览一次」走的正是这条路。
        editorWhiteoutFill: fill,
        // 底色已经盖住整格；擦除只会在不透明的底色下面白跑一次昂贵的泛洪。
        editorErased: false,
        // 结束预览要还原的两件事：文字从哪来的、预览前擦没擦过。
        editorPreviewRefreeze: alreadyPreviewed ? r.editorPreviewRefreeze : fromFrozen,
        editorPreviewPrevErased: alreadyPreviewed ? r.editorPreviewPrevErased : !!r.editorErased,
      };
    });
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
        if (img.isSkipped) continue;
        await whitenInImage(img.id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, whitenInImage]);

  /**
   * Reverse of the preview: take the boxes 「临时预览译文」recoloured back to
   * their pre-preview state — the fill and the typeset text are removed (the
   * original artwork comes back).
   *
   * Recognition is state-based, not remembered: editorWhitedOut is only ever set
   * by the preview, so "filled + has text" is exactly its output. 这里也**不
   * 限定 text_free** —— 识别靠的是 editorWhitedOut，与检测类别无关。
   *
   * 两种框要分开处理（见 Region.editorPreviewRefreeze）：
   *  - 预览时把冻结译文献上的（含老会话的预览产物，字段缺失 = true）→ 译文搬回
   *    editorFrozenText，重新挂起等待 AI 重绘；
   *  - 本来就已嵌好字的（「不只预览冻结的」才会被卷进来）→ 文字原样留着，只把
   *    底色与擦除状态还原，绝不能被误冻结。
   */
  const refreezeInImage = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img) return;
    const targets = img.regions.filter(r =>
      !r.contextOnly && !isAiOwned(r) &&
      !!r.editorWhitedOut && !!r.editorText?.trim()
    );
    if (targets.length === 0) return;

    const nextList = targets.map(r => {
      const refreeze = r.editorPreviewRefreeze !== false;
      return {
        ...r,
        ...(refreeze ? { editorFrozenText: r.editorText, editorText: undefined } : {}),
        editorWhitedOut: false,
        editorWhiteoutFill: undefined,
        // 还原预览前的擦除状态（老会话没有这个字段 → false，与旧行为一致）。
        editorErased: refreeze ? false : !!r.editorPreviewPrevErased,
        editorPreviewRefreeze: undefined,
        editorPreviewPrevErased: undefined,
      };
    });
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
        if (img.isSkipped) continue;
        await refreezeInImage(img.id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, refreezeInImage]);

  /**
   * 「擦除成功后自动冻结」的开关落地（AppConfig.freezeErasedBoxes）。
   *
   * `enabled = true`：把 scope 内**编辑器擦除成功、且已经有译文**的框冻结 ——
   * 译文搬进 editorFrozenText，画面上只留擦干净的底图，等 AI 重绘去画中文。
   * `enabled = false`：只还原**本功能冻结过**的框（Region.editorFrozenByErase）：
   * 译文填回 editorText、按擦除结果重新排版，也就是恢复成「编辑器擦除」的样子。
   *
   * 两种方向都跳过 AI 重绘占位的框：AI 重绘的「擦除」（aiErasedBase）/「翻译」
   * /「自定义」（isAiOwned）优先级都高于编辑器擦除，那些框原样保留 —— 冻结的继续
   * 冻结交给重绘管线，绝不因为关掉这个开关就被编辑器抢回去。
   *
   * `imageIds` 就是 作用范围（当前图片 / 所有图片）。
   */
  const syncEraseFreeze = useCallback(async (imageIds: string[], enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      for (const imageId of imageIds) {
        const img = getImage(imageId);
        if (!img) continue;
        const nextById = new Map<string, Region>();
        for (const r of img.regions) {
          if (r.contextOnly) continue;
          // AI 重绘的擦除 / 翻译 / 自定义占位优先，编辑器这边一律让位。
          if (isAiOwned(r) || r.aiErasedBase) continue;
          if (enabled) {
            if (!r.editorErased || !r.editorText?.trim()) continue;
            nextById.set(r.id, {
              ...r,
              editorFrozenText: r.editorText,
              editorText: undefined,
              editorFrozenByErase: true,
            });
          } else {
            if (!r.editorFrozenByErase || !r.editorFrozenText?.trim()) continue;
            nextById.set(r.id, {
              ...r,
              editorText: r.editorFrozenText,
              editorFrozenText: undefined,
              editorFrozenByErase: undefined,
            });
          }
        }
        if (nextById.size === 0) continue;
        updateImage(imageId, current => ({
          ...current,
          regions: current.regions.map(r => nextById.get(r.id) ?? r),
        }));
        // 逐个重建贴图：冻结要撤掉排上的字，还原要把字重新排回去。
        for (const nr of nextById.values()) {
          await recompositeRegion(imageId, nr.id, nr);
        }
      }
    } finally {
      setBusy(false);
    }
  }, [busy, getImage, updateImage, recompositeRegion]);

  /**
   * 重新擦除（一页）：把这一页所有「编辑器泛洪擦除」过的框的擦除结果作废，重跑
   * 一遍合成 —— 擦除算法改进后（后端 /erase 或本地兜底），用它一次性刷新已有的
   * 旧结果，不必逐框点「撤回擦除 → 再擦除」。
   *
   * 作废走的就是「撤回擦除」那条路：dropErasedCache 把内存缓存与落盘记录一起丢掉，
   * 于是下面的 recompositeRegion 必然重新擦一次 —— 重新请求 /erase、重新量一次
   * 墨色（「自动取色」的字色也跟着更新）。
   *
   * 目标见 isReerasableRegion：AI 重绘的「擦除」产物不在其中。
   */
  const reeraseInImage = useCallback(async (imageId: string) => {
    const img = getImage(imageId);
    if (!img) return;
    // 「只擦除气泡内的文字」：重新擦除同样遵守（见 AppConfig.eraseOnlyInsideBubble）。
    const onlyInsideBubble = !!configRef.current.eraseOnlyInsideBubble;
    // 「擦除成功后冻结」：重新擦除也是一次擦除成功 —— 有译文的框顺手冻结，于是
    // 画面只剩擦干净的底图，译文挂进冻结区等 AI 重绘（作用范围沿用 当前图片 /
    // 所有图片，reeraseAllImages 逐页调用本函数）。
    const freeze = !!configRef.current.freezeErasedBoxes;
    const targets = img.regions.filter(r => isReerasableRegion(r, onlyInsideBubble));
    for (const r of targets) {
      dropErasedCache(r.id);
      const frozen = freeze && !r.aiErasedBase && !!r.editorText?.trim()
        ? { ...r, editorFrozenText: r.editorText, editorText: undefined, editorFrozenByErase: true }
        : null;
      if (frozen) {
        updateImage(imageId, current => ({
          ...current,
          regions: current.regions.map(x => (x.id === frozen.id ? frozen : x)),
        }));
      }
      await recompositeRegion(imageId, r.id, frozen ?? undefined);
    }
  }, [getImage, dropErasedCache, recompositeRegion, updateImage]);

  /** 重新擦除 on the current image. */
  const reeraseImage = useCallback(async (imageId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await reeraseInImage(imageId);
    } finally {
      setBusy(false);
    }
  }, [busy, reeraseInImage]);

  /** Batch variant: the same 重新擦除 over every loaded image. */
  const reeraseAllImages = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const img of imagesRef.current) {
        if (img.isSkipped) continue;
        await reeraseInImage(img.id);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, reeraseInImage]);

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
      // 跳过被标记为跳过的页面：isSkipped 的语义就是「不参与整批处理」
      // （见 types.ts → UploadedImage.isSkipped），与 AI 重绘的整批挑选同源。
      await runTranslateRounds(
        () => imagesRef.current.filter(img => !img.isSkipped).map(img => img.id),
        ctrl
      );
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
   * 「翻译此框」/「翻译选中」：只翻选中的那几格，一次视觉调用。
   *
   * 与整页翻译共用同一条管线（标注图 + JSON 骨架 + 同一套写回：sourceText /
   * editorText / editorFrozenText / 术语表），区别只在目标集 —— 整页用
   * pickTranslateTargets（跳过已翻过的），这里用 pickExplicitTranslateTargets
   * （已翻过的也重来，即「重新翻译」）。
   *
   * 不做整批重试轮：这是用户明确点的一次单页操作，失败了再点一次的成本远低于
   * 悄悄重发一整轮。stop 按钮照常可用（同一个 abortRef）。
   */
  const translateSelectedRegions = useCallback(async (imageId: string, regionIds: string[]) => {
    if (busy || regionIds.length === 0) return;
    const ctrl = new AbortController();
    translateAbortRef.current = ctrl;
    setBusy(true);
    setTranslating(true);
    try {
      await translateImageRegions(imageId, ctrl.signal, undefined, new Set(regionIds));
    } finally {
      setBusy(false);
      setTranslating(false);
      setTranslatingImageIds(new Set());
      if (translateAbortRef.current === ctrl) translateAbortRef.current = null;
    }
  }, [busy, translateImageRegions]);

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
      false,
      undefined,
      undefined,
      buildErasePersist(imageId, !!img.appliedAsOriginal),
      !!(configRef.current.detectionTextMask || configRef.current.editorAutoTextColor)
    );
    return result?.url ?? null;
  }, [getImage, buildErasePersist]);

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
    // 落盘的擦除底图一起丢：键里带着 imageId，换一份图库后旧条目永远不会被读到，
    // 留着只是占空间（导入的图库即使 id 相同，底图也已经不是同一张）。
    void clearEraseRecords();
    debounceRef.current.forEach(t => clearTimeout(t));
    debounceRef.current.clear();
    editStampRef.current.clear();
    compositingRef.current.clear();
    compositedAtRef.current.clear();
    // 清缓存后允许重新后台取色（否则旧 key 会让这格一直保持旧色）。
    inkFetchRef.current.clear();
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
    updateEditorRegions,
    setBrushLayer,
    dropRegionCache,
    translateImageRegions,
    translateAllImages,
    translateSingleImage,
    translateSelectedRegions,
    stopTranslation,
    unfreezeTranslation,
    freezeTranslation,
    resetRegion,
    hardResetRegion,
    syncEraseFreeze,
    previewFrozenText,
    previewFrozenTextAllImages,
    endPreview,
    endPreviewAllImages,
    reeraseImage,
    reeraseAllImages,
    resyncEditedRegions,
    refreshEditorPatches,
    buildBrushBase,
    clearEditorCaches,
    recompositeRegion,
  };
}
