
import React, { useState } from 'react';
import { t } from '../services/translations';
import { Language } from '../types';

interface HelpModalProps {
    onClose: () => void;
    language: Language;
}

const HelpModal: React.FC<HelpModalProps> = ({ onClose, language }) => {
    const [activeTab, setActiveTab] = useState<'basics' | 'manga' | 'pro' | 'editor' | 'tricks'>('basics');

    const tabs = [
        { id: 'basics', label: t(language, 'help_tab_basics'), icon: '🚀' },
        { id: 'manga', label: t(language, 'help_tab_manga'), icon: '📖' },
        { id: 'pro', label: t(language, 'help_tab_pro'), icon: '⚡' },
        { id: 'editor', label: t(language, 'help_tab_editor'), icon: '🎨' },
        { id: 'tricks', label: t(language, 'help_tab_tricks'), icon: '🧙‍♂️' },
    ] as const;

    const renderSection = (titleKey: any, descKey: any) => (
        <div className="mb-6 last:mb-0">
            <h4 className="text-sm font-bold text-skin-text mb-1 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-skin-primary"></span>
                {t(language, titleKey)}
            </h4>
            <p className="text-xs text-skin-muted leading-relaxed pl-3.5 border-l border-skin-border/50">
                {t(language, descKey)}
            </p>
        </div>
    );

    return (
        <div className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div className="bg-skin-surface w-full max-w-2xl h-[500px] rounded-2xl shadow-2xl flex border border-skin-border overflow-hidden">
                {/* Sidebar */}
                <div className="w-48 bg-skin-fill border-r border-skin-border flex flex-col">
                    <div className="p-4 border-b border-skin-border">
                        <h3 className="font-bold text-skin-text">{t(language, 'helpTitle')}</h3>
                    </div>
                    <div className="flex-1 overflow-y-auto py-2">
                        {tabs.map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id)}
                                className={`w-full text-left px-4 py-3 text-xs font-medium flex items-center gap-3 transition-all ${
                                    activeTab === tab.id 
                                        ? 'bg-skin-surface text-skin-primary border-l-4 border-skin-primary shadow-sm' 
                                        : 'text-skin-muted hover:bg-skin-surface/50 hover:text-skin-text border-l-4 border-transparent'
                                }`}
                            >
                                <span className="text-sm">{tab.icon}</span>
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col bg-skin-surface">
                    <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                        {activeTab === 'basics' && (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                                {renderSection('help_basics_1_title', 'help_basics_1_desc')}
                                {renderSection('help_basics_2_title', 'help_basics_2_desc')}
                                {renderSection('help_basics_3_title', 'help_basics_3_desc')}
                                {renderSection('help_basics_4_title', 'help_basics_4_desc')}
                            </div>
                        )}
                        {activeTab === 'manga' && (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                                {renderSection('help_manga_1_title', 'help_manga_1_desc')}
                                {renderSection('help_manga_2_title', 'help_manga_2_desc')}
                                {renderSection('help_manga_3_title', 'help_manga_3_desc')}
                            </div>
                        )}
                        {activeTab === 'pro' && (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                                {renderSection('help_pro_1_title', 'help_pro_1_desc')}
                                {renderSection('help_pro_2_title', 'help_pro_2_desc')}
                                {renderSection('help_pro_3_title', 'help_pro_3_desc')}
                            </div>
                        )}
                        {activeTab === 'editor' && (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                                {renderSection('help_editor_1_title', 'help_editor_1_desc')}
                                {renderSection('help_editor_2_title', 'help_editor_2_desc')}
                                {renderSection('help_editor_3_title', 'help_editor_3_desc')}
                            </div>
                        )}
                        {activeTab === 'tricks' && (
                            <div className="animate-in fade-in slide-in-from-right-4 duration-300">
                                {renderSection('help_tricks_1_title', 'help_tricks_1_desc')}
                                {renderSection('help_tricks_2_title', 'help_tricks_2_desc')}
                                {renderSection('help_tricks_3_title', 'help_tricks_3_desc')}
                                {renderSection('help_tricks_4_title', 'help_tricks_4_desc')}
                            </div>
                        )}
                    </div>
                    <div className="p-4 border-t border-skin-border bg-skin-fill/30 flex justify-end">
                        <button 
                            onClick={onClose}
                            className="px-6 py-2 bg-skin-primary text-skin-primary-fg rounded-lg text-xs font-bold shadow hover:opacity-90 transition-all"
                        >
                            {t(language, 'close')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default HelpModal;
