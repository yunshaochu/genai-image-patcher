
import React, { useEffect, useState } from 'react';
import { t, translations } from '../services/translations';
import { Language } from '../types';

type TKey = keyof typeof translations['en'];

/**
 * One row of the guide. Steps render a filled number badge, everything else
 * renders the emoji icon — that visual split is what makes the "flow" groups
 * read as a sequence and the "parts" groups read as a reference list.
 */
interface HelpItem {
    step?: number;
    icon?: string;
    titleKey: TKey;
    descKey: TKey;
}

interface HelpGroup {
    labelKey: TKey;
    items: HelpItem[];
}

interface HelpTopic {
    id: string;
    icon: string;
    labelKey: TKey;
    leadKey: TKey;
    groups: HelpGroup[];
}

/**
 * Only the two flows that exist as first-class workflows are documented here:
 * AI Redraw (mode 'api') and the Patch Workbench (mode 'manual'). The editor
 * and the manga toolbox are deliberately out of scope for this edition.
 */
const TOPICS: HelpTopic[] = [
    {
        id: 'api',
        icon: '🖌️',
        labelKey: 'help_tab_ai',
        leadKey: 'help_lead_ai',
        groups: [
            {
                labelKey: 'help_group_flow',
                items: [
                    { step: 1, titleKey: 'help_ai_1_title', descKey: 'help_ai_1_desc' },
                    { step: 2, titleKey: 'help_ai_2_title', descKey: 'help_ai_2_desc' },
                    { step: 3, titleKey: 'help_ai_3_title', descKey: 'help_ai_3_desc' },
                    { step: 4, titleKey: 'help_ai_4_title', descKey: 'help_ai_4_desc' },
                    { step: 5, titleKey: 'help_ai_5_title', descKey: 'help_ai_5_desc' },
                    { step: 6, titleKey: 'help_ai_6_title', descKey: 'help_ai_6_desc' },
                ],
            },
            {
                labelKey: 'help_group_quality',
                items: [
                    { icon: '🔲', titleKey: 'help_ai_7_title', descKey: 'help_ai_7_desc' },
                    { icon: '🔤', titleKey: 'help_ai_8_title', descKey: 'help_ai_8_desc' },
                    { icon: '🖼️', titleKey: 'help_ai_9_title', descKey: 'help_ai_9_desc' },
                    { icon: '🔄', titleKey: 'help_ai_10_title', descKey: 'help_ai_10_desc' },
                    { icon: '🗜️', titleKey: 'help_ai_11_title', descKey: 'help_ai_11_desc' },
                    { icon: '🛫', titleKey: 'help_ai_12_title', descKey: 'help_ai_12_desc' },
                    { icon: '⚡', titleKey: 'help_ai_13_title', descKey: 'help_ai_13_desc' },
                    { icon: '🔁', titleKey: 'help_ai_14_title', descKey: 'help_ai_14_desc' },
                ],
            },
            {
                labelKey: 'help_group_tips',
                items: [
                    { icon: '🎯', titleKey: 'help_ai_15_title', descKey: 'help_ai_15_desc' },
                    { icon: '📄', titleKey: 'help_ai_16_title', descKey: 'help_ai_16_desc' },
                    { icon: '🛡️', titleKey: 'help_ai_17_title', descKey: 'help_ai_17_desc' },
                ],
            },
        ],
    },
    {
        id: 'workbench',
        icon: '🧩',
        labelKey: 'help_tab_wb',
        leadKey: 'help_lead_wb',
        groups: [
            {
                labelKey: 'help_group_wbFlow',
                items: [
                    { step: 1, titleKey: 'help_wb_1_title', descKey: 'help_wb_1_desc' },
                    { step: 2, titleKey: 'help_wb_2_title', descKey: 'help_wb_2_desc' },
                    { step: 3, titleKey: 'help_wb_3_title', descKey: 'help_wb_3_desc' },
                    { step: 4, titleKey: 'help_wb_4_title', descKey: 'help_wb_4_desc' },
                    { step: 5, titleKey: 'help_wb_5_title', descKey: 'help_wb_5_desc' },
                ],
            },
            {
                labelKey: 'help_group_wbParts',
                items: [
                    { icon: '🖼️', titleKey: 'help_wb_6_title', descKey: 'help_wb_6_desc' },
                    { icon: '⌨️', titleKey: 'help_wb_7_title', descKey: 'help_wb_7_desc' },
                    { icon: '📝', titleKey: 'help_wb_8_title', descKey: 'help_wb_8_desc' },
                    { icon: '🎭', titleKey: 'help_wb_9_title', descKey: 'help_wb_9_desc' },
                    { icon: '🗂️', titleKey: 'help_wb_10_title', descKey: 'help_wb_10_desc' },
                    { icon: '🔲', titleKey: 'help_wb_11_title', descKey: 'help_wb_11_desc' },
                    { icon: '🔁', titleKey: 'help_wb_12_title', descKey: 'help_wb_12_desc' },
                    { icon: '🚫', titleKey: 'help_wb_14_title', descKey: 'help_wb_14_desc' },
                ],
            },
            {
                labelKey: 'help_group_tips',
                items: [
                    { icon: '🛠️', titleKey: 'help_wb_15_title', descKey: 'help_wb_15_desc' },
                    { icon: '⚠️', titleKey: 'help_wb_16_title', descKey: 'help_wb_16_desc' },
                    { icon: '🚀', titleKey: 'help_wb_17_title', descKey: 'help_wb_17_desc' },
                ],
            },
        ],
    },
];

interface HelpModalProps {
    onClose: () => void;
    language: Language;
}

const HelpModal: React.FC<HelpModalProps> = ({ onClose, language }) => {
    const [activeId, setActiveId] = useState(TOPICS[0].id);
    const active = TOPICS.find(topic => topic.id === activeId) ?? TOPICS[0];

    // Esc closes the sheet — the panel is tall enough that hunting for the
    // button is busywork.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                className="bg-skin-surface w-full max-w-4xl h-[min(660px,88vh)] rounded-2xl shadow-2xl flex border border-skin-border overflow-hidden animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Navigation rail — one card per workflow, never a tab strip:
                    both labels are long and read better stacked. */}
                <aside className="w-56 shrink-0 bg-skin-fill border-r border-skin-border flex flex-col">
                    <div className="px-5 pt-5 pb-4 border-b border-skin-border">
                        <div className="flex items-center gap-2">
                            <span className="w-6 h-6 rounded-lg bg-skin-primary text-skin-primary-fg text-[11px] font-black flex items-center justify-center">?</span>
                            <h3 className="font-bold text-sm text-skin-text truncate">{t(language, 'helpTitle')}</h3>
                        </div>
                        <p className="mt-2 text-[10px] leading-relaxed text-skin-muted">{t(language, 'helpSubtitle')}</p>
                    </div>
                    <nav className="flex-1 overflow-y-auto custom-scrollbar p-2.5 space-y-1">
                        {TOPICS.map(topic => {
                            const on = topic.id === active.id;
                            return (
                                <button
                                    key={topic.id}
                                    onClick={() => setActiveId(topic.id)}
                                    className={`w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-2.5 transition-all ${
                                        on
                                            ? 'bg-skin-surface shadow-sm ring-1 ring-skin-primary/30'
                                            : 'hover:bg-skin-surface/60'
                                    }`}
                                >
                                    <span className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm shrink-0 ${on ? 'bg-skin-primary/10' : 'bg-skin-surface/70'}`}>
                                        {topic.icon}
                                    </span>
                                    <span className={`text-xs font-bold truncate ${on ? 'text-skin-primary' : 'text-skin-text'}`}>
                                        {t(language, topic.labelKey)}
                                    </span>
                                </button>
                            );
                        })}
                    </nav>
                    <p className="px-4 py-3 border-t border-skin-border text-[10px] leading-relaxed text-skin-muted">
                        {t(language, 'helpMoreSoon')}
                    </p>
                </aside>

                {/* Content */}
                <section className="flex-1 min-w-0 flex flex-col bg-skin-surface">
                    <header className="px-7 pt-6 pb-4 border-b border-skin-border flex items-start gap-3">
                        <span className="w-9 h-9 rounded-xl bg-skin-primary/10 text-skin-primary text-base flex items-center justify-center shrink-0">
                            {active.icon}
                        </span>
                        <div className="min-w-0">
                            <h3 className="text-sm font-bold text-skin-text">{t(language, active.labelKey)}</h3>
                            <p className="mt-1 text-[11px] leading-relaxed text-skin-muted">{t(language, active.leadKey)}</p>
                        </div>
                        <button
                            onClick={onClose}
                            aria-label={t(language, 'close')}
                            className="ml-auto shrink-0 w-7 h-7 rounded-lg text-skin-muted hover:text-skin-text hover:bg-skin-fill flex items-center justify-center transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </header>

                    <div className="flex-1 overflow-y-auto custom-scrollbar px-7 py-5">
                        {active.groups.map(group => (
                            <div key={group.labelKey} className="mb-7 last:mb-1">
                                <h4 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-skin-muted">
                                    {t(language, group.labelKey)}
                                    <span className="flex-1 h-px bg-skin-border/60" />
                                </h4>
                                <div className="mt-3 space-y-2">
                                    {group.items.map(item => (
                                        <article
                                            key={item.titleKey}
                                            className="flex gap-3 rounded-xl border border-skin-border/60 bg-skin-fill/25 p-3 transition-colors hover:border-skin-primary/40 hover:bg-skin-fill/60"
                                        >
                                            <span className={`w-6 h-6 shrink-0 rounded-lg flex items-center justify-center text-xs leading-none font-bold ${
                                                item.step ? 'bg-skin-primary text-skin-primary-fg' : 'bg-skin-primary/10 text-skin-primary'
                                            }`}>
                                                {item.step ?? item.icon}
                                            </span>
                                            <div className="min-w-0">
                                                <h5 className="text-xs font-bold text-skin-text leading-snug">{t(language, item.titleKey)}</h5>
                                                <p className="mt-1 text-[11px] leading-relaxed text-skin-muted whitespace-pre-line">
                                                    {t(language, item.descKey)}
                                                </p>
                                            </div>
                                        </article>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>

                    <footer className="px-7 py-4 border-t border-skin-border bg-skin-fill/30 flex items-center justify-between gap-3">
                        <span className="text-[10px] text-skin-muted flex items-center gap-1.5">
                            <kbd className="px-1.5 py-0.5 rounded border border-skin-border bg-skin-surface font-mono text-[9px]">Esc</kbd>
                            {t(language, 'close')}
                        </span>
                        <button
                            onClick={onClose}
                            className="px-6 py-2 bg-skin-primary text-skin-primary-fg rounded-lg text-xs font-bold shadow hover:opacity-90 transition-all"
                        >
                            {t(language, 'close')}
                        </button>
                    </footer>
                </section>
            </div>
        </div>
    );
};

export default HelpModal;
