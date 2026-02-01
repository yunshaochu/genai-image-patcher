import React, { useState } from 'react';
import { AppConfig, UploadedImage } from '../../types';
import { t } from '../../services/translations';

interface MangaToolsPanelProps {
    config: AppConfig;
    onChange: (key: keyof AppConfig, value: any) => void;
    onAutoDetect: (scope: 'current' | 'all') => void;
    isDetecting: boolean;
    currentImage?: UploadedImage;
    detectScope: 'current' | 'all';
    setDetectScope: (scope: 'current' | 'all') => void;
}

export const MangaToolsPanel: React.FC<MangaToolsPanelProps> = ({
    config,
    onChange,
    onAutoDetect,
    isDetecting,
    currentImage,
    detectScope,
    setDetectScope
}) => {
    const lang = config.language;
    const [showDetectTuning, setShowDetectTuning] = useState(false);
    const showDetection = config.enableBubbleDetection;
    const showOCR = config.enableOCR;

    return (
        <>
            {showDetection ? (
                <>
                    <div className="flex gap-2 mb-2 bg-skin-fill p-1 rounded-lg border border-skin-border">
                        <button 
                            onClick={() => setDetectScope('current')}
                            className={`flex-1 py-1.5 text-[10px] rounded-md transition-all ${detectScope === 'current' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                        >
                            {t(lang, 'detectScopeCurrent')}
                        </button>
                        <button 
                            onClick={() => setDetectScope('all')}
                            className={`flex-1 py-1.5 text-[10px] rounded-md transition-all ${detectScope === 'all' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted hover:text-skin-text'}`}
                        >
                            {t(lang, 'detectScopeAll')}
                        </button>
                    </div>

                    <button
                        onClick={() => onAutoDetect(detectScope)}
                        disabled={isDetecting || (detectScope === 'current' && !currentImage)}
                        className="w-full py-2.5 bg-skin-primary text-white font-bold rounded-lg shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 mb-2 hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isDetecting ? (
                            <>
                                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                                {t(lang, 'detecting')}
                            </>
                        ) : (
                            <>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                                {t(lang, 'detectBtn')}
                            </>
                        )}
                    </button>
                    
                    <button 
                        onClick={() => setShowDetectTuning(!showDetectTuning)}
                        className="w-full text-[10px] text-skin-muted flex items-center justify-center gap-1 hover:text-skin-text mb-2"
                    >
                        {showDetectTuning ? '▼' : '▶'} {t(lang, 'detectAdvanced')}
                    </button>
                    
                    {showDetectTuning && (
                        <div className="bg-skin-fill/30 p-2 rounded-lg border border-skin-border space-y-3 animate-in fade-in slide-in-from-top-1">
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

                    <p className="text-[10px] text-skin-muted text-center mt-1 mb-2">{t(lang, 'detectTip')}</p>
                    
                    <div className="pt-2 border-t border-skin-border/50">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'detectApiLabel')}</label>
                        <input 
                            type="text" 
                            value={config.detectionApiUrl}
                            onChange={(e) => onChange('detectionApiUrl', e.target.value)}
                            className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                            placeholder="http://localhost:5000/detect"
                        />
                    </div>
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
        </>
    );
};
