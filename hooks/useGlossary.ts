import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppConfig, GlossaryTerm, Region, UploadedImage } from '../types';
import {
  AI_PICK_BATCH_SIZE,
  AiPickExample,
  AiPickItem,
  AiPickResult,
  PageTerm,
  aiPickCandidates,
  aiVariants,
  buildAiPickPrompt,
  mergePageTerms as mergeIntoBook,
  parseAiPickResponse,
  regionTranslationText,
  sanitizeBook,
  serializeBook,
  setCustomVariantValue,
  termAnchors,
  termKeyOf,
  unifyRegionsWithTerm,
} from '../services/glossaryBook';
import { loadGlossaryBook, saveGlossaryBook } from '../services/sessionStore';
import { generateTextCompletion } from '../services/aiService';

/**
 * 术语表 v2 的 React 侧状态编排（纯逻辑在 services/glossaryBook.ts）。
 *
 * 职责：
 *  - book state + session 持久化（IndexedDB META_STORE，随清空图库一起被清）；
 *  - mergePageTerms：每页翻译完成时合并本页术语；glossaryAutoUnify 开着时把
 *    本页框文本按已选标准译名改写并返回改动框（useMangaEditor 在状态提交与
 *    合成之前拿到它们，第一次上屏就是统一后的文本）；
 *  - selectVariant：人工选定标准译名 → 跨图锚点替换 + 逐框 recomposite；
 *  - setCustomVariant：写入/改/删本术语的用户自定义译名槽位（AI 译名之外的
 *    手写译名），写入即选定并统一 —— 用户不必先等 AI 译出某个译名才能选它；
 *  - runAiSelection：把未决术语（多变体且未选）分批丢给翻译端点做纯文本
 *    判断（不丢图），选定的译名落地并统一；
 *  - exportJson / restoreBook：单独导出与工作区导出还原。
 */

export interface UseGlossaryParams {
  config: AppConfig;
  images: UploadedImage[];
  updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void;
  recompositeRegion: (imageId: string, regionId: string, regionOverride?: Region) => Promise<void>;
  enableSessionPersistence: boolean;
}

export interface AiSelectionSummary {
  /** 实际采纳的选择数（变体对不上 / 期间被人工选走的会跳过）。 */
  picked: number;
  /** 参与本次 AI 选择的未决术语总数。 */
  total: number;
  error?: string;
}

export interface GlossaryApi {
  book: GlossaryTerm[];
  aiSelecting: boolean;
  /** 未决术语数（≥2 变体且未选定）——AI 选择按钮的角标。 */
  unresolvedCount: number;
  mergePageTerms: (imageId: string, regions: Region[], terms: PageTerm[]) => Region[];
  selectVariant: (key: string, variantIndex: number | null) => void;
  /** 写入 / 修改 / 删除本术语的用户自定义译名槽位（'' = 删除）。写入即选它
   *  为标准译名并执行统一替换 —— 见 services/glossaryBook.ts。 */
  setCustomVariant: (key: string, value: string) => void;
  runAiSelection: () => Promise<AiSelectionSummary>;
  clearBook: () => void;
  exportJson: () => string;
  /** 工作区导入还原（sanitize 失败返回 false）。只还原树，不做统一替换——
   *  图片里的文本在导出时就已经是统一后的。 */
  restoreBook: (data: unknown) => boolean;
  /** 单独导入 JSON 文件（整本替换）；ok=false 表示文件不是有效的术语表。 */
  importJsonFile: (file: File) => Promise<{ ok: boolean; count: number }>;
}

export function useGlossary({
  config,
  images,
  updateImage,
  recompositeRegion,
  enableSessionPersistence,
}: UseGlossaryParams): GlossaryApi {
  const [book, setBook] = useState<GlossaryTerm[]>([]);
  const [aiSelecting, setAiSelecting] = useState(false);

  // Refs keep callbacks stable while reading the freshest values; bookRef is
  // also written synchronously wherever setBook is called, so rapid successive
  // merges / AI picks never read a stale tree.
  const bookRef = useRef(book);
  const configRef = useRef(config);
  const imagesRef = useRef(images);
  const persistRef = useRef(enableSessionPersistence);
  const restoredRef = useRef(false);

  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => { persistRef.current = enableSessionPersistence; }, [enableSessionPersistence]);

  // -------------------- session 持久化 --------------------

  // Mount-only restore: config is read synchronously from localStorage, so the
  // initial persistence flag is authoritative (same contract as useImageManager).
  useEffect(() => {
    let cancelled = false;
    if (persistRef.current) {
      loadGlossaryBook()
        .then(loaded => {
          if (cancelled) return;
          if (loaded && loaded.length > 0) {
            bookRef.current = loaded;
            setBook(loaded);
          }
          restoredRef.current = true;
        })
        .catch(e => {
          console.error('[glossary] restore failed', e);
          restoredRef.current = true;
        });
    } else {
      restoredRef.current = true;
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced save on every book change (also fires when persistence toggles on).
  useEffect(() => {
    if (!restoredRef.current || !enableSessionPersistence) return;
    const timer = setTimeout(() => {
      void saveGlossaryBook(bookRef.current)
        .catch(e => console.error('[glossary] save failed', e));
    }, 1200);
    return () => clearTimeout(timer);
  }, [book, enableSessionPersistence]);

  // Flush immediately when the tab is about to be discarded / unloaded.
  useEffect(() => {
    const flush = () => {
      if (!restoredRef.current || !persistRef.current) return;
      void saveGlossaryBook(bookRef.current).catch(() => { /* best effort */ });
    };
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
  }, []);

  // -------------------- 统一替换（跨图） --------------------

  /** 把 term 的已选译名套用到所有锚定图：替换文本 + 重排受影响的框。 */
  const applyUnify = useCallback((term: GlossaryTerm) => {
    if (term.selected == null) return;
    const imageIds = new Set<string>();
    for (const ref of termAnchors(term)) imageIds.add(ref.imageId);

    for (const imageId of imageIds) {
      const img = imagesRef.current.find(i => i.id === imageId);
      if (!img) continue;
      const changed = unifyRegionsWithTerm(term, img.regions);
      if (changed.length === 0) continue;
      const origById: Map<string, Region> = new Map();
      for (const or of img.regions) origById.set(or.id, or);

      updateImage(imageId, current => {
        // 对最新 regions 重算（上面的快照可能已过期）；替换幂等，重算安全。
        const fresh = unifyRegionsWithTerm(term, current.regions);
        if (fresh.length === 0) return current;
        const freshById: Map<string, Region> = new Map();
        for (const fr of fresh) freshById.set(fr.id, fr);
        return { ...current, regions: current.regions.map(r => freshById.get(r.id) ?? r) };
      });

      // 只有画布上真正排了字的框（editorText 变了）才需要重排；冻结框的
      // 译文不上屏，改字符串不影响画面。
      for (const r of changed) {
        const orig = origById.get(r.id);
        if (r.editorText !== undefined && r.editorText !== orig?.editorText) {
          void recompositeRegion(imageId, r.id, r)
            .catch(e => console.error('[glossary] recomposite failed', e));
        }
      }
    }
  }, [updateImage, recompositeRegion]);

  // -------------------- 每页术语合并（useMangaEditor 的 onPageTerms） --------------------

  const mergePageTerms = useCallback((imageId: string, regions: Region[], terms: PageTerm[]): Region[] => {
    const prev = bookRef.current;
    const next = mergeIntoBook(prev, imageId, regions, terms);
    if (next !== prev) {
      bookRef.current = next;
      setBook(next);
    }
    if (!configRef.current.glossaryAutoUnify) return [];

    // 自动统一：把"已选定且 key 出现在本页原文里"的术语依次套用到本页框上。
    // 即使本页 AI 没上报某条术语，只要原文锚点命中就统一（重翻同一页时 refs
    // 已去重、book 不变，这里仍能把新译文改写成标准译名）。
    const pageSources = regions.map(r => r.sourceText ?? '').join('\n');
    let current = regions;
    const changedIds = new Set<string>();
    for (const term of next) {
      if (term.selected == null) continue;
      if (!pageSources.includes(term.key)) continue;
      const changed = unifyRegionsWithTerm(term, current);
      if (changed.length === 0) continue;
      const byId = new Map(changed.map(r => [r.id, r]));
      current = current.map(r => byId.get(r.id) ?? r);
      for (const r of changed) changedIds.add(r.id);
    }
    return current.filter(r => changedIds.has(r.id));
  }, []);

  // -------------------- 人工选定 --------------------

  const selectVariant = useCallback((key: string, variantIndex: number | null) => {
    const prev = bookRef.current;
    const idx = prev.findIndex(t => termKeyOf(t.key) === termKeyOf(key));
    if (idx === -1) return;
    const term = prev[idx];
    const selected = variantIndex != null && variantIndex >= 0 && variantIndex < term.variants.length
      ? variantIndex
      : null;
    if (term.selected === selected) return;
    const nextTerm: GlossaryTerm = { ...term, selected };
    const next = [...prev];
    next[idx] = nextTerm;
    bookRef.current = next;
    setBook(next);
    if (selected != null) applyUnify(nextTerm);
  }, [applyUnify]);

  // -------------------- 用户自定义译名槽位 --------------------

  const setCustomVariant = useCallback((key: string, value: string) => {
    const prev = bookRef.current;
    const idx = prev.findIndex(t => termKeyOf(t.key) === termKeyOf(key));
    if (idx === -1) return;
    const nextTerm = setCustomVariantValue(prev[idx], value);
    if (nextTerm === prev[idx]) return;
    const next = [...prev];
    next[idx] = nextTerm;
    bookRef.current = next;
    setBook(next);
    if (nextTerm.selected != null) applyUnify(nextTerm);
  }, [applyUnify]);

  // -------------------- AI 选择 --------------------

  const applyAiPick = useCallback((res: AiPickResult): boolean => {
    const prev = bookRef.current;
    const idx = prev.findIndex(t => termKeyOf(t.key) === termKeyOf(res.key));
    if (idx === -1) return false;
    const term = prev[idx];
    if (term.selected != null) return false; // 运行期间人工选过的一律尊重
    const variantIdx = term.variants.findIndex(v => v.value === res.value);
    if (variantIdx === -1) return false; // 模型新造的译名不收
    const nextTerm: GlossaryTerm = { ...term, selected: variantIdx, ...(res.note ? { note: res.note } : {}) };
    const next = [...prev];
    next[idx] = nextTerm;
    bookRef.current = next;
    setBook(next);
    applyUnify(nextTerm);
    return true;
  }, [applyUnify]);

  const runAiSelection = useCallback(async (): Promise<AiSelectionSummary> => {
    const candidates = aiPickCandidates(bookRef.current);
    if (candidates.length === 0) return { picked: 0, total: 0 };
    setAiSelecting(true);
    try {
      const findRegion = (imageId: string, regionId: string): Region | undefined =>
        imagesRef.current.find(i => i.id === imageId)?.regions.find(r => r.id === regionId);

      let picked = 0;
      for (let start = 0; start < candidates.length; start += AI_PICK_BATCH_SIZE) {
        const batch = candidates.slice(start, start + AI_PICK_BATCH_SIZE);
        const items: AiPickItem[] = batch.map(term => ({
          key: term.key,
          // 只把模型自己译出的变体丢给它挑：用户手写的槽位不是它的候选。
          variants: aiVariants(term).map(v => ({
            value: v.value,
            count: v.refs.length,
            examples: v.refs
              .slice(0, 2)
              .map((ref): AiPickExample | null => {
                const r = findRegion(ref.imageId, ref.regionId);
                if (!r) return null;
                return {
                  source: (r.sourceText ?? '').slice(0, 80),
                  translation: regionTranslationText(r).slice(0, 80),
                };
              })
              .filter((e): e is AiPickExample => e !== null),
          })),
        }));
        const content = await generateTextCompletion(buildAiPickPrompt(items), configRef.current);
        for (const res of parseAiPickResponse(content)) {
          if (applyAiPick(res)) picked++;
        }
      }
      return { picked, total: candidates.length };
    } catch (e: any) {
      if (e?.name === 'AbortError') throw e;
      console.error('[glossary] AI selection failed', e);
      return { picked: 0, total: candidates.length, error: e?.message || 'AI 选择失败' };
    } finally {
      setAiSelecting(false);
    }
  }, [applyAiPick]);

  // -------------------- 清空 / 导出 / 还原 --------------------

  const clearBook = useCallback(() => {
    bookRef.current = [];
    setBook([]);
  }, []);

  const exportJson = useCallback((): string => {
    const file = serializeBook(bookRef.current);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const fileName = `genai-patcher-glossary-${stamp}.json`;
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return fileName;
  }, []);

  const restoreBook = useCallback((data: unknown): boolean => {
    const terms = sanitizeBook(data);
    if (!terms) return false;
    bookRef.current = terms;
    setBook(terms);
    return true;
  }, []);

  /** 单独导入（导出 JSON 的回灌口）：整本替换，不走合并 —— 术语表是作品级
   *  快照，导入语义与「工作区导入」一致。 */
  const importJsonFile = useCallback(async (file: File): Promise<{ ok: boolean; count: number }> => {
    try {
      const parsed = JSON.parse(await file.text());
      if (!restoreBook(parsed)) return { ok: false, count: 0 };
      return { ok: true, count: bookRef.current.length };
    } catch {
      return { ok: false, count: 0 };
    }
  }, [restoreBook]);

  const unresolvedCount = useMemo(() => aiPickCandidates(book).length, [book]);

  return {
    book,
    aiSelecting,
    unresolvedCount,
    mergePageTerms,
    selectVariant,
    setCustomVariant,
    runAiSelection,
    clearBook,
    exportJson,
    restoreBook,
    importJsonFile,
  };
}
