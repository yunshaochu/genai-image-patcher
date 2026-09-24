import React, { useEffect, useRef, useState } from 'react';
import { ApiProfile, Language } from '../../types';
import { t } from '../../services/translations';
import { HelpTip } from './HelpTip';
import { FloatingPanel } from './FloatingPanel';

/** The three fields a preset snapshots — one URL/key/model triple. */
export interface ApiProfileValues {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface ApiProfileSwitcherProps {
  /** Saved presets for the API family being edited. */
  profiles: ApiProfile[];
  /** Preset the live fields mirror (null = nothing selected). */
  activeId: string | null;
  /** Current (possibly edited) live values. */
  current: ApiProfileValues;
  /** Replace the whole preset list + selection (append / update / rename / delete). */
  onProfilesChange: (profiles: ApiProfile[], activeId: string | null) => void;
  /** Write a preset's triple into the live config. */
  onApply: (values: ApiProfileValues) => void;
  language: Language;
}

const makeId = (): string => {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* ignore — fall through to the manual id */ }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
};

/** Host part of a base URL — used for the auto-suggested preset name.
 *  Deliberately string-based: `new URL()` throws on the bare `host:port/path`
 *  forms users frequently paste. */
const hostOf = (baseUrl: string): string =>
  (baseUrl || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0];

const suggestName = (values: ApiProfileValues): string => {
  const host = hostOf(values.baseUrl) || 'API';
  const model = (values.model || '').trim();
  return model ? `${host} · ${model}` : host;
};

const uniqueName = (base: string, profiles: ApiProfile[]): string => {
  if (!profiles.some(p => p.name === base)) return base;
  let i = 2;
  while (profiles.some(p => p.name === `${base} (${i})`)) i += 1;
  return `${base} (${i})`;
};

/**
 * Preset picker shared by the image-generation panel (SettingsPanel) and the
 * translation block (GlobalSettings). It owns no persistence itself: parents
 * pass the list from AppConfig and get every mutation back through
 * `onProfilesChange`, so each API family keeps its own independent list.
 *
 * Footprint is deliberately down to ONE row — 切组是这个控件唯一的高频动作，
 * 其余都是低频维护，全部收进 ⋯ 菜单，不再常驻三颗按钮和一行状态提示：
 *
 *   API 配置组  [已修改]                              (?)
 *   [ 中转站A ▾ ]                              ＋  ✓  ⋯
 *
 *  - 下拉框 = 切换，选中即把该组的 url/key/model 写进实时配置；编辑输入框
 *    **不会**偷偷改写已保存的组（「已修改」徽标 + ✓ 才写回）。
 *  - ＋ = 把当前输入另存为新的一组并选中。
 *  - ✓ = 把当前输入写回所选那组。和 ＋ 一样常用，所以并列；没有改动时置灰。
 *  - ⋯ = 重命名 / 删除（低频，收进菜单）。
 */
export const ApiProfileSwitcher: React.FC<ApiProfileSwitcherProps> = ({
  profiles,
  activeId,
  current,
  onProfilesChange,
  onApply,
  language,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [naming, setNaming] = useState<null | 'create' | 'rename'>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [armedDelete, setArmedDelete] = useState(false);
  const menuAnchorRef = useRef<HTMLDivElement | null>(null);

  // The ⋯ menu is portalled out of the panel, so it needs its own
  // click-outside handling. Clicks inside it are stopped by FloatingPanel, and
  // clicks on the ⋯ button itself are skipped here so its toggle keeps working.
  useEffect(() => {
    if (!menuOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (menuAnchorRef.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [menuOpen]);

  const active = profiles.find(p => p.id === activeId) ?? null;
  // Live values diverged from the selected preset → 「保存更改」 becomes usable.
  // Derived from props, so there is no second source of truth to keep in sync.
  const dirty = !!active && (
    active.baseUrl !== current.baseUrl ||
    active.apiKey !== current.apiKey ||
    active.model !== current.model
  );

  const closeMenu = () => {
    setMenuOpen(false);
    setArmedDelete(false);
  };

  const toggleMenu = () => {
    const next = !menuOpen;
    setMenuOpen(next);
    if (!next) setArmedDelete(false);
  };

  /** 切换：把该组的三个字段写进实时配置。下拉框始终显示所选组，不因编辑而
   *  退回「未选择」—— 那会让人以为选中丢了。 */
  const handleSelect = (value: string) => {
    closeMenu();
    if (!value) {
      onProfilesChange(profiles, null);
      return;
    }
    const profile = profiles.find(p => p.id === value);
    if (!profile) return;
    onProfilesChange(profiles, profile.id);
    onApply({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model });
  };

  /** 修改：把实时输入写回所选组（显式动作，不静默覆盖）。 */
  const handleUpdate = () => {
    if (!active || !dirty) return;
    onProfilesChange(
      profiles.map(p => (p.id === active.id
        ? { ...p, baseUrl: current.baseUrl, apiKey: current.apiKey, model: current.model }
        : p)),
      active.id,
    );
    closeMenu();
  };

  // 菜单里点删除仍是两步：文案就地变成确认语（菜单项整行铺开，不怕变宽）。
  const handleDelete = () => {
    if (!active) return;
    if (!armedDelete) {
      setArmedDelete(true);
      return;
    }
    onProfilesChange(profiles.filter(p => p.id !== active.id), null);
    closeMenu();
  };

  const startCreate = () => {
    closeMenu();
    setNameDraft(suggestName(current));
    setNaming('create');
  };

  const startRename = () => {
    if (!active) return;
    closeMenu();
    setNameDraft(active.name);
    setNaming('rename');
  };

  const confirmNaming = () => {
    if (naming === 'rename' && active) {
      const name = uniqueName(
        nameDraft.trim() || active.name,
        profiles.filter(p => p.id !== active.id),
      );
      onProfilesChange(profiles.map(p => (p.id === active.id ? { ...p, name } : p)), active.id);
      setNaming(null);
      return;
    }
    const values: ApiProfileValues = {
      baseUrl: current.baseUrl,
      apiKey: current.apiKey,
      model: current.model,
    };
    const name = uniqueName(nameDraft.trim() || suggestName(values), profiles);
    const profile: ApiProfile = { id: makeId(), name, ...values };
    onProfilesChange([...profiles, profile], profile.id);
    setNaming(null);
  };

  const iconButton = 'w-6 h-6 shrink-0 rounded-md border border-skin-border text-skin-muted '
    + 'hover:text-skin-primary hover:bg-skin-surface flex items-center justify-center transition-colors '
    + 'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-skin-muted disabled:hover:bg-transparent';

  const menuItem = 'w-full text-left px-2.5 py-1.5 text-[11px] text-skin-text transition-colors '
    + 'hover:bg-skin-fill disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent';

  return (
    <div className="rounded-lg border border-skin-border bg-skin-fill/30 p-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] uppercase font-bold text-skin-muted">{t(language, 'apiProfiles')}</span>
        <HelpTip text={t(language, 'apiProfilesDesc')} />
        {dirty && (
          <span className="text-[9px] px-1 py-px rounded border border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-400">
            {t(language, 'profileUnsaved')}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1" ref={menuAnchorRef}>
        <select
          value={active ? active.id : ''}
          onChange={(e) => handleSelect(e.target.value)}
          title={active ? `${active.baseUrl}\n${active.model}` : t(language, 'profileCustom')}
          className="flex-1 min-w-0 p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface text-skin-text focus:border-skin-primary transition-colors"
        >
          <option value="">{t(language, 'profileCustom')}</option>
          {profiles.map(p => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <button type="button" onClick={startCreate} title={t(language, 'profileSaveHint')} className={iconButton}>
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v14M5 12h14" />
          </svg>
        </button>

        {/* 写回所选组：与 ＋ 并列（同样高频）。有改动时高亮成主色，作为
            「现在点我有用」的信号；没有改动就置灰。 */}
        <button
          type="button"
          onClick={handleUpdate}
          disabled={!dirty}
          title={t(language, dirty ? 'profileUpdateHint' : 'profileNoChanges')}
          aria-label={t(language, 'profileUpdate')}
          className={`w-6 h-6 shrink-0 rounded-md border flex items-center justify-center transition-colors ${
            dirty
              ? 'border-skin-primary/60 text-skin-primary hover:bg-skin-primary/10'
              : 'border-skin-border text-skin-muted opacity-40 cursor-not-allowed'
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
        </button>

        <button
          type="button"
          onClick={toggleMenu}
          disabled={!active}
          title={t(language, 'profileMenu')}
          aria-label={t(language, 'profileMenu')}
          className={menuOpen
            ? 'w-6 h-6 shrink-0 rounded-md border border-skin-border bg-skin-surface text-skin-primary flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
            : iconButton}
        >
          <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="19" cy="12" r="1.7" />
          </svg>
        </button>
      </div>

      {naming && (
        <div className="flex items-center gap-1 animate-in fade-in slide-in-from-top-1">
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') confirmNaming();
              if (e.key === 'Escape') setNaming(null);
            }}
            placeholder={t(language, 'profileNamePlaceholder')}
            className="flex-1 min-w-0 p-1.5 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors"
          />
          <button
            type="button"
            onClick={confirmNaming}
            title={t(language, 'profileSaveHint')}
            className="w-6 h-6 shrink-0 rounded-md bg-skin-primary text-skin-primary-fg text-xs flex items-center justify-center hover:opacity-90 transition-opacity"
          >
            ✓
          </button>
          <button
            type="button"
            onClick={() => setNaming(null)}
            title={t(language, 'close')}
            className={iconButton}
          >
            ✕
          </button>
        </div>
      )}

      <FloatingPanel
        open={menuOpen && !!active}
        anchorRef={menuAnchorRef}
        maxHeight={240}
        className="rounded-md border border-skin-border bg-skin-surface overflow-hidden animate-in fade-in"
      >
          <button
            type="button"
            onClick={startRename}
            title={t(language, 'profileRenameHint')}
            className={menuItem}
          >
            {t(language, 'profileRename')}
          </button>
          <button
            type="button"
            onClick={handleDelete}
            title={t(language, armedDelete ? 'profileDeleteConfirm' : 'profileDeleteHint')}
            className={`${menuItem} border-t border-skin-border/60 ${
              armedDelete ? 'text-rose-500 bg-rose-500/10' : 'hover:text-rose-500'
            }`}
          >
            {armedDelete ? t(language, 'profileDeleteConfirm') : t(language, 'profileDelete')}
          </button>
      </FloatingPanel>
    </div>
  );
};

export default ApiProfileSwitcher;
