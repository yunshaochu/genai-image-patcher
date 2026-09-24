import React, { useEffect, useState } from 'react';
import { Language } from '../types';
import { t } from '../services/translations';
import {
    PayloadRecord,
    PayloadTransform,
    clearPayloadLog,
    getPayloadRecords,
    subscribePayloadLog,
} from '../services/payloadLog';

/**
 * 「发送记录」— what was actually uploaded, as opposed to what the canvas shows.
 *
 * Read-only by design: the payload log is diagnostics, so this has no export,
 * no persistence and no controls beyond "clear". It answers the question the
 * app previously could not ("the AI saw what, exactly?"), which matters most
 * when a result comes back wrong — a masked page, a padded square or a plain
 * crop all look nothing like the canvas.
 */

const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};

const formatTime = (at: number): string => new Date(at).toLocaleTimeString();

const transformLabel = (lang: Language, transform: PayloadTransform): string => {
    switch (transform) {
        case 'crop': return t(lang, 'payloadTrCrop');
        case 'full-page': return t(lang, 'payloadTrFullPage');
        case 'mask': return t(lang, 'payloadTrMask');
        case 'inverted-mask': return t(lang, 'payloadTrInvertedMask');
        case 'context': return t(lang, 'payloadTrContext');
        case 'square-fill': return t(lang, 'payloadTrSquareFill');
        case 'compress': return t(lang, 'payloadTrCompress');
        case 'annotate': return t(lang, 'payloadTrAnnotate');
        default: return transform;
    }
};

const phaseLabel = (lang: Language, record: PayloadRecord): string => {
    switch (record.phase) {
        case 'redraw': return t(lang, 'payloadPhaseRedraw');
        case 'translate': return t(lang, 'payloadPhaseTranslate');
        case 'editorTranslate': return t(lang, 'payloadPhaseEditor');
        default: return record.phase;
    }
};

const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex gap-3 text-[11px] leading-snug">
        <span className="w-16 shrink-0 text-skin-muted">{label}</span>
        <span className="flex-1 min-w-0 text-skin-text">{children}</span>
    </div>
);

const PayloadInspector: React.FC<{ language: Language; onClose: () => void }> = ({ language, onClose }) => {
    const [records, setRecords] = useState<PayloadRecord[]>(getPayloadRecords);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [size, setSize] = useState<{ w: number; h: number } | null>(null);

    useEffect(() => subscribePayloadLog(() => setRecords(getPayloadRecords())), []);

    const selected = records.find(r => r.id === selectedId) ?? records[0] ?? null;

    // Pixel size is read off the rendered image instead of decoding the blob a
    // second time just to measure it.
    useEffect(() => { setSize(null); }, [selected?.id]);

    return (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-skin-surface w-full max-w-3xl rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
                <div className="p-4 border-b border-skin-border flex justify-between items-center">
                    <h3 className="font-bold text-lg">{t(language, 'payloadInspector')}</h3>
                    <button onClick={onClose} className="p-1 hover:bg-skin-fill rounded">✕</button>
                </div>

                {records.length === 0 ? (
                    <div className="p-10 text-center text-xs text-skin-muted leading-relaxed">
                        {t(language, 'payloadInspectorEmpty')}
                    </div>
                ) : (
                    <div className="flex max-h-[65vh] min-h-[320px]">
                        {/* Record list */}
                        <div className="w-56 shrink-0 border-r border-skin-border overflow-y-auto custom-scrollbar">
                            {records.map(record => {
                                const active = selected?.id === record.id;
                                return (
                                    <button
                                        key={record.id}
                                        onClick={() => setSelectedId(record.id)}
                                        className={`w-full text-left px-3 py-2 border-b border-skin-border/60 transition-colors ${
                                            active ? 'bg-skin-primary/10' : 'hover:bg-skin-fill'
                                        }`}
                                    >
                                        <div className="flex items-center gap-1.5">
                                            <span className={`text-[11px] font-bold ${active ? 'text-skin-primary' : 'text-skin-text'}`}>
                                                {phaseLabel(language, record)}
                                            </span>
                                            <span className="ml-auto text-[9px] text-skin-muted font-mono">{formatTime(record.at)}</span>
                                        </div>
                                        <div className="text-[9px] text-skin-muted truncate mt-0.5">
                                            {record.imageName || '—'}
                                        </div>
                                        <div className="text-[9px] text-skin-muted truncate">
                                            {formatBytes(record.bytes)} · {record.transforms.map(tr => transformLabel(language, tr)).join(' → ')}
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Detail */}
                        {selected && (
                            <div className="flex-1 min-w-0 p-4 overflow-y-auto custom-scrollbar space-y-3">
                                <div className="rounded-lg border border-skin-border bg-skin-fill/30 p-2 flex items-center justify-center">
                                    <img
                                        src={selected.imageUrl}
                                        alt={t(language, 'payloadInspector')}
                                        onLoad={(e) => setSize({
                                            w: e.currentTarget.naturalWidth,
                                            h: e.currentTarget.naturalHeight,
                                        })}
                                        className="max-h-[38vh] max-w-full object-contain rounded"
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <MetaRow label={t(language, 'payloadCoverage')}>
                                        {selected.imageName || '—'}
                                        {selected.regionIds.length > 0
                                            ? ` · ${t(language, 'payloadRegionCount', { count: selected.regionIds.length })}`
                                            : ` · ${t(language, 'payloadWholePage')}`}
                                    </MetaRow>
                                    <MetaRow label={t(language, 'payloadTransforms')}>
                                        {selected.transforms.map(tr => transformLabel(language, tr)).join(' → ')}
                                    </MetaRow>
                                    <MetaRow label={t(language, 'payloadSize')}>
                                        {formatBytes(selected.bytes)}
                                        {size ? ` · ${size.w}×${size.h}` : ''}
                                        {selected.compressionTargetKB
                                            ? ` · ${t(language, 'payloadCompressTarget', { kb: selected.compressionTargetKB })}`
                                            : ''}
                                    </MetaRow>
                                    <MetaRow label={t(language, 'payloadModel')}>{selected.model || '—'}</MetaRow>
                                </div>

                                {selected.extra && (
                                    <div>
                                        <div className="text-[10px] text-skin-muted mb-1">
                                            {t(language, 'payloadExtra')}：{selected.extra.label} · {formatBytes(selected.extra.bytes)}
                                        </div>
                                        <div className="rounded-lg border border-skin-border bg-skin-fill/30 p-2 flex items-center justify-center">
                                            <img src={selected.extra.url} alt={selected.extra.label} className="max-h-[24vh] max-w-full object-contain rounded" />
                                        </div>
                                    </div>
                                )}

                                <div>
                                    <div className="text-[10px] text-skin-muted mb-1">{t(language, 'payloadPrompt')}</div>
                                    <pre className="w-full max-h-32 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words p-2 rounded-lg border border-skin-border bg-skin-fill/30 text-[10px] leading-snug text-skin-text font-mono">
                                        {selected.prompt || '—'}
                                    </pre>
                                </div>

                                <a
                                    href={selected.imageUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-block text-[10px] text-skin-primary hover:underline"
                                >
                                    {t(language, 'payloadOpenInTab')}
                                </a>
                            </div>
                        )}
                    </div>
                )}

                <div className="p-4 border-t border-skin-border bg-skin-fill/30 flex items-center gap-2">
                    <p className="flex-1 text-[9px] text-skin-muted leading-snug">{t(language, 'payloadInspectorDesc')}</p>
                    <button
                        onClick={() => { clearPayloadLog(); setSelectedId(null); }}
                        disabled={records.length === 0}
                        className="px-3 py-1.5 text-[11px] rounded-lg border border-skin-border text-skin-muted hover:text-rose-500 hover:border-rose-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {t(language, 'payloadClear')}
                    </button>
                    <button onClick={onClose} className="px-4 py-1.5 text-[11px] rounded-lg bg-skin-primary text-skin-primary-fg font-bold">
                        {t(language, 'close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PayloadInspector;
