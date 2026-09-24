import React from 'react';
import { HelpTip } from './HelpTip';

interface SettingsCardProps {
    title: string;
    /** Status readout pinned next to the title (current value / on-off state). */
    summary?: React.ReactNode;
    /** Colours the summary chip as "active". Default 'off'. */
    summaryTone?: 'on' | 'off';
    /** Long explanation behind the ? affordance. */
    help?: string;
    /** Control pinned to the header's right edge — normally the on/off switch,
     *  so flipping a mode never requires opening anything. */
    action?: React.ReactNode;
    /** Always-visible callout under the header (warnings). */
    alert?: React.ReactNode;
    /** Card body — rendered as a stack of rows. */
    children?: React.ReactNode;
}

/**
 * One block of settings, as a self-contained card: header (title + state chip +
 * ? tip + live control) over a body.
 *
 * Deliberately NOT collapsible: the settings are split across tabs (one tab per
 * module), which already keeps each screen short — stacking a disclosure on top
 * of that would make every change a two-click affair for no gain.
 */
export const SettingsCard: React.FC<SettingsCardProps> = ({
    title,
    summary,
    summaryTone = 'off',
    help,
    action,
    alert,
    children,
}) => {
    const chipTone = summaryTone === 'on'
        ? 'border-skin-primary/40 bg-skin-primary/10 text-skin-primary'
        : 'border-skin-border text-skin-muted';

    return (
        <section className="rounded-xl border border-skin-border bg-skin-surface p-3">
            <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-skin-text">{title}</span>
                {summary != null && (
                    <span className={`inline-flex items-center gap-1 shrink-0 text-[9px] px-1.5 py-px rounded-full border ${chipTone}`}>
                        {summary}
                    </span>
                )}
                <div className="ml-auto shrink-0 flex items-center gap-2">
                    {help && <HelpTip text={help} />}
                    {action}
                </div>
            </div>

            {alert && <div className="mt-3">{alert}</div>}

            {children && <div className="mt-3 space-y-3">{children}</div>}
        </section>
    );
};

export default SettingsCard;
