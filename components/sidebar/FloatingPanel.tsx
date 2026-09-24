import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Dropdown / popover rendered into `document.body` with `position: fixed`
 * instead of as an absolutely-positioned child of its trigger.
 *
 * Why: every panel these live in is a scroll container, and a scroll container
 * clips BOTH axes — `overflow-y: auto` forces `overflow-x` to `auto` too, so a
 * `top-full left-0 right-0` dropdown is cut off at the container's bottom edge
 * as soon as its trigger sits near it. Portalling to body escapes every
 * clipper, and because body carries no transform/filter, `fixed` really is
 * viewport-relative.
 *
 * The panel matches its trigger's width, keeps an 8px margin against the
 * viewport edges, flips above the trigger when there is no room below, and
 * caps its own height to the space actually available (so it scrolls instead
 * of overflowing).
 *
 * It also swallows `mousedown`: the panel is no longer a DOM descendant of the
 * trigger, so a document-level "click outside" handler would treat clicks on
 * its items as outside clicks and close it before the click could land.
 */

const EDGE_PX = 8;
const GAP_PX = 6;
/** Prefer flipping sides when the preferred one has less room than this. */
const MIN_PREFERRED_SPACE_PX = 140;
/** Never squeeze the panel below this, even when space is tight. */
const MIN_HEIGHT_PX = 72;

export const useFloatingPlacement = (
    anchorRef: { readonly current: HTMLElement | null },
    open: boolean,
    options: { maxHeight?: number; alignRight?: boolean } = {},
): React.CSSProperties | null => {
    const { maxHeight = 240, alignRight = false } = options;
    const [style, setStyle] = useState<React.CSSProperties | null>(null);

    const place = useCallback(() => {
        const el = anchorRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        const width = Math.min(rect.width, vw - EDGE_PX * 2);
        const preferredLeft = alignRight ? rect.right - width : rect.left;
        const left = Math.max(EDGE_PX, Math.min(preferredLeft, vw - width - EDGE_PX));

        const spaceBelow = vh - rect.bottom - GAP_PX - EDGE_PX;
        const spaceAbove = rect.top - GAP_PX - EDGE_PX;
        const opensBelow = spaceBelow >= MIN_PREFERRED_SPACE_PX || spaceBelow >= spaceAbove;
        const available = Math.max(MIN_HEIGHT_PX, opensBelow ? spaceBelow : spaceAbove);

        setStyle({
            left,
            width,
            maxHeight: Math.min(maxHeight, available),
            ...(opensBelow ? { top: rect.bottom + GAP_PX } : { bottom: vh - rect.top + GAP_PX }),
        });
    }, [anchorRef, alignRight, maxHeight]);

    // Measure before the panel's first paint so it never flashes at 0,0.
    useLayoutEffect(() => {
        if (open) place();
    }, [open, place]);

    // While open, follow the trigger: any scroll of ANY container moves it
    // (scroll does not bubble, hence the capture-phase listener).
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

    return open ? style : null;
};

export const FloatingPanel: React.FC<{
    open: boolean;
    /** The element the panel is anchored to (usually its input / row wrapper). */
    anchorRef: { readonly current: HTMLElement | null };
    /** Panel height cap before it starts scrolling. */
    maxHeight?: number;
    /** Align to the anchor's right edge instead of its left. */
    alignRight?: boolean;
    className?: string;
    role?: string;
    children: React.ReactNode;
}> = ({ open, anchorRef, maxHeight, alignRight, className = '', role, children }) => {
    const style = useFloatingPlacement(anchorRef, open, { maxHeight, alignRight });
    if (!style) return null;

    return createPortal(
        <div
            role={role}
            style={style}
            onMouseDown={(e) => e.stopPropagation()}
            className={`fixed z-[110] ${className}`}
        >
            {children}
        </div>,
        document.body,
    );
};

export default FloatingPanel;
