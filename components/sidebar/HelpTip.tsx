
import React from 'react';

/**
 * Small "?" affordance that hides a long help paragraph behind a hover /
 * focus tooltip. Used where an inline description used to eat two or three
 * lines of the sidebar (square fill, crop inset, …) without being read twice.
 *
 * Pure CSS (`group-hover` + `focus-within`), so there is no state and no JS
 * listener. The panel is anchored to the RIGHT edge of the row and opens
 * downwards on purpose: the sidebar is a 288px-wide scroll container that clips
 * overflowing children, so the panel must grow leftwards to stay visible.
 *
 * `<button>` is interactive content, which per the HTML spec keeps a click
 * inside a `<label>` from activating the associated checkbox — the onClick
 * guard below makes that explicit anyway.
 */
export const HelpTip: React.FC<{
  /** Tooltip body — pass an already translated string. */
  text: string;
  /** 'warn' colours the icon to flag a disabled control / caveat. */
  tone?: 'default' | 'warn';
  /** Which edge of the panel is anchored to the icon. Default 'right'. */
  align?: 'left' | 'right';
  className?: string;
}> = ({ text, tone = 'default', align = 'right', className = '' }) => {
  const buttonTone = tone === 'warn'
    ? 'border-amber-500/70 text-amber-500 hover:border-amber-500 hover:text-amber-600'
    : 'border-skin-border text-skin-muted hover:border-skin-primary hover:text-skin-primary';
  const panelTone = tone === 'warn' ? 'border-amber-500/40' : 'border-skin-border';

  return (
    <span className={`relative inline-flex group/help shrink-0 ${className}`}>
      <button
        type="button"
        aria-label={text}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
        className={`w-3.5 h-3.5 rounded-full border bg-skin-surface text-[8px] font-bold leading-none flex items-center justify-center cursor-help transition-colors ${buttonTone}`}
      >
        ?
      </button>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full mt-1.5 z-50 w-56 p-2 rounded-lg border bg-skin-text text-skin-surface text-[10px] leading-snug shadow-xl opacity-0 scale-95 transition-all duration-150 group-hover/help:opacity-100 group-hover/help:scale-100 group-focus-within/help:opacity-100 group-focus-within/help:scale-100 ${panelTone} ${align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left'}`}
      >
        {text}
      </span>
    </span>
  );
};

export default HelpTip;
