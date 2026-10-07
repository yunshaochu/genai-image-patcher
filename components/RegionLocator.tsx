
import React, { useEffect, useMemo, useState } from 'react';
import { Language, Region, UploadedImage, isRegionPaintable } from '../types';
import { t } from '../services/translations';

/**
 * AI 重绘模式的框定位器。
 *
 * 重绘往往要隔着好几页翻：已完成 / 待重绘的框散落在图库各处，靠眼睛找太费劲。
 * 这个小控件把两类框各自收成一个有序清单，点分类即可一路跳过去（自动切到那张
 * 图并选中那个框）—— 「已完成」= 已经重绘出结果的框，「待重绘」= 还没画过的
 * （含失败的：失败也要重跑，同样属于"等着重绘"）。
 */

export type LocateKind = 'pending' | 'completed';

export interface RegionNavTarget {
  imageId: string;
  regionId: string;
}

/**
 * 「已重绘」= 这一格真的被重绘过（翻译 / 擦除 / 自定义三种场景跑出来的 AI 产物），
 * 而不是「状态为完成」的全部框 —— 编辑器工作流里自己嵌字完成的框同样是
 * 'completed'，但它没有任何 AI 重绘痕迹，不该混进这个计数里。
 *
 * 判据（任一）：
 *  - AI「擦除」产物标记（aiErasedBase / aiEraseBaseUrl）；
 *  - AI「翻译」hold back 的译文（editorFrozenText）；
 *  - 非编辑器合成的成品贴图 / 落库的重绘场景 —— AI 重绘与「补丁工坊」回填都算
 *    重绘，它们的贴图一定不是编辑器合成出来的（编辑器合成的必定 editorComposited）。
 */
const isRedrawnRegion = (r: Region): boolean => {
  if (r.status !== 'completed') return false;
  if (r.aiErasedBase || r.aiEraseBaseUrl) return true;
  if (r.editorFrozenText?.trim()) return true;
  if (r.editorComposited) return false; // 编辑器自己嵌字的产物 → 不是重绘
  return !!r.processedImageUrl || r.redrawIntent !== undefined;
};

/**
 * 框的分类。两类互补、覆盖到每一个「还没拿到重绘产物」的框：
 *  - 'completed' → 已经有 AI 重绘产物的（见 isRedrawnRegion）；
 *  - 'pending'   → 其余全部：pending / failed / **processing** —— 正在跑的框也要
 *    能定位过去，否则一批跑起来时它就从这个清单里消失了，只能靠眼睛找。
 * 唯一的例外是「编辑器自己嵌字完成」的框（completed 但没有重绘痕迹）：它已经
 * 完成、管线也不会再挑到它，所以两边都不进。
 */
const matchesKind = (r: Region, kind: LocateKind): boolean =>
  kind === 'completed' ? isRedrawnRegion(r) : r.status !== 'completed';

/** 阅读顺序：先图库顺序，再框内自上而下、自左而右 —— 与翻页的直觉一致。 */
const readingOrder = (a: Region, b: Region) => a.y - b.y || a.x - b.x;

/** 收集可定位的框：跳过被跳过的页面，忽略不可绘制的框（气泡外轮廓等）。 */
export const collectLocateTargets = (
  images: UploadedImage[],
  kind: LocateKind
): RegionNavTarget[] => {
  const out: RegionNavTarget[] = [];
  for (const img of images) {
    if (img.isSkipped) continue;
    const hits = img.regions
      .filter(r => isRegionPaintable(r) && matchesKind(r, kind))
      .sort(readingOrder);
    for (const r of hits) out.push({ imageId: img.id, regionId: r.id });
  }
  return out;
};

interface RegionLocatorProps {
  images: UploadedImage[];
  language: Language;
  /** 当前选中的框 —— 光标跟着它走（画布上点哪个框，序号就落到哪里）。 */
  selectedRegionId: string | null;
  /** 跳转：切换图片并选中该框（与术语表的锚点跳转同一套语义）。 */
  onJump: (imageId: string, regionId: string) => void;
}

export const RegionLocator: React.FC<RegionLocatorProps> = ({
  images,
  language,
  selectedRegionId,
  onJump,
}) => {
  const [kind, setKind] = useState<LocateKind>('pending');
  const pending = useMemo(() => collectLocateTargets(images, 'pending'), [images]);
  const completed = useMemo(() => collectLocateTargets(images, 'completed'), [images]);
  const list = kind === 'pending' ? pending : completed;

  /**
   * 光标 = 「上次跳到第几个」，而不是每次都拿当前选中框现算。
   *
   * 关键差别：删框之后选中框就没了（selectedRegionId 变 null），如果位次是从
   * 选中框反推的，序号会立刻掉回 0 —— 只能从头再跳一遍。所以这里自己记住位次：
   *  - `id`   跟着框走，清单里的框被删/增导致下标平移时自动补位；
   *  - `index` 兜底，那个框本身被删掉了就沿用原位次（夹到新长度内）。
   */
  const [cursor, setCursor] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });

  const cursorInList = cursor.id ? list.findIndex(v => v.regionId === cursor.id) : -1;
  /** 光标指向的框已经不在清单里了（就是刚被删掉的那个）。 */
  const cursorLost = cursor.id !== null && cursorInList < 0;

  const pos = useMemo(() => {
    if (list.length === 0) return -1;
    if (cursorInList >= 0) return cursorInList;
    return Math.min(Math.max(cursor.index, 0), list.length - 1);
  }, [list.length, cursorInList, cursor.index]);

  // 序号输入框：编辑中就显示用户敲的内容，闲时跟随光标。
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (editing) return;
    setDraft(list.length === 0 || pos < 0 ? '' : String(pos + 1));
  }, [pos, list.length, editing]);

  // 外部改选中（画布上点框、术语表跳转…）→ 光标跟着走。
  const selIdx = list.findIndex(v => v.regionId === selectedRegionId);
  useEffect(() => {
    if (!selectedRegionId || selIdx < 0) return;
    setCursor(prev => (prev.id === selectedRegionId ? prev : { id: selectedRegionId, index: selIdx }));
  }, [selIdx, selectedRegionId]);

  const jumpTo = (i: number) => {
    if (list.length === 0) return;
    const at = ((i % list.length) + list.length) % list.length;
    const target = list[at];
    setCursor({ id: target.regionId, index: at });
    setDraft(String(at + 1));
    onJump(target.imageId, target.regionId);
  };

  /** 在清单里前后挪一格；还没落到清单上时按方向取首 / 末。 */
  const step = (dir: 1 | -1) => {
    if (list.length === 0) return;
    if (pos < 0) { jumpTo(0); return; }
    // 光标那一格刚被删掉 → 往前走时先落到「接替它位置」的那个框，不跳过它。
    if (dir === 1 && cursorLost) { jumpTo(pos); return; }
    jumpTo(pos + dir);
  };

  /** 点分类：同一个分类再点 = 继续往下找；换分类 = 从当前位置之后接上。 */
  const pickKind = (next: LocateKind) => {
    const target = next === 'pending' ? pending : completed;
    if (target.length === 0) return;
    if (next === kind) { step(1); return; }
    setKind(next);
    const cur = selectedRegionId ? target.findIndex(v => v.regionId === selectedRegionId) : -1;
    const at = cur >= 0 ? (cur + 1) % target.length : 0;
    const hit = target[at];
    setCursor({ id: hit.regionId, index: at });
    setDraft(String(at + 1));
    onJump(hit.imageId, hit.regionId);
  };

  /** 手动输入序号跳转（越界 / 非数字直接忽略）。 */
  const commitDraft = () => {
    const n = Number.parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1 && n <= list.length) jumpTo(n - 1);
    setEditing(false);
  };

  const navBtn = 'w-5 h-5 shrink-0 rounded-full flex items-center justify-center '
    + 'text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors '
    + 'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-skin-muted';

  // 按钮一律吃掉 mousedown：序号框正在输入时点 ‹ › / 分类不该先触发 blur 提交。
  const noFocusSteal = (e: React.MouseEvent) => e.preventDefault();

  const chip = (k: LocateKind, count: number) => {
    const isActive = kind === k;
    const empty = count === 0;
    return (
      <button
        key={k}
        type="button"
        onMouseDown={noFocusSteal}
        onClick={() => pickKind(k)}
        disabled={empty}
        title={empty
          ? t(language, 'locateEmpty')
          : t(language, k === 'pending' ? 'locatePendingTip' : 'locateCompletedTip')}
        className={`px-2 py-0.5 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? (k === 'pending'
                ? 'bg-skin-primary text-skin-primary-fg font-bold'
                : 'bg-emerald-500 text-white font-bold')
            : 'text-skin-muted hover:text-skin-text hover:bg-skin-fill'
        }`}
      >
        {t(language, k === 'pending' ? 'locatePending' : 'locateCompleted')}
        <span className="ml-1 font-mono opacity-80">{count}</span>
      </button>
    );
  };

  return (
    <div
      className="rounded-full border border-skin-border bg-skin-surface/90 backdrop-blur-md shadow-sm flex items-center gap-0.5 p-0.5 text-[10px] select-none"
      title={t(language, 'locateTitle')}
    >
      <span className="px-1.5 text-skin-muted font-bold uppercase tracking-wide">{t(language, 'locateTitle')}</span>
      {chip('pending', pending.length)}
      {chip('completed', completed.length)}
      <span className="w-px h-4 bg-skin-border mx-0.5" />
      <button
        type="button"
        onMouseDown={noFocusSteal}
        onClick={() => step(-1)}
        disabled={list.length === 0}
        title={t(language, 'locatePrev')}
        className={navBtn}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        disabled={list.length === 0}
        onChange={(e) => { setEditing(true); setDraft(e.target.value.replace(/[^0-9]/g, '')); }}
        onFocus={() => { setEditing(true); setDraft(pos >= 0 ? String(pos + 1) : ''); }}
        onBlur={commitDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commitDraft(); e.currentTarget.blur(); }
          else if (e.key === 'Escape') { setEditing(false); e.currentTarget.blur(); }
        }}
        title={t(language, 'locateJumpTip')}
        className="w-8 h-5 px-0.5 text-[10px] font-mono text-center rounded bg-skin-fill border border-skin-border text-skin-text focus:border-skin-primary focus:outline-none disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      />
      <span className="px-0.5 text-skin-muted font-mono">/{list.length}</span>
      <button
        type="button"
        onMouseDown={noFocusSteal}
        onClick={() => step(1)}
        disabled={list.length === 0}
        title={t(language, 'locateNext')}
        className={navBtn}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
};

export default RegionLocator;
