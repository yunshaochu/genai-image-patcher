import React, { useState } from 'react';
import { AppConfig } from '../../types';
import { t } from '../../services/translations';

interface MangaToolsPanelProps {
    config: AppConfig;
    onChange: (key: keyof AppConfig, value: any) => void;
    onAutoDetect: (scope: 'current' | 'all') => void;
    isDetecting: boolean;
    /** Whether an image is selected — a boolean (not the image object) so the
     *  memo below survives the per-keystroke image replacement. */
    hasCurrentImage: boolean;
    detectScope: 'current' | 'all';
    setDetectScope: (scope: 'current' | 'all') => void;
}

const MangaToolsPanelInner: React.FC<MangaToolsPanelProps> = ({
    config,
    onChange,
    onAutoDetect,
    isDetecting,
    hasCurrentImage,
    detectScope,
    setDetectScope
}) => {
    const lang = config.language;
    const [showDetectTuning, setShowDetectTuning] = useState(false);
    const showDetection = config.enableBubbleDetection;
    const showOCR = config.enableOCR;
    const showEditor = config.enableManualEditor;

    return (
        <>
            {showDetection ? (
                <>
                    {/* Compact scope switch + detect trigger */}
                    <div className="flex items-stretch gap-1.5 mb-2">
                        <div className="flex bg-skin-fill p-0.5 rounded-md border border-skin-border">
                            <button
                                onClick={() => setDetectScope('current')}
                                className={`px-2 text-[10px] rounded transition-all ${detectScope === 'current' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                            >
                                {t(lang, 'detectScopeCurrent')}
                            </button>
                            <button
                                onClick={() => setDetectScope('all')}
                                className={`px-2 text-[10px] rounded transition-all ${detectScope === 'all' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                            >
                                {t(lang, 'detectScopeAll')}
                            </button>
                        </div>
                        <button
                            onClick={() => onAutoDetect(detectScope)}
                            disabled={isDetecting || (detectScope === 'current' && !hasCurrentImage)}
                            className="flex-1 py-1.5 text-xs font-bold bg-skin-primary text-white rounded-md shadow-sm transition-all active:scale-95 flex items-center justify-center gap-1.5 hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isDetecting ? (
                                <>
                                    <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                    {t(lang, 'detecting')}
                                </>
                            ) : (
                                <>
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                                    {t(lang, 'detectBtn')}
                                </>
                            )}
                        </button>
                    </div>

                    <button
                        onClick={() => setShowDetectTuning(!showDetectTuning)}
                        className="w-full text-[10px] text-skin-muted flex items-center justify-center gap-1 hover:text-skin-text mb-1.5"
                    >
                        {showDetectTuning ? '▼' : '▶'} {t(lang, 'detectAdvanced')}
                    </button>

                    {showDetectTuning && (
                        <div className="bg-skin-fill/30 p-2 rounded-lg border border-skin-border space-y-3 animate-in fade-in slide-in-from-top-1 mb-1.5">
                            <div>
                                <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                                    <span>{t(lang, 'detectInflation')}</span>
                                    <span className="font-mono text-skin-primary">{config.detectionInflationPercent > 0 ? '+' : ''}{config.detectionInflationPercent}%</span>
                                </div>
                                <input
                                    type="range" min="-20" max="100" step="5"
                                    value={config.detectionInflationPercent}
                                    onChange={(e) => onChange('detectionInflationPercent', Number(e.target.value))}
                                    className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                                        <span>Offset X</span>
                                        <span className="font-mono text-skin-primary">{config.detectionOffsetXPercent}%</span>
                                    </div>
                                    <input
                                        type="range" min="-50" max="50" step="5"
                                        value={config.detectionOffsetXPercent}
                                        onChange={(e) => onChange('detectionOffsetXPercent', Number(e.target.value))}
                                        className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                    />
                                </div>
                                <div>
                                    <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                                        <span>Offset Y</span>
                                        <span className="font-mono text-skin-primary">{config.detectionOffsetYPercent}%</span>
                                    </div>
                                    <input
                                        type="range" min="-50" max="50" step="5"
                                        value={config.detectionOffsetYPercent}
                                        onChange={(e) => onChange('detectionOffsetYPercent', Number(e.target.value))}
                                        className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                    />
                                </div>
                            </div>

                            <div>
                                <div className="flex justify-between text-[10px] text-skin-muted mb-1">
                                    <span>{t(lang, 'detectConfidence')}</span>
                                    <span className="font-mono text-skin-primary">{config.detectionConfidenceThreshold / 100}</span>
                                </div>
                                <input
                                    type="range" min="10" max="90" step="5"
                                    value={config.detectionConfidenceThreshold}
                                    onChange={(e) => onChange('detectionConfidenceThreshold', Number(e.target.value))}
                                    className="w-full h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                />
                            </div>
                        </div>
                    )}
                </>
            ) : (
                <div className="text-xs text-skin-muted italic text-center py-2">
                    Enable "Bubble Detection" in Global Settings to see tools.
                </div>
            )}

            {showOCR && (
                <div className="pt-2">
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'ocrApiLabel')}</label>
                    <input
                        type="text"
                        value={config.ocrApiUrl}
                        onChange={(e) => onChange('ocrApiUrl', e.target.value)}
                        className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                        placeholder="http://localhost:5000/ocr"
                    />
                </div>
            )}

            {(showDetection || showEditor) && (
                <div className="pt-2 border-t border-skin-border/50">
                    <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'pythonBackendLabel')}</label>
                    <input
                        type="text"
                        value={config.pythonBackendUrl}
                        onChange={(e) => onChange('pythonBackendUrl', e.target.value)}
                        className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                        placeholder="http://localhost:5001"
                    />
                    <p className="text-[9px] text-skin-muted mt-1 italic">{t(lang, 'pythonBackendTip')}</p>
                </div>
            )}
        </>
    );
};

/**
 * Memoized: the sidebar re-renders on every editor keystroke (the edited image
 * object changes, so Sidebar's own memo cannot hold), while this panel's own
 * props stay stable in that case - so it can skip those re-renders entirely.
 */
export const MangaToolsPanel = React.memo(MangaToolsPanelInner);