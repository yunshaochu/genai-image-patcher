import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppConfig, GlossaryRef, GlossaryTerm, Language } from '../../types';
import { t } from '../../services/translations';
import { resolvedVariantIndex, stringSimilarity } from '../../services/glossaryBook';
import { HelpTip } from './HelpTip';

/**
 * 术语表 v2 的 dock 区块 —— 编辑器右侧面板下方的 tab（见 EditorDock）。
 *
 * 树形结构：每个原文 key 一行，展开后是它的译名变体。被选中的标准译名亮显，
 * 未选中的暗显；点击变体即选定/改选（本地字符串替换统一，不重翻）。×N 是
 * 该变体的锚点频次，点击逐个跳到涉及的框。
 *
 * 收起时行头在原文后附一个「→ 译名」（灰色）：已敲定、或只有唯一译名（唯一
 * 即等于已定）时显示该译名；多译名未决者只留原文，靠展开去挑。
 *
 * 变体列表末尾还有**用户自定义槽位**：AI 没译出想要的译名时，用户可以直接
 * 手写一个（每术语一个，可改可删），写入即选定为标准译名并统一替换 —— 见
 * services/glossaryBook.ts 的 setCustomVariantValue。
 *
 * 顶部操作分两行：第一行 AI 选择（未决术语批量丢给翻译端点挑标准译名）/ 统一
 * 相关术语（把共享词根的术语归为一组、让 AI 互为参考各挑最合适的译名，不强求
 * 统一）；第二行 导出 JSON（只带 key + 译名：已选定或唯一）/ 导入 JSON（按 key
 * 与现有术语合并，见 onImport）/ 清空（两步确认）。底部两个开关：新页自动统一、
 * 批后自动 AI 选择。
 */

export interface GlossarySectionProps {
  lang: Language;
  book: GlossaryTerm[];
  aiSelecting: boolean;
  unresolvedCount: number;
  /** 共享词根的术语组数（「统一相关术语」的角标）。 */
  groupCount: number;
  groupUnifying: boolean;
  autoUnify: boolean;
  autoAiSelect: boolean;
  /** 操作结果的一次性提示（AI 选择完成/无可选），由外层几秒后清掉。 */
  notice?: string | null;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  onSelectVariant: (key: string, variantIndex: number | null) => void;
  /** 写入 / 删除本术语的用户自定义译名（'' = 删除），写入即选定为标准译名。 */
  onSetCustomVariant: (key: string, value: string) => void;
  onRunAiSelection: () => void;
  /** 共享词根的术语组互为参考、各挑最合适的译名（独立于 onRunAiSelection）。 */
  onRunGroupUnify: () => void;
  onExport: () => void;
  /** 单独导入 JSON 文件（与现有术语按 key 合并；导入的译名并进变体并默认选中）。 */
  onImport: (file: File) => void;
  onClear: () => void;
  onJumpToRef: (imageId: string, regionId: string) => void;
}

const OPEN_STORAGE_KEY = 'genai_patcher_glossary_open_v1';

const loadOpen = (): boolean => {
  try { return localStorage.getItem(OPEN_STORAGE_KEY) !== '0'; } catch { return true; }
};

const MiniToggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void }> = ({ checked, onChange }) => (
  <label className="relative inline-flex items-center cursor-pointer shrink-0">
    <input
      type="checkbox"
      className="sr-only peer"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
    <div className="w-8 h-[18px] bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-skin-primary" />
  </label>
);

/** AI 译名个数（用户自定义槽位不计入）——与「N 个译名」角标同口径。 */
const aiVariantCount = (term: GlossaryTerm): number =>
  term.variants.filter(v => !v.custom).length;

/** 未决 = 有多种 AI 译名且尚未选定标准译名（AI 选择 / 人工最该先处理的）。
 *  口径只数 AI 变体：用户自己写的那个槽位不算"AI 给了多个译名"。 */
const isUnresolved = (term: GlossaryTerm): boolean =>
  term.selected == null && aiVariantCount(term) >= 2;

/** 收起时头部显示的译名：显式选定的，或唯一译名（唯一即等于已选定）。
 *  多译名未决者没有可显示的——靠展开去挑。判定口径与导出共用，见
 *  services/glossaryBook.ts 的 resolvedVariantIndex。 */
const headTranslation = (term: GlossaryTerm): string | null => {
  const idx = resolvedVariantIndex(term);
  return idx != null ? term.variants[idx]?.value ?? null : null;
};

/** 把最相似的字符串串成一条链（贪心最近邻），让相近的术语相邻显示。起点取
 *  「与其余项整体最相似」的那条以减少端点偏置；表很大时退化为字典序——相似度
 *  矩阵是 O(N²)，不值得为超大表付这个开销。 */
const orderBySimilarity = (
  items: GlossaryTerm[],
  keyOf: (term: GlossaryTerm) => string,
): GlossaryTerm[] => {
  const n = items.length;
  if (n <= 1) return items;
  if (n > 500) return [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  const keys = items.map(keyOf);
  const sim: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = stringSimilarity(keys[i], keys[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  let start = 0;
  let bestSum = -Infinity;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += sim[i][j];
    if (sum > bestSum) { bestSum = sum; start = i; }
  }

  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [start];
  used[start] = true;
  for (let step = 1; step < n; step++) {
    const last = order[order.length - 1];
    let pick = -1;
    let pickSim = -Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      if (sim[last][i] > pickSim) { pickSim = sim[last][i]; pick = i; }
    }
    used[pick] = true;
    order.push(pick);
  }
  return order.map(i => items[i]);
};

/** 变体行（AI 译名 / 用户自定义槽位共用）。 */
const VariantRow: React.FC<{
  lang: Language;
  value: string;
  refs: GlossaryRef[];
  selected: boolean;
  /** 尚未选定时，只有"选中"一种交互；选定时其余行暗显。 */
  dimmed: boolean;
  custom?: boolean;
  onToggleSelect: () => void;
  onJump: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}> = ({ lang, value, refs, selected, dimmed, custom, onToggleSelect, onJump, onEdit, onDelete }) => (
  <div className="flex items-center gap-0.5 px-1.5 py-0.5">
    <button
      onClick={onToggleSelect}
      title={selected ? t(lang, 'glossaryUnselectVariantTip') : t(lang, 'glossarySelectVariantTip')}
      className={`flex-1 min-w-0 text-left text-[10px] truncate rounded px-1.5 py-0.5 transition-colors ${
        selected
          ? 'font-bold text-skin-primary bg-skin-primary/15'
          : dimmed
            ? 'text-skin-muted/60 hover:bg-skin-fill'
            : 'text-skin-text hover:bg-skin-fill'
      }`}
    >
      {value}
    </button>
    {custom && (
      <span className="text-[8px] px-1 py-0.5 rounded bg-skin-fill text-skin-muted shrink-0">
        {t(lang, 'glossaryCustomTag')}
      </span>
    )}
    <button
      onClick={onJump}
      disabled={refs.length === 0}
      title={t(lang, 'glossaryJumpTip')}
      className="text-[9px] font-mono px-1 py-0.5 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-40 transition-colors shrink-0"
    >
      ×{refs.length}
    </button>
    {onEdit && (
      <button
        onClick={onEdit}
        title={t(lang, 'glossaryCustomEditTip')}
        className="text-[9px] px-1 py-0.5 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors shrink-0"
      >
        ✎
      </button>
    )}
    {onDelete && (
      <button
        onClick={onDelete}
        title={t(lang, 'glossaryCustomDeleteTip')}
        className="text-[10px] leading-none px-1 py-0.5 rounded text-skin-muted hover:text-rose-500 hover:bg-rose-500/10 transition-colors shrink-0"
      >
        ×
      </button>
    )}
  </div>
);

/**
 * 术语行：AI 译名变体列表 + 末尾的用户自定义译名槽位。
 *
 * 自定义槽位是就地编辑的：没有槽位时显示一枚虚线「＋ 自定义译名」按钮，点开
 * 变输入框，Enter 保存（＝选定为标准译名并统一替换），Esc 取消；已有槽位时
 * 用 ✎ 改值、× 删除。草稿态只活在展开期间（收起即卸载，不落库）。
 */
const TermRow: React.FC<{
  lang: Language;
  term: GlossaryTerm;
  expanded: boolean;
  onToggle: () => void;
  onSelectVariant: (variantIndex: number | null) => void;
  onJump: (value: string, refs: GlossaryRef[]) => void;
  onSetCustom: (value: string) => void;
}> = ({ lang, term, expanded, onToggle, onSelectVariant, onJump, onSetCustom }) => {
  /** null = 不在编辑态；字符串 = 正在编辑的草稿。 */
  const [draft, setDraft] = useState<string | null>(null);
  const customIdx = term.variants.findIndex(v => v.custom);
  const custom = customIdx === -1 ? null : term.variants[customIdx];
  /** 收起时就展示的译名（已敲定 / 唯一）——展开前就能一眼看到结果。 */
  const head = headTranslation(term);

  const commit = () => {
    const value = (draft ?? '').trim();
    setDraft(null);
    if (!value && !custom) return; // 空草稿 + 本来没槽位 = 没有变化
    onSetCustom(value);            // 空值 = 删除槽位
  };

  return (
    <div className="border border-skin-border rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1 px-1.5 py-1 bg-skin-fill/40 hover:bg-skin-fill text-left transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 text-skin-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="flex-1 min-w-0 flex items-center gap-1">
          <span className="text-[10px] font-bold text-skin-text truncate">{term.key}</span>
          {head && (
            <>
              <span className="text-[10px] text-skin-muted/70 shrink-0">→</span>
              <span className="text-[10px] text-skin-muted truncate">{head}</span>
            </>
          )}
        </span>
        {isUnresolved(term) && (
          <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">
            {t(lang, 'glossaryUnresolved')}
          </span>
        )}
        <span className="ml-auto text-[9px] text-skin-muted shrink-0">
          {t(lang, 'glossaryVariantCount', { count: term.variants.filter(v => !v.custom).length })}
        </span>
      </button>
      {expanded && (
        <div className="py-0.5">
          {term.variants.map((v, vi) => {
            if (v.custom) return null; // 自定义槽位固定画在最后一行
            const selected = term.selected === vi;
            return (
              <VariantRow
                key={v.value}
                lang={lang}
                value={v.value}
                refs={v.refs}
                selected={selected}
                dimmed={term.selected != null && !selected}
                onToggleSelect={() => onSelectVariant(selected ? null : vi)}
                onJump={() => onJump(v.value, v.refs)}
              />
            );
          })}

          {/* 用户自定义译名槽位 */}
          {draft !== null ? (
            <div className="flex items-center gap-0.5 px-1.5 py-0.5">
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  else if (e.key === 'Escape') setDraft(null);
                }}
                placeholder={t(lang, 'glossaryCustomPlaceholder')}
                className="flex-1 min-w-0 text-[10px] px-1.5 py-0.5 rounded border border-skin-primary/40 bg-skin-fill/30 text-skin-text outline-none focus:border-skin-primary"
              />
              <button
                onClick={commit}
                title={t(lang, 'glossaryCustomSaveTip')}
                className="text-[10px] leading-none px-1 py-0.5 rounded text-skin-primary hover:bg-skin-primary/15 transition-colors shrink-0"
              >
                ✓
              </button>
              <button
                onClick={() => setDraft(null)}
                title={t(lang, 'glossaryCustomCancelTip')}
                className="text-[10px] leading-none px-1 py-0.5 rounded text-skin-muted hover:bg-skin-fill transition-colors shrink-0"
              >
                ×
              </button>
            </div>
          ) : custom ? (
            <VariantRow
              lang={lang}
              value={custom.value}
              refs={custom.refs}
              selected={term.selected === customIdx}
              dimmed={term.selected != null && term.selected !== customIdx}
              custom
              onToggleSelect={() => onSelectVariant(term.selected === customIdx ? null : customIdx)}
              onJump={() => onJump(custom.value, custom.refs)}
              onEdit={() => setDraft(custom.value)}
              onDelete={() => onSetCustom('')}
            />
          ) : (
            <div className="px-1.5 py-0.5">
              <button
                onClick={() => setDraft('')}
                title={t(lang, 'glossaryAddCustomTip')}
                className="w-full text-left text-[10px] text-skin-muted border border-dashed border-skin-border rounded px-1.5 py-0.5 hover:border-skin-primary hover:text-skin-primary transition-colors truncate"
              >
                {t(lang, 'glossaryAddCustom')}
              </button>
            </div>
          )}

          {term.note && (
            <div className="px-2 pb-0.5 text-[9px] text-skin-muted/80 leading-tight">{term.note}</div>
          )}
        </div>
      )}
    </div>
  );
};

export const GlossarySection: React.FC<GlossarySectionProps> = React.memo(({
  lang,
  book,
  aiSelecting,
  unresolvedCount,
  groupCount,
  groupUnifying,
  autoUnify,
  autoAiSelect,
  notice,
  onConfigChange,
  onSelectVariant,
  onSetCustomVariant,
  onRunAiSelection,
  onRunGroupUnify,
  onExport,
  onImport,
  onClear,
  onJumpToRef,
}) => {
  const [open, setOpen] = useState(loadOpen);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [clearArmed, setClearArmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 变体 → 上次跳转到的锚点下标：点击 ×N 在锚点间轮转。 */
  const jumpIdxRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    try { localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  // 清空是两步操作：3 秒不点第二下就解除武装。
  useEffect(() => {
    if (!clearArmed) return;
    const timer = setTimeout(() => setClearArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [clearArmed]);

  /** 排序：先按译名个数降序分档（译名最多的排最前），每档内再按字符串相似度串成
   *  一条链，让相近的原文贴在一起相邻显示（便于一眼对比同一组的术语）。 */
  const sortedBook = useMemo(() => {
    const byCount = new Map<number, GlossaryTerm[]>();
    for (const term of book) {
      const n = aiVariantCount(term);
      const bucket = byCount.get(n);
      if (bucket) bucket.push(term);
      else byCount.set(n, [term]);
    }
    return [...byCount.keys()]
      .sort((a, b) => b - a)
      .flatMap(n => orderBySimilarity(byCount.get(n)!, term => term.key));
  }, [book]);

  const jumpToNextAnchor = (termKey: string, value: string, refs: GlossaryRef[]) => {
    if (refs.length === 0) return;
    const cycleKey = `${termKey}|${value}`;
    const next = ((jumpIdxRef.current.get(cycleKey) ?? -1) + 1) % refs.length;
    jumpIdxRef.current.set(cycleKey, next);
    const ref = refs[next];
    onJumpToRef(ref.imageId, ref.regionId);
  };

  return (
    <div className="border-t border-skin-border shrink-0 flex flex-col min-h-0">
      {/* Tab 头：始终可见，点击展开/收起。 */}
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-3 py-1.5 w-full text-left hover:bg-skin-fill/60 transition-colors"
      >
        <svg
          className={`w-3 h-3 shrink-0 text-skin-muted transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="text-[10px] font-bold text-skin-text">{t(lang, 'glossaryTab')}</span>
        {book.length > 0 && <span className="text-[9px] font-mono text-skin-muted">{book.length}</span>}
        {unresolvedCount > 0 && (
          <span className="ml-auto text-[8px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700">
            {unresolvedCount} {t(lang, 'glossaryUnresolved')}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col min-h-0 max-h-72">
          {/* 操作行：第一行 AI 相关动作，第二行 JSON 导入导出 + 清空 */}
          <div className="px-2 pb-1.5 space-y-1">
            <div className="flex items-center gap-1">
              <button
                onClick={onRunAiSelection}
                disabled={aiSelecting || unresolvedCount === 0}
                title={t(lang, 'glossaryAutoAiSelectDesc')}
                className="px-2 py-1 text-[10px] font-bold rounded border border-skin-primary/30 text-skin-primary bg-skin-primary/10 hover:bg-skin-primary/20 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                {aiSelecting && (
                  <svg className="animate-spin w-2.5 h-2.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                )}
                {aiSelecting
                  ? t(lang, 'glossaryAiSelecting')
                  : `${t(lang, 'glossaryAiSelect')}${unresolvedCount > 0 ? ` (${unresolvedCount})` : ''}`}
              </button>
              <button
                onClick={onRunGroupUnify}
                disabled={groupUnifying || groupCount === 0}
                title={t(lang, 'glossaryGroupUnifyTip')}
                className="px-2 py-1 text-[10px] font-bold rounded border border-skin-primary/30 text-skin-primary bg-skin-primary/10 hover:bg-skin-primary/20 disabled:opacity-50 transition-colors flex items-center gap-1"
              >
                {groupUnifying && (
                  <svg className="animate-spin w-2.5 h-2.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                )}
                {groupUnifying
                  ? t(lang, 'glossaryGroupUnifying')
                  : `${t(lang, 'glossaryGroupUnify')}${groupCount > 0 ? ` (${groupCount})` : ''}`}
              </button>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={onExport}
                disabled={book.length === 0}
                className="px-2 py-1 text-[10px] font-bold rounded border border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary hover:bg-skin-fill disabled:opacity-50 transition-colors"
              >
                {t(lang, 'glossaryExport')}
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                title={t(lang, 'glossaryImportTip')}
                className="px-2 py-1 text-[10px] font-bold rounded border border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary hover:bg-skin-fill transition-colors"
              >
                {t(lang, 'glossaryImport')}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = ''; // 允许连续两次选同一个文件
                  if (file) onImport(file);
                }}
              />
              <button
                onClick={() => {
                  if (clearArmed) {
                    onClear();
                    setClearArmed(false);
                  } else {
                    setClearArmed(true);
                  }
                }}
                disabled={book.length === 0}
                className={`ml-auto px-2 py-1 text-[10px] font-bold rounded border transition-colors disabled:opacity-50 ${
                  clearArmed
                    ? 'border-rose-500 text-white bg-rose-500 hover:bg-rose-600 animate-pulse'
                    : 'border-skin-border text-skin-muted hover:text-rose-500 hover:border-rose-400 hover:bg-rose-500/10'
                }`}
              >
                {clearArmed ? t(lang, 'glossaryClearConfirm') : t(lang, 'glossaryClear')}
              </button>
            </div>
          </div>

          {/* 操作结果提示（几秒后由外层清掉） */}
          {notice && (
            <div className="mx-2 mb-1.5 px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 text-[10px] leading-tight animate-in fade-in">
              {notice}
            </div>
          )}

          {/* 术语树 */}
          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-1.5 space-y-1">
            {sortedBook.length === 0 ? (
              <p className="text-[10px] text-skin-muted leading-relaxed border border-dashed border-skin-border rounded-lg p-2 bg-skin-fill/20">
                {t(lang, 'glossaryEmpty')}
              </p>
            ) : (
              sortedBook.map(term => (
                <TermRow
                  key={term.key}
                  lang={lang}
                  term={term}
                  expanded={!!expandedKeys[term.key]}
                  onToggle={() => setExpandedKeys(prev => ({ ...prev, [term.key]: !prev[term.key] }))}
                  onSelectVariant={(vi) => onSelectVariant(term.key, vi)}
                  onJump={(value, refs) => jumpToNextAnchor(term.key, value, refs)}
                  onSetCustom={(value) => onSetCustomVariant(term.key, value)}
                />
              ))
            )}
          </div>

          {/* 开关行 */}
          <div className="border-t border-skin-border/60 px-2 py-1 space-y-0.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-[10px] text-skin-text truncate">{t(lang, 'glossaryAutoUnify')}</span>
                <HelpTip text={t(lang, 'glossaryAutoUnifyDesc')} />
              </div>
              <MiniToggle checked={autoUnify} onChange={(v) => onConfigChange('glossaryAutoUnify', v)} />
            </div>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-[10px] text-skin-text truncate">{t(lang, 'glossaryAutoAiSelect')}</span>
                <HelpTip text={t(lang, 'glossaryAutoAiSelectDesc')} />
              </div>
              <MiniToggle checked={autoAiSelect} onChange={(v) => onConfigChange('glossaryAutoAiSelect', v)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default GlossarySection;
