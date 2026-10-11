import { GlossaryRef, GlossaryTerm, GlossaryVariant, Region } from '../types';

/**
 * 术语表 v2 —— 纯逻辑模块（无 React / 无网络）。
 *
 * 设计（与已废弃的 v1 注入式相反）：翻译时**不**向 AI 注入术语表，承认每次
 * 翻译的独立性，允许同一术语在不同页被译成不同译名；每页翻译返回本页出现的
 * 术语（source=原文，target=本页实际使用的译名），按原文聚合成树：
 *
 *   ルフィ ──┬── 路飞  (×12)   ← 选定标准译名（亮）
 *            ├── 鲁夫  (×3)    （暗）
 *            └── 路菲  (×1)    （暗）
 *
 * 人工或 AI 从变体中选定一个标准译名后，本地把所有锚定框里的变体字符串替换
 * 为标准译名（不重新翻译，纯字符串替换 + 本地重排）。
 *
 * 锚点（refs）：变体实际出现的框。由本地匹配算出，不需要 AI 汇报位置——
 * 某框的 sourceText 含 key、且其译文（editorText / editorFrozenText）含
 * value，则该框是这个变体的一个锚点。频次 = refs.length，是人工/AI 选择
 * 标准译名时最重要的依据。
 */

/**
 * 每页翻译返回的一条术语（editorTranslate 的 JSON 契约）。
 *
 * 约定 source / target **都不带敬语称呼后缀**（くん / さん / ちゃん / 様…）：
 * アキラくん 与 アキラ 是同一条术语（source「アキラ」），译文「彰君」的 target
 * 是「彰」。这条约定由 editorTranslate 的整页翻译 prompt 约束；这里不去猜——
 * 模型万一还是把后缀带回来了，锚点的子串匹配仍能命中（见 findAnchors），
 * 只是会多出一条术语。
 */
export interface PageTerm {
  source: string;
  target: string;
}

/** key 的同一性判定：trim + 小写（拉丁字母大小写不敏感；日文/中文不受影响）。 */
export const termKeyOf = (source: string): string => source.trim().toLowerCase();

/** 术语 key 的 sanity 上限——超过这个长度的"术语"基本是模型把整句塞进来了。 */
const MAX_TERM_SOURCE_LEN = 40;
const MAX_TERM_TARGET_LEN = 60;

// -------------------- 用户自定义译名槽位（每术语最多一个） --------------------

/** 术语的自定义译名槽位下标（没有则 -1）。 */
export const customVariantIndex = (term: GlossaryTerm): number =>
  term.variants.findIndex(v => v.custom);

/** 术语里 AI 译出的变体（不含用户自定义槽位）——AI 选择的候选集与统计口径。 */
export const aiVariants = (term: GlossaryTerm): GlossaryVariant[] =>
  term.variants.filter(v => !v.custom);

/**
 * 术语「有效选定」的变体下标：显式选定的优先；未显式选定时，**唯一译名即视为
 * 已定**（只有一种译名时选与不选没有区别）。没有可生效的选定项时返回 null。
 *
 * 这是「一条术语当前用哪个译名」的单一判定来源——导出、收起时的头部显示都用它。
 */
export const resolvedVariantIndex = (term: GlossaryTerm): number | null => {
  if (term.selected != null && term.variants[term.selected]) return term.selected;
  return term.variants.length === 1 ? 0 : null;
};

/** 术语当前的译名（有效选定，见 resolvedVariantIndex）；没有则 null。 */
export const effectiveTranslation = (term: GlossaryTerm): string | null => {
  const idx = resolvedVariantIndex(term);
  return idx != null ? term.variants[idx]?.value ?? null : null;
};

/**
 * 把 value 作为一个译名变体加进术语（已存在则直接复用），并设为选定项；
 * 无实际变化时返回原引用。给「导入合并」与「术语组一致」共用——
 * refs 留空由调用方/后续本地匹配处理，选定后统一替换走 applyUnify。
 */
export const addAndSelectVariant = (term: GlossaryTerm, value: string): GlossaryTerm => {
  const variantIdx = term.variants.findIndex(v => v.value === value);
  if (variantIdx === -1) {
    const variants = [...term.variants, { value, refs: [] }];
    return { ...term, variants, selected: variants.length - 1 };
  }
  if (term.selected === variantIdx) return term;
  return { ...term, selected: variantIdx };
};

/** 归一化编辑距离相似度 [0,1]：1 = 完全相同，0 = 毫无共同点。字符串短，直接算。 */
export const stringSimilarity = (a: string, b: string): number => {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  let prev: number[] = new Array(lb + 1);
  let curr: number[] = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return 1 - prev[lb] / Math.max(la, lb);
};

/**
 * 写入 / 清除术语的用户自定义译名槽位（见 GlossaryVariant.custom），返回新术语；
 * 无实际变化时返回原引用。
 *
 *  - value 去空白后为空 → 删除槽位（若它正是选定项则取消选定，其后变体下标前移）；
 *  - value 与某个 AI 译名相同 → 不建重复槽位（重复值会打乱锚点与列表 key 的
 *    唯一性），直接把那个 AI 译名选为标准译名；
 *  - 否则写入槽位并**立即选它**为标准译名 —— 用户亲手打的译名就是他要的答案，
 *    省掉「先加再加点选」两步（统一替换随即执行，可改选/可删）。改值时旧值的
 *    锚点频次自然失效，refs 清空。
 */
export const setCustomVariantValue = (term: GlossaryTerm, value: string): GlossaryTerm => {
  const trimmed = value.trim();
  const customIdx = customVariantIndex(term);

  // 清空输入 = 删除槽位。
  if (!trimmed) {
    if (customIdx === -1) return term;
    const variants = term.variants.filter((_, i) => i !== customIdx);
    const selected = term.selected == null
      ? null
      : term.selected === customIdx
        ? null
        : term.selected > customIdx
          ? term.selected - 1
          : term.selected;
    return { ...term, variants, selected };
  }

  // 与已有 AI 译名重名：复用那个变体，不新增槽位。
  if (term.variants.some(v => !v.custom && v.value === trimmed)) {
    const variants = customIdx === -1 ? term.variants : term.variants.filter((_, i) => i !== customIdx);
    const target = variants.findIndex(v => !v.custom && v.value === trimmed);
    if (target === -1) return term;
    if (variants === term.variants && term.selected === target) return term;
    return { ...term, variants, selected: target };
  }

  if (customIdx === -1) {
    return {
      ...term,
      variants: [...term.variants, { value: trimmed, refs: [], custom: true }],
      selected: term.variants.length,
    };
  }
  if (term.variants[customIdx].value === trimmed) {
    return term.selected === customIdx ? term : { ...term, selected: customIdx };
  }
  const variants = [...term.variants];
  variants[customIdx] = { value: trimmed, refs: [], custom: true };
  return { ...term, variants, selected: customIdx };
};

/** 框当前承载译文的字段（嵌字文本优先，冻结译文其次）。 */
export const regionTranslationText = (r: Region): string =>
  r.editorText ?? r.editorFrozenText ?? '';

/**
 * 找出变体在一组框里的锚点：sourceText 含 key 且译文含 value 的框。
 * 精确匹配——锚点同时承担"频次"和"统一替换的作用范围"两个职责。
 */
export const findAnchors = (
  imageId: string,
  regions: Region[],
  key: string,
  value: string
): GlossaryRef[] => {
  const refs: GlossaryRef[] = [];
  for (const r of regions) {
    if (!r.sourceText || !r.sourceText.includes(key)) continue;
    if (!regionTranslationText(r).includes(value)) continue;
    refs.push({ imageId, regionId: r.id });
  }
  return refs;
};

const hasRef = (refs: GlossaryRef[], imageId: string, regionId: string): boolean =>
  refs.some(ref => ref.imageId === imageId && ref.regionId === regionId);

/**
 * 把一页的术语合并进术语树（不可变更新，返回新树；无新增时返回原引用）。
 *
 * 合并规则（用户定的）：
 *  - key 和译名都一致 → 合到同一个变体下（refs 追加去重）；
 *  - key 相同、译名不同 → 同 key 下新增一个变体分支。
 */
export const mergePageTerms = (
  book: GlossaryTerm[],
  imageId: string,
  regions: Region[],
  pageTerms: PageTerm[]
): GlossaryTerm[] => {
  // 页内先去重（同一页同一 key+value 只算一次，锚点按框另算）。
  const seen = new Set<string>();
  const cleaned: PageTerm[] = [];
  for (const raw of pageTerms) {
    const source = (raw.source ?? '').trim();
    const target = (raw.target ?? '').trim();
    if (!source || !target) continue;
    if (source.length > MAX_TERM_SOURCE_LEN || target.length > MAX_TERM_TARGET_LEN) continue;
    const dedupeKey = `${termKeyOf(source)}${target}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    cleaned.push({ source, target });
  }
  if (cleaned.length === 0) return book;

  let next: GlossaryTerm[] | null = null;
  /** 惰性复制：只有真正发生变更的那一层才换新数组/对象。 */
  const ensure = (): GlossaryTerm[] => (next ??= [...book]);

  for (const { source, target } of cleaned) {
    const key = termKeyOf(source);
    const displayKey = source.trim();
    const anchors = findAnchors(imageId, regions, displayKey, target);

    const list = next ?? book;
    const termIdx = list.findIndex(t => termKeyOf(t.key) === key);
    if (termIdx === -1) {
      ensure().push({
        key: displayKey,
        variants: [{ value: target, refs: anchors }],
        selected: null,
      });
      continue;
    }

    const term = list[termIdx];
    const variantIdx = term.variants.findIndex(v => v.value === target);
    if (variantIdx === -1) {
      const copy = ensure();
      copy[termIdx] = { ...term, variants: [...term.variants, { value: target, refs: anchors }] };
      continue;
    }

    // 同一变体再次命中：只追加新锚点。
    const variant = term.variants[variantIdx];
    const fresh = anchors.filter(a => !hasRef(variant.refs, a.imageId, a.regionId));
    if (fresh.length === 0) continue;
    const copy = ensure();
    const variants = [...term.variants];
    variants[variantIdx] = { ...variant, refs: [...variant.refs, ...fresh] };
    copy[termIdx] = { ...term, variants };
  }

  return next ?? book;
};

/**
 * 一条术语所有变体的锚点并集（去重）。统一替换的作用范围——不区分框当前
 * 显示的是哪个变体，替换时对所有变体值做扫描。
 */
export const termAnchors = (term: GlossaryTerm): GlossaryRef[] => {
  const out: GlossaryRef[] = [];
  for (const v of term.variants) {
    for (const ref of v.refs) {
      if (!hasRef(out, ref.imageId, ref.regionId)) out.push(ref);
    }
  }
  return out;
};

/** 术语的全部变体值，长的在前（先换长的，避免短变体吃掉长变体的前缀）。 */
export const variantValues = (term: GlossaryTerm): string[] =>
  [...term.variants.map(v => v.value)].sort((a, b) => b.length - a.length);

/**
 * 把 text 里出现的所有变体值替换成 target。target 自身跳过（幂等）。
 * 子串替换天然覆盖"路飞君"这类敬语后缀情形；代词（"他"）不在替换范围。
 */
export const replaceVariants = (text: string, values: string[], target: string): string => {
  let out = text;
  for (const value of values) {
    if (!value || value === target) continue;
    // 先长后短由调用方排序保证。split/join = 全局字面替换（不走正则，
    // 译名里的特殊字符不需要转义）。
    out = out.split(value).join(target);
  }
  return out;
};

/**
 * 用术语的已选译名统一一组框：editorText / editorFrozenText /
 * customTranslation 三个字段里的变体都换成标准译名。只返回确实改动的框
 * （新对象）；未改动的框不在结果里。
 *
 * selected == null 时无操作。
 */
export const unifyRegionsWithTerm = (term: GlossaryTerm, regions: Region[]): Region[] => {
  if (term.selected == null) return [];
  const target = term.variants[term.selected]?.value;
  if (!target) return [];
  const values = variantValues(term);
  const changed: Region[] = [];
  for (const r of regions) {
    const editorText = r.editorText !== undefined
      ? replaceVariants(r.editorText, values, target) : undefined;
    const editorFrozenText = r.editorFrozenText !== undefined
      ? replaceVariants(r.editorFrozenText, values, target) : undefined;
    const customTranslation = r.customTranslation !== undefined
      ? replaceVariants(r.customTranslation, values, target) : undefined;
    if (editorText === r.editorText && editorFrozenText === r.editorFrozenText
      && customTranslation === r.customTranslation) continue;
    changed.push({ ...r, editorText, editorFrozenText, customTranslation });
  }
  return changed;
};

// =====================================================================
// 序列化（session 持久化 / 工作区导出 / 单独导出共用）
// =====================================================================

export const GLOSSARY_BOOK_KIND = 'genai-patcher-glossary';
export const GLOSSARY_BOOK_VERSION = 1;

/** 对外导出/持久化的信封格式。 */
export interface GlossaryBookFile {
  kind: typeof GLOSSARY_BOOK_KIND;
  version: number;
  exportedAt?: string;
  terms: GlossaryTerm[];
}

/** 工作区备份用：全量序列化（含 refs）——同工作区还原时锚点依旧有效。
 *  单独导出的「可移植」格式见 serializeBookExport。 */
export const serializeBook = (book: GlossaryTerm[]): GlossaryBookFile => ({
  kind: GLOSSARY_BOOK_KIND,
  version: GLOSSARY_BOOK_VERSION,
  exportedAt: new Date().toISOString(),
  terms: book,
});

/** 宽容地把外部数据（导出文件 / session 记录 / 工作区 zip）还原成术语树。
 *  坏条目跳过，整体不可识别时返回 null。 */
export const sanitizeBook = (value: unknown): GlossaryTerm[] | null => {
  if (!value || typeof value !== 'object') return null;
  const termsValue = Array.isArray(value)
    ? value
    : Array.isArray((value as GlossaryBookFile).terms)
      ? (value as GlossaryBookFile).terms
      : null;
  if (!termsValue) return null;

  const terms: GlossaryTerm[] = [];
  for (const rawTerm of termsValue) {
    if (!rawTerm || typeof rawTerm !== 'object') continue;
    const key = String((rawTerm as any).key ?? '').trim();
    if (!key) continue;
    const rawVariants = Array.isArray((rawTerm as any).variants) ? (rawTerm as any).variants : [];
    const variants: GlossaryVariant[] = [];
    for (const rawVariant of rawVariants) {
      if (!rawVariant || typeof rawVariant !== 'object') continue;
      const v = String((rawVariant as any).value ?? '').trim();
      if (!v) continue;
      const custom = (rawVariant as any).custom === true;
      // 每术语最多一个用户槽位；与 AI 译名重名的槽位直接丢弃（重复值会破坏
      // 锚点归属与列表 key 的唯一性，见 setCustomVariantValue）。
      if (custom && (variants.some(x => x.custom) || variants.some(x => !x.custom && x.value === v))) continue;
      const rawRefs = Array.isArray((rawVariant as any).refs) ? (rawVariant as any).refs : [];
      const refs: GlossaryRef[] = [];
      for (const rawRef of rawRefs) {
        if (!rawRef || typeof rawRef !== 'object') continue;
        const imageId = String((rawRef as any).imageId ?? '');
        const regionId = String((rawRef as any).regionId ?? '');
        if (!imageId || !regionId) continue;
        if (!hasRef(refs, imageId, regionId)) refs.push({ imageId, regionId });
      }
      variants.push({ value: v, refs, ...(custom ? { custom: true } : {}) });
    }
    if (variants.length === 0) continue;
    const rawSelected = (rawTerm as any).selected;
    const selected = typeof rawSelected === 'number'
      && Number.isInteger(rawSelected)
      && rawSelected >= 0
      && rawSelected < variants.length
      ? rawSelected
      : null;
    const note = typeof (rawTerm as any).note === 'string' ? (rawTerm as any).note : undefined;
    terms.push({ key, variants, selected, ...(note ? { note } : {}) });
  }
  return terms;
};

// =====================================================================
// 可移植导出 / 导入（单独「导出 JSON」/「导入 JSON」）
//
// 与工作区备份（serializeBook/sanitizeBook，全量含 refs）不同：这里只导出
// key + 当前译名（显式选定，或唯一译名——唯一即等于已选定），不带 refs ——
// 锚点绑定本工作区的框，换地方就没意义。
// 导入时按 key 与现有术语合并，导入的译名并进变体列表并默认选中，这样
// 分享/搬运术语表时既能落地译名，又不破坏本工作区已有的统计与选择。
// =====================================================================

/** 一条可移植术语：原文 key + 当前译名。 */
export interface GlossaryExportEntry {
  key: string;
  value: string;
}

/** 单独导出 JSON 的信封格式。 */
export interface GlossaryExportFile {
  kind: typeof GLOSSARY_BOOK_KIND;
  version: number;
  exportedAt?: string;
  terms: GlossaryExportEntry[];
}

export const GLOSSARY_EXPORT_VERSION = 2;

/** 导出「有译名」的术语：显式选定的，以及唯一译名（唯一即等于已选定）。
 *  多译名且未选定的无处可导——没有确定用哪个。 */
export const serializeBookExport = (book: GlossaryTerm[]): GlossaryExportFile => ({
  kind: GLOSSARY_BOOK_KIND,
  version: GLOSSARY_EXPORT_VERSION,
  exportedAt: new Date().toISOString(),
  terms: book.flatMap(t => {
    const idx = resolvedVariantIndex(t);
    const value = idx != null ? t.variants[idx]?.value : undefined;
    return value ? [{ key: t.key, value }] : [];
  }),
});

/** 解析「导出 JSON」，返回 key + 译名 条目（同 key 只取第一条）。容忍：
 *  新格式信封 / 裸数组 / 旧版全量 terms（从中取已选定的译名）。整体不可
 *  识别时返回 null。 */
export const parseBookExport = (value: unknown): GlossaryExportEntry[] | null => {
  const rawTerms: unknown =
    Array.isArray(value) ? value
      : value && typeof value === 'object' && Array.isArray((value as GlossaryExportFile).terms)
        ? (value as GlossaryExportFile).terms
        : null;
  if (!Array.isArray(rawTerms)) return null;

  const out: GlossaryExportEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawTerms) {
    if (!raw || typeof raw !== 'object') continue;
    const key = String((raw as any).key ?? '').trim();
    if (!key) continue;
    let val = typeof (raw as any).value === 'string' ? String((raw as any).value).trim() : '';
    if (!val) {
      // 旧格式：从 variants + selected 里取已选定的译名。
      const variants = Array.isArray((raw as any).variants) ? (raw as any).variants : [];
      const selected = (raw as any).selected;
      const picked = typeof selected === 'number' ? variants[selected] : undefined;
      if (picked && typeof (picked as any).value === 'string') val = String(picked.value).trim();
    }
    if (!val) continue; // 没有译名的条目进不来（导入项必须有译名）
    const norm = termKeyOf(key);
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ key, value: val });
  }
  return out;
};

/**
 * 把导入条目合并进术语树：同 key 的译名并进变体列表（已存在则不重复），并把
 * 该译名设为选定项（导入即默认选它）；没有的 key 则新建术语。
 *
 * 导入的译名以**普通变体**身份加入（不是用户自定义槽位）：它照常参与 AI 选择
 * 候选，之后某页译文命中时也会叠加锚点。refs 留空 —— 导出时已剥离锚点，导入
 * 方的锚点由后续本地匹配重新建立。
 */
export const mergeImportedEntries = (
  book: GlossaryTerm[],
  entries: GlossaryExportEntry[]
): GlossaryTerm[] => {
  if (entries.length === 0) return book;
  let next: GlossaryTerm[] | null = null;
  /** 惰性复制：只有真正变更的那一层才换新数组/对象。 */
  const ensure = (): GlossaryTerm[] => (next ??= [...book]);

  for (const { key, value } of entries) {
    const norm = termKeyOf(key);
    const list = next ?? book;
    const termIdx = list.findIndex(t => termKeyOf(t.key) === norm);
    if (termIdx === -1) {
      ensure().push({ key: key.trim(), variants: [{ value, refs: [] }], selected: 0 });
      continue;
    }
    const term = list[termIdx];
    const nextTerm = addAndSelectVariant(term, value);
    if (nextTerm === term) continue; // 已经选的就是它
    ensure()[termIdx] = nextTerm;
  }
  return next ?? book;
};

// =====================================================================
// AI 选择标准译名（纯文本调用，不丢图）
//
// 译名判断是语言知识不是视觉知识：知名作品的官方译名模型本来就知道，
// 语境线索在句子里不在画面里。给料 = key + 各变体（频次 + 锚定例句），
// 例句取锚定框的 sourceText + 当前译文。
// =====================================================================

/** AI 选择只处理"有多种译名且尚未人工选定"的术语；人工选过的一律尊重。
 *  口径只数 AI 译名（见 aiVariants）：用户自己加的槽位不是模型的候选。 */
export const aiPickCandidates = (book: GlossaryTerm[]): GlossaryTerm[] =>
  book.filter(t => t.selected == null && aiVariants(t).length >= 2);

/** 一次调用最多带多少条术语（控制输出长度，超了分批）。 */
export const AI_PICK_BATCH_SIZE = 80;

export interface AiPickExample {
  source: string;
  translation: string;
}

export interface AiPickItem {
  key: string;
  variants: { value: string; count: number; examples: AiPickExample[] }[];
}

export const buildAiPickPrompt = (items: AiPickItem[]): string => {
  const payload = JSON.stringify(items, null, 1);
  return `你是一名漫画翻译审校。下面是同一部作品里同一批原文术语被译成的不同中文译名（variants），每个译名带出现次数（count）和实际例句（source=原文句子，translation=该句当前译文）。

任务：为每个术语从它的 variants 里**只选一个**作为全作统一的标准译名。

判断依据（按优先级）：
1. 知名作品的角色/地名/招式优先使用官方或通行译名（你的既有知识）；
2. 出现次数多的通常更可靠，但次数少不代表错；
3. 结合例句语境（性别、敬语、组织关系）；
4. 音译风格尽量与作品其他译名一致。

规则：
- value 必须是该术语 variants 里原样出现的一个，禁止新造译名；
- 无法判断时就选 count 最大的那个；
- note 用不超过 20 个字简述理由（如「官方译名」「更常用」），没有可说的就空字符串；
- 只输出 JSON 数组，不要任何解释或 markdown 代码块。

术语列表（JSON）：
${payload}

输出格式：
[{"key":"原文","value":"选定的译名","note":"理由"}]`;
};

export interface AiPickResult {
  key: string;
  value: string;
  note?: string;
}

/** 从 AI 响应里提取选择结果。容忍前后散文 / 代码围栏 / 半坏 JSON（逐对象捞取）。 */
export const parseAiPickResponse = (content: string): AiPickResult[] => {
  const cleaned = content.replace(/```[a-zA-Z]*/g, '');
  const results: AiPickResult[] = [];
  // 逐对象捞取：{"key":"…","value":"…","note":"…"} —— 数组括号缺了也能救。
  const re = /\{[^{}]*"key"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*"value"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*\}/g;
  let m: RegExpExecArray | null;
  const unescape = (s: string) =>
    s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  while ((m = re.exec(cleaned)) !== null) {
    const key = unescape(m[1]).trim();
    const value = unescape(m[2]).trim();
    if (!key || !value) continue;
    const noteMatch = /"note"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(m[0]);
    const note = noteMatch ? unescape(noteMatch[1]).trim() : '';
    results.push({ key, value, ...(note ? { note } : {}) });
  }
  return results;
};

// =====================================================================
// 术语组一致（共享词根跨术语统一）
//
// 与「AI 选择」互补、且**完全独立**：AI 选择处理「一条术语内部有多种译名」，
// 这里处理「多条术语共享同一段原文词根，却被译成了不同写法」——比如
// グランディス城→葛兰迪斯城、グランディス軍→格兰迪斯军，两条各自都只有唯一
// 译名，单术语那套根本发现不了。
//
// 本地先把共享词根（前缀/后缀）聚成组（纯计算），只把组丢给 AI，让它**把同组
// 当作彼此的参考**，为每个成员给出各自最合适的中文译名——**不强行统一**（强行
// 统一词根会把「魔王様」误拼成「魔王国王」这类别扭译名）。落地沿用术语表现有
// 的「新增变体 + 选中」机制（见 addAndSelectVariant），旧译名留在变体列表里，
// 可回退，替换照走 applyUnify。
// =====================================================================

/**
 * 共享词根的最小长度（按内容判定）：CJK/假名 2 个字就有意义（王都/王城），
 * 纯拉丁字母 2 个太容易误聚（Al/An…），要求 3 个。
 */
const minSharedRootLen = (root: string): number => (/^[\x00-\x7f]+$/.test(root) ? 3 : 2);
/** 单组成员上限：超大组多半是过度聚合，宁缺毋滥。 */
const MAX_GROUP_SIZE = 20;

/** 一组共享同一段原文词根的术语。 */
export interface TermGroup {
  /** 组内原文共享的词根。 */
  root: string;
  /** 词根在原文里的位置：prefix = 开头，suffix = 结尾。 */
  position: 'prefix' | 'suffix';
  /** 组内术语（≥2 条），每条都能取到当前译名。 */
  members: GlossaryTerm[];
}

const commonPrefixLen = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
};

const reverseStr = (s: string): string => [...s].reverse().join('');

interface ScannedGroup { root: string; members: GlossaryTerm[]; }

/**
 * 在 transform 后的字符串上按「相邻对的公共前缀」聚类（transform = 反转时即公共后缀）。
 *
 * 用相邻对而不是"整段公共前缀"：排序后，任意两串共享的前缀都会被某个相邻对覆盖，
 * 而按**相邻对的共享词根**归类能保留更细的粒度——否则 [グラン, グランディス城,
 * グランディス軍] 会被整段压成 2 字的 グラン，把不相关的一条也拖进来。
 */
const scanSharedGroups = (
  items: GlossaryTerm[],
  transform: (s: string) => string
): ScannedGroup[] => {
  const sorted = [...items].sort((a, b) => {
    const ka = transform(a.key);
    const kb = transform(b.key);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const byRoot = new Map<string, GlossaryTerm[]>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = transform(sorted[i].key);
    const b = transform(sorted[i + 1].key);
    const root = a.slice(0, commonPrefixLen(a, b));
    if (root.length < minSharedRootLen(root)) continue;
    let members = byRoot.get(root);
    if (!members) { members = []; byRoot.set(root, members); }
    if (!members.includes(sorted[i])) members.push(sorted[i]);
    if (!members.includes(sorted[i + 1])) members.push(sorted[i + 1]);
  }
  const groups: ScannedGroup[] = [];
  for (const [root, members] of byRoot) {
    if (members.length >= 2 && members.length <= MAX_GROUP_SIZE) {
      groups.push({ root: transform(root), members });
    }
  }
  return groups;
};

/**
 * 找出「共享同一段原文词根」的术语组（本地计算，不调 AI）。
 *
 * 前缀与后缀各扫一遍；一条术语最多进一个组（词根长的组优先占用），避免同一
 * 术语被两组反复改写。只有能取到当前译名的术语参与——未决的交给单术语
 * 「AI 选择」，两者互不干扰。
 */
export const findTermGroups = (book: GlossaryTerm[]): TermGroup[] => {
  const usable = book.filter(t => effectiveTranslation(t) != null && t.key.length >= 2);
  if (usable.length < 2) return [];

  const raw: TermGroup[] = [
    ...scanSharedGroups(usable, s => s).map(g => ({ root: g.root, position: 'prefix' as const, members: g.members })),
    ...scanSharedGroups(usable, reverseStr).map(g => ({ root: g.root, position: 'suffix' as const, members: g.members })),
  ];

  // 词根长的优先占用术语；已被占用的组成员不再进其他组。
  raw.sort((a, b) => b.root.length - a.root.length || b.members.length - a.members.length);
  const used = new Set<string>();
  const out: TermGroup[] = [];
  for (const g of raw) {
    const keys = g.members.map(m => termKeyOf(m.key));
    if (keys.some(k => used.has(k))) continue;
    keys.forEach(k => used.add(k));
    out.push(g);
  }
  return out;
};

/** 一次调用最多带多少条成员（控制输出长度，超了分批）。 */
export const GROUP_UNIFY_BATCH_MEMBERS = 240;

/** 发给 AI 的一组（成员带当前译名 + 实际例句）。 */
export interface GroupUnifyItem {
  root: string;
  position: 'prefix' | 'suffix';
  members: { key: string; value: string; examples: AiPickExample[] }[];
}

export const buildGroupUnifyPrompt = (items: GroupUnifyItem[]): string => {
  const payload = JSON.stringify(items, null, 1);
  return `你是一名漫画翻译审校。下面每组里的多个原文术语共享同一段词根（root；position=prefix 表示词根在原文开头，suffix 表示在结尾），说明它们是同一族（family）的词——例如同一人名/地名配不同后缀，或同一后缀配不同前缀。每个成员带当前中文译文（value）和实际例句（examples：source=原文句子，translation=该句当前译文）。

任务：**把同组成员当作彼此的参考**，为每个成员给出它在全作里最合适的中文译名。同族术语尽量协调，但**不要求强行统一**。

重要：不要为了迁就同组其他成员而给出别扭的译名。如果某个成员按语境/习惯有更贴切的翻译（例如「王様」= 国王大人、「魔王様」= 魔王大人），就保留/给出那个——不要因为同组有个「王様」就把「魔王様」硬拼成「魔王国王」。

判断依据（按优先级）：
1. 知名作品的角色/地名/招式优先使用官方或通行译名（你的既有知识）；
2. 结合例句语境（说话对象、敬语、亲疏关系）；
3. 同族风格协调，但以「每条各自最自然」为准。

规则：
- value 是重新写过的**完整译名**；
- 只列出**确实需要改动**的成员；译文已经合适的成员不要列出；
- 没有更好的写法就跳过该成员，不要为了凑数而改；
- 整组都不需要改动时，members 返回空数组；
- 无法判断的组直接跳过，不要放进结果；
- 只输出 JSON 数组，不要任何解释或 markdown 代码块。

术语组（JSON）：
${payload}

输出格式：
[{"root":"原文词根","members":[{"key":"原文","value":"最合适的完整译名"}]}]`;
};

export interface GroupUnifyMember {
  key: string;
  value: string;
}

export interface GroupUnifyResult {
  /** 模型回填的组根（用于把结果对回我们发出去的组）。 */
  root: string;
  /** 建议改动的成员（空数组 = 这组无需变动）。 */
  members: GroupUnifyMember[];
}

const normalizeGroupResult = (raw: any): GroupUnifyResult | null => {
  if (!raw || typeof raw !== 'object') return null;
  const root = String(raw.root ?? '').trim();
  const rawMembers = Array.isArray(raw.members) ? raw.members : [];
  const members: GroupUnifyMember[] = [];
  for (const m of rawMembers) {
    if (!m || typeof m !== 'object') continue;
    const key = String(m.key ?? '').trim();
    const value = String(m.value ?? '').trim();
    if (!key || !value) continue;
    members.push({ key, value });
  }
  if (members.length === 0) return null;
  return { root, members };
};

/** 从文本里捞顶层 {...} 对象数组（跳过字符串内的括号），半坏 JSON 也能救一部分。 */
const extractJsonObjects = (text: string): unknown[] => {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start !== -1) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch { /* skip bad object */ }
        start = -1;
      }
    }
  }
  return out;
};

/** 解析术语组一致的响应（含嵌套 members）。先整体解析，失败再逐对象捞取。 */
export const parseGroupUnifyResponse = (content: string): GroupUnifyResult[] => {
  const cleaned = content.replace(/```[a-zA-Z]*/g, '');
  const results: GroupUnifyResult[] = [];

  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const r = normalizeGroupResult(item);
          if (r) results.push(r);
        }
        if (results.length > 0) return results;
      }
    } catch { /* 落回逐对象捞取 */ }
  }

  for (const obj of extractJsonObjects(cleaned)) {
    const r = normalizeGroupResult(obj);
    if (r) results.push(r);
  }
  return results;
};
