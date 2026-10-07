import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppConfig, GlossaryRef, GlossaryTerm, Language } from '../../types';
import { t } from '../../services/translations';
import { HelpTip } from './HelpTip';

/**
 * 术语表 v2 的 dock 区块 —— 编辑器右侧面板下方的 tab（见 EditorDock）。
 *
 * 树形结构：每个原文 key 一行，展开后是它的译名变体。被选中的标准译名亮显，
 * 未选中的暗显；点击变体即选定/改选（本地字符串替换统一，不重翻）。×N 是
 * 该变体的锚点频次，点击逐个跳到涉及的框。
 *
 * 顶部操作：AI 选择（未决术语批量丢给翻译端点挑标准译名）/ 导出 JSON /
 * 清空（两步确认）。底部两个开关：新页自动统一、批后自动 AI 选择。
 */

export interface GlossarySectionProps {
  lang: Language;
  book: GlossaryTerm[];
  aiSelecting: boolean;
  unresolvedCount: number;
  autoUnify: boolean;
  autoAiSelect: boolean;
  /** 操作结果的一次性提示（AI 选择完成/无可选），由外层几秒后清掉。 */
  notice?: string | null;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  onSelectVariant: (key: string, variantIndex: number | null) => void;
  onRunAiSelection: () => void;
  onExport: () => void;
  /** 单独导入 JSON 文件（整本替换）。 */
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

/** 未决 = 有多种译名且尚未选定标准译名（AI 选择 / 人工最该先处理的）。 */
const isUnresolved = (term: GlossaryTerm): boolean =>
  term.selected == null && term.variants.length >= 2;

const totalRefs = (term: GlossaryTerm): number =>
  term.variants.reduce((n, v) => n + v.refs.length, 0);

const TermRow: React.FC<{
  lang: Language;
  term: GlossaryTerm;
  expanded: boolean;
  onToggle: () => void;
  onSelectVariant: (variantIndex: number | null) => void;
  onJump: (value: string, refs: GlossaryRef[]) => void;
}> = ({ lang, term, expanded, onToggle, onSelectVariant, onJump }) => (
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
      <span className="text-[10px] font-bold text-skin-text truncate">{term.key}</span>
      {isUnresolved(term) && (
        <span className="text-[8px] font-bold px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">
          {t(lang, 'glossaryUnresolved')}
        </span>
      )}
      <span className="ml-auto text-[9px] text-skin-muted shrink-0">
        {t(lang, 'glossaryVariantCount', { count: term.variants.length })}
      </span>
    </button>
    {expanded && (
      <div className="py-0.5">
        {term.variants.map((v, vi) => {
          const selected = term.selected === vi;
          return (
            <div key={v.value} className="flex items-center gap-0.5 px-1.5 py-0.5">
              <button
                onClick={() => onSelectVariant(selected ? null : vi)}
                title={selected ? t(lang, 'glossaryUnselectVariantTip') : t(lang, 'glossarySelectVariantTip')}
                className={`flex-1 min-w-0 text-left text-[10px] truncate rounded px-1.5 py-0.5 transition-colors ${
                  selected
                    ? 'font-bold text-skin-primary bg-skin-primary/15'
                    : term.selected == null
                      ? 'text-skin-text hover:bg-skin-fill'
                      : 'text-skin-muted/60 hover:bg-skin-fill'
                }`}
              >
                {v.value}
              </button>
              <button
                onClick={() => onJump(v.value, v.refs)}
                disabled={v.refs.length === 0}
                title={t(lang, 'glossaryJumpTip')}
                className="text-[9px] font-mono px-1 py-0.5 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-40 transition-colors shrink-0"
              >
                ×{v.refs.length}
              </button>
            </div>
          );
        })}
        {term.note && (
          <div className="px-2 pb-0.5 text-[9px] text-skin-muted/80 leading-tight">{term.note}</div>
        )}
      </div>
    )}
  </div>
);

export const GlossarySection: React.FC<GlossarySectionProps> = React.memo(({
  lang,
  book,
  aiSelecting,
  unresolvedCount,
  autoUnify,
  autoAiSelect,
  notice,
  onConfigChange,
  onSelectVariant,
  onRunAiSelection,
  onExport,
  onImport,
  onClear,
  onJumpToRef,
}) => {
  const [open, setOpen] = useState(loadOpen);
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const [clearArmed, setClearArmed] = useState(false);
  /** 当前有术语时点「导入」先武装一步 —— 导入是整本替换，防手滑覆盖。 */
  const [importArmed, setImportArmed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 变体 → 上次跳转到的锚点下标：点击 ×N 在锚点间轮转。 */
  const jumpIdxRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    try { localStorage.setItem(OPEN_STORAGE_KEY, open ? '1' : '0'); } catch { /* ignore */ }
  }, [open]);

  // 两步操作（清空 / 覆盖导入）：3 秒不点第二下就解除武装。
  useEffect(() => {
    if (!clearArmed && !importArmed) return;
    const timer = setTimeout(() => { setClearArmed(false); setImportArmed(false); }, 3000);
    return () => clearTimeout(timer);
  }, [clearArmed, importArmed]);

  /** 未决的排前面，其余按锚点总频次降序 —— 最影响阅读一致性的术语最先被看到。 */
  const sortedBook = useMemo(() =>
    [...book].sort((a, b) => {
      const ua = isUnresolved(a) ? 0 : 1;
      const ub = isUnresolved(b) ? 0 : 1;
      if (ua !== ub) return ua - ub;
      return totalRefs(b) - totalRefs(a);
    }),
  [book]);

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
          {/* 操作行 */}
          <div className="flex flex-wrap items-center gap-1 px-2 pb-1.5">
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
              onClick={onExport}
              disabled={book.length === 0}
              className="px-2 py-1 text-[10px] font-bold rounded border border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary hover:bg-skin-fill disabled:opacity-50 transition-colors"
            >
              {t(lang, 'glossaryExport')}
            </button>
            <button
              onClick={() => {
                // 空表直接开文件框；非空表先武装一步（导入是整本覆盖）。
                if (book.length > 0 && !importArmed) {
                  setImportArmed(true);
                  return;
                }
                fileInputRef.current?.click();
              }}
              className={`px-2 py-1 text-[10px] font-bold rounded border transition-colors ${
                importArmed
                  ? 'border-amber-500 text-white bg-amber-500 hover:bg-amber-600 animate-pulse'
                  : 'border-skin-border text-skin-muted hover:text-skin-primary hover:border-skin-primary hover:bg-skin-fill'
              }`}
            >
              {importArmed ? t(lang, 'glossaryImportConfirm') : t(lang, 'glossaryImport')}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ''; // 允许连续两次选同一个文件
                setImportArmed(false);
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
