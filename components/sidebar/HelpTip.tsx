import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Panel width — matches the old 16rem, shrunk to fit very narrow viewports. */
const PANEL_MAX_PX = 256;
/** Icon → panel gap. */
const GAP_PX = 8;
/** Minimum breathing room against the viewport edges. */
const EDGE_PX = 8;
/** Below this much room under the icon, prefer opening upwards. */
const MIN_SPACE_BELOW_PX = 120;

interface TipPlacement {
    left: number;
    width: number;
    /** Caret offset from the panel's left edge, pointing at the icon. */
    caretLeft: number;
    /** Anchored under the icon… */
    top?: number;
    /** …or above it. Using `bottom` (not a negative translate) keeps the
     *  element's `transform` free for the enter animation. */
    bottom?: number;
}

/**
 * Small "?" affordance that hides a long help paragraph behind a hover /
 * focus tooltip — the replacement for inline description paragraphs that ate
 * two or three lines of a panel without being read twice.
 *
 * The panel is rendered into `document.body` with `position: fixed`, NOT as an
 * absolutely-positioned child of the icon. Every panel this lives in is a
 * scroll container, and a scroll container clips BOTH axes (`overflow-y: auto`
 * forces `overflow-x` to `auto` too), which cut the panel in half — text
 * vanishing mid-sentence, exactly the bug this rewrite fixes. Portalling out
 * of the DOM tree escapes every clipper; `fixed` also survives `overflow`,
 * `transform`ed ancestors are no longer a concern because body has none.
 *
 * Placement is recomputed on hover/focus and while open (any scroll of any
 * container, since scroll events do not bubble — hence the capture listener).
 * It opens downwards by default and flips up when there is no room below.
 *
 * Placement rule for the icon itself: it sits IMMEDIATELY after the text it
 * explains, before status chips and inputs, never pushed to the row's edge.
 * Both used to exist in this codebase and the mix read as a broken layout.
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
    /** Custom trigger (e.g. a toolbar icon button). When omitted, the built-in
     *  "?" circle is used. The trigger keeps its own onClick — this component
     *  only supplies the hover/focus plumbing, so a button here still works. */
    children?: React.ReactNode;
}> = ({ text, tone = 'default', align = 'right', className = '', children }) => {
    const anchorRef = useRef<HTMLSpanElement | null>(null);
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [placement, setPlacement] = useState<TipPlacement | null>(null);
    const open = hovered || focused;

    const place = useCallback(() => {
        const el = anchorRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const width = Math.min(PANEL_MAX_PX, vw - EDGE_PX * 2);
        const preferredLeft = align === 'right' ? rect.right - width : rect.left;
        const left = Math.max(EDGE_PX, Math.min(preferredLeft, vw - width - EDGE_PX));

        const spaceBelow = vh - rect.bottom - GAP_PX;
        const spaceAbove = rect.top - GAP_PX;
        const opensBelow = spaceBelow >= MIN_SPACE_BELOW_PX || spaceBelow >= spaceAbove;

        const caretLeft = Math.max(10, Math.min(rect.left + rect.width / 2 - left, width - 10));

        setPlacement(opensBelow
            ? { left, width, caretLeft, top: rect.bottom + GAP_PX }
            : { left, width, caretLeft, bottom: vh - rect.top + GAP_PX });
    }, [align]);

    // Measure before the panel's first paint so it never flashes at 0,0.
    useLayoutEffect(() => {
        if (open) place();
    }, [open, place]);

    useEffect(() => {
        if (!open) return;
        const onMove = () => place();
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [open, place]);

    const buttonTone = tone === 'warn'
        ? 'border-amber-500/70 bg-amber-500/10 text-amber-500 hover:border-amber-500 hover:text-amber-600'
        : 'border-skin-border bg-skin-fill text-skin-muted hover:border-skin-primary hover:bg-skin-primary/10 hover:text-skin-primary';
    const panelTone = tone === 'warn' ? 'border-amber-500/40' : 'border-skin-text';

    return (
        <span
            ref={anchorRef}
            className={`relative inline-flex shrink-0 ${className}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
        >
            {children ?? (
                <button
                    type="button"
                    aria-label={text}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    className={`w-4 h-4 rounded-full border text-[9px] font-bold leading-none flex items-center justify-center cursor-help transition-colors ${buttonTone}`}
                >
                    ?
                </button>
            )}
            {open && placement && createPortal(
                <span
                    role="tooltip"
                    style={{
                        left: placement.left,
                        width: placement.width,
                        top: placement.top,
                        bottom: placement.bottom,
                    }}
                    className={`pointer-events-none fixed z-[110] p-2.5 rounded-lg border bg-skin-text text-skin-surface text-[10px] leading-snug shadow-xl animate-in fade-in zoom-in-95 duration-150 ${panelTone}`}
                >
                    {/* Caret: ties the panel to its icon instead of leaving it floating. */}
                    <span
                        className={`absolute w-1.5 h-1.5 rotate-45 bg-skin-text ${
                            placement.top != null ? '-top-[3px]' : '-bottom-[3px]'
                        }`}
                        style={{ left: placement.caretLeft }}
                    />
                    {text}
                </span>,
                document.body,
            )}
        </span>
    );
};

export default HelpTip;
