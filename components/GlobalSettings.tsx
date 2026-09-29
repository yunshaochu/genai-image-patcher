import React, { useEffect, useRef, useState } from 'react';
import { AppConfig, Language, ThemeType } from '../types';
import { t } from '../services/translations';
import { countGlossaryEntries } from '../services/glossary';
import { downloadConfigExport, readConfigExport } from '../services/configTransfer';
import { HelpTip } from './sidebar/HelpTip';
import { ApiProfileSwitcher } from './sidebar/ApiProfileSwitcher';
import { SecretInput } from './sidebar/SecretInput';
import { SettingsCard } from './sidebar/SettingsCard';
import { FloatingPanel } from './sidebar/FloatingPanel';
import { EDITOR_FONTS, SYSTEM_FONT_ID } from '../services/fontService';
import {
    TRANSLATION_MODE_IMAGE_PROMPT,
    DEFAULT_TRANSLATION_PROMPT,
    TRANSLATION_CONTEXT_SYSTEM_PROMPT,
    createDefaultConfig,
} from '../hooks/useConfig';

/**
 * Global settings, laid out as one tab per module on a full page width.
 *
 * Before: a 384px column of seven stacked blocks — three screens tall with the
 * translation module open, and the state of every mode had to be read by
 * scrolling past it. Now the modules live behind tabs (常规 / 漫画与重绘 /
 * 翻译 / 数据管理) and each tab lays its cards out in two columns, so a whole
 * module fits on one screen and nothing has to be collapsed to stay short.
 *
 * The tab is remembered across openings: people come back to the same module.
 */

const TAB_STORAGE_KEY = 'genai_patcher_global_settings_tab_v1';

type SettingsTab = 'general' | 'manga' | 'translation' | 'data';

const THEMES: { id: ThemeType; label: string; bg: string }[] = [
    { id: 'light', label: 'Light', bg: 'bg-slate-100' },
    { id: 'dark', label: 'Dark', bg: 'bg-zinc-800' },
    { id: 'ocean', label: 'Blue', bg: 'bg-sky-400' },
    { id: 'rose', label: 'Rose', bg: 'bg-rose-400' },
    { id: 'forest', label: 'Green', bg: 'bg-emerald-400' },
];

/** Endonyms — deliberately not translated. */
const LANGUAGES: { id: Language; label: string }[] = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
];

const Toggle: React.FC<{ checked: boolean; onChange: (value: boolean) => void; size?: 'md' | 'sm' }> = ({
    checked,
    onChange,
    size = 'md',
}) => (
    <label className="relative inline-flex items-center cursor-pointer">
        <input
            type="checkbox"
            className="sr-only peer"
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
        />
        <div
            className={`bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:transition-all peer-checked:bg-skin-primary ${
                size === 'md' ? 'w-11 h-6 after:h-5 after:w-5' : 'w-9 h-5 after:h-4 after:w-4'
            }`}
        />
    </label>
);

/** A subordinate row (label + optional description/help on the left, a control
 *  on the right). */
const SubRow: React.FC<{
    title: React.ReactNode;
    desc?: string;
    help?: string;
    control?: React.ReactNode;
}> = ({ title, desc, help, control }) => (
    <div className="flex items-center justify-between gap-2">
        <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-skin-text">{title}</span>
                {help && <HelpTip text={help} />}
            </div>
            {desc && <div className="text-[10px] text-skin-muted">{desc}</div>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
    </div>
);

/** Greys out a card body whose master switch is off — the options stay visible
 *  (so you can see what turning it on buys) without being clickable. */
const OffDim: React.FC<{ off: boolean; children: React.ReactNode }> = ({ off, children }) => (
    <div className={`space-y-3 ${off ? 'opacity-40 pointer-events-none select-none' : ''}`}>{children}</div>
);

interface GlobalSettingsProps {
    config: AppConfig;
    setConfig: React.Dispatch<React.SetStateAction<AppConfig>>;
    updateConfig: (key: keyof AppConfig, value: any) => void;
    transModels: string[];
    setTransModels: React.Dispatch<React.SetStateAction<string[]>>;
    fetchTransModels: () => Promise<void> | void;
    onClose: () => void;
}

const GlobalSettings: React.FC<GlobalSettingsProps> = ({
    config,
    setConfig,
    updateConfig,
    transModels,
    setTransModels,
    fetchTransModels,
    onClose,
}) => {
    const lang = config.language;

    const [tab, setTab] = useState<SettingsTab>(() => {
        try {
            const saved = localStorage.getItem(TAB_STORAGE_KEY);
            return saved === 'manga' || saved === 'translation' || saved === 'data' ? saved : 'general';
        } catch { return 'general'; }
    });
    useEffect(() => {
        try { localStorage.setItem(TAB_STORAGE_KEY, tab); } catch { /* ignore */ }
    }, [tab]);

    // Two-step destructive action (same pattern as the gallery's clear button).
    const [glossaryClearArmed, setGlossaryClearArmed] = useState(false);
    const glossaryCount = countGlossaryEntries(config.glossaryText);

    // --- Config backup (export / import / reset) ---
    const [importArmed, setImportArmed] = useState(false);
    const [initArmed, setInitArmed] = useState(false);
    const [backupStatus, setBackupStatus] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
    const configFileRef = useRef<HTMLInputElement>(null);
    const transModelAnchorRef = useRef<HTMLDivElement>(null);

    const handleExportConfig = () => {
        try {
            downloadConfigExport(config);
            setBackupStatus({ text: t(lang, 'configExported'), tone: 'ok' });
        } catch (e: any) {
            setBackupStatus({
                text: t(lang, 'configExportFailed', { reason: e?.message || '' }),
                tone: 'warn',
            });
        }
    };

    // Import replaces the whole config, so it is armed first (same two-step
    // pattern as the glossary clear) and only then opens the file picker.
    const handleImportClick = () => {
        if (!importArmed) {
            setBackupStatus({ text: t(lang, 'configImportArmHint'), tone: 'warn' });
            setImportArmed(true);
            window.setTimeout(() => setImportArmed(false), 4000);
            return;
        }
        setImportArmed(false);
        setBackupStatus(null);
        configFileRef.current?.click();
    };

    // Factory reset. Two-step like the rest: it wipes keys, prompts, glossary
    // and presets, so the first click only explains what is about to happen.
    // The gallery / editing session lives in IndexedDB and is left alone.
    const handleInitialize = () => {
        if (!initArmed) {
            setBackupStatus({ text: t(lang, 'configInitArmHint'), tone: 'warn' });
            setInitArmed(true);
            window.setTimeout(() => setInitArmed(false), 4000);
            return;
        }
        setInitArmed(false);
        setConfig(createDefaultConfig());
        setBackupStatus({ text: t(lang, 'configInitialized'), tone: 'ok' });
    };

    const handleConfigFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // let the same file be picked again after a failure
        if (!file) return;

        const outcome = readConfigExport(await file.text(), config);
        if (outcome.status === 'error') {
            const errorKey = outcome.error === 'invalid-json'
                ? 'configErrInvalidJson'
                : outcome.error === 'not-an-object'
                    ? 'configErrNotObject'
                    : 'configErrNoKeys';
            setBackupStatus({ text: t(lang, errorKey), tone: 'warn' });
            return;
        }
        setConfig(outcome.result.config);
        setBackupStatus({
            text: t(lang, 'configImported', { count: outcome.result.appliedCount }),
            tone: 'ok',
        });
    };

    // --- Header readouts ---
    const themeMeta = THEMES.find(th => th.id === config.theme) ?? THEMES[0];
    const langLabel = LANGUAGES.find(l => l.id === lang)?.label ?? lang;

    const translationProfile = (config.translationApiProfiles || [])
        .find(p => p.id === config.activeTranslationApiProfileId);
    const translationApiReady = !!config.translationBaseUrl && !!config.translationApiKey;
    const translationApiSummary = translationProfile
        ? translationProfile.name
        : (config.translationModel || t(lang, 'stateNotSet'));

    const tabs: { id: SettingsTab; label: string }[] = [
        { id: 'general', label: t(lang, 'groupGeneral') },
        { id: 'manga', label: t(lang, 'groupManga') },
        { id: 'translation', label: t(lang, 'groupTranslation') },
        { id: 'data', label: t(lang, 'groupData') },
    ];

    return (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-skin-surface max-w-sm w-full rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
                <div className="p-4 border-b border-skin-border flex justify-between items-center">
                    <h3 className="font-bold text-lg">{t(lang, 'globalSettings')}</h3>
                    <button onClick={onClose} className="p-1 hover:bg-skin-fill rounded">✕</button>
                </div>

                {/* Tabs */}
                <div className="px-5 border-b border-skin-border flex gap-1 shrink-0">
                    {tabs.map(item => (
                        <button
                            key={item.id}
                            onClick={() => setTab(item.id)}
                            aria-current={tab === item.id}
                            className={`px-3 py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                                tab === item.id
                                    ? 'border-skin-primary text-skin-primary'
                                    : 'border-transparent text-skin-muted hover:text-skin-text'
                            }`}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>

                <div className="p-5 max-h-[75vh] overflow-y-auto custom-scrollbar">
                    <div className="space-y-4">
                        {/* ---------------- 常规 ---------------- */}
                        {tab === 'general' && (
                            <>
                                <SettingsCard
                                    title={t(lang, 'performanceMode')}
                                    help={t(lang, 'performanceModeDesc')}
                                    summary={config.performanceMode === 'unlimited'
                                        ? t(lang, 'perfUnlimited')
                                        : t(lang, 'perfBalanced')}
                                    summaryTone="on"
                                >
                                    <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
                                        <button
                                            onClick={() => updateConfig('performanceMode', 'unlimited')}
                                            className={`flex-1 py-1.5 text-[10px] rounded-md transition-all font-medium ${config.performanceMode === 'unlimited' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted hover:text-skin-text'}`}
                                        >
                                            {t(lang, 'perfUnlimited')}
                                        </button>
                                        <button
                                            onClick={() => updateConfig('performanceMode', 'balanced')}
                                            className={`flex-1 py-1.5 text-[10px] rounded-md transition-all font-medium ${config.performanceMode === 'balanced' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted hover:text-skin-text'}`}
                                        >
                                            {t(lang, 'perfBalanced')}
                                        </button>
                                    </div>
                                    {/* Without this line the two options read as
                                        synonyms — both are "a mode", neither says
                                        what it does. */}
                                    <p className="text-[10px] text-skin-muted leading-snug">{t(lang, 'performanceModeHint')}</p>
                                </SettingsCard>

                                <SettingsCard
                                    title={t(lang, 'sessionPersistence')}
                                    help={t(lang, 'sessionPersistenceDesc')}
                                    action={
                                        <Toggle
                                            checked={config.enableSessionPersistence}
                                            onChange={(v) => updateConfig('enableSessionPersistence', v)}
                                        />
                                    }
                                    alert={!config.enableSessionPersistence ? (
                                        <div className="p-3 rounded-lg border border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px] leading-snug">
                                            ⚠️ {t(lang, 'sessionPersistenceOffWarning')}
                                        </div>
                                    ) : null}
                                />

                                {/* 开关原先只在「AI 重绘」的「处理选项」里，而错误历史
                                    只渲染在「手动修补工坊」那一行 —— 两个模式互相够不着。
                                    放进全局设置，任何工作流都能开。 */}
                                <SettingsCard
                                    title={t(lang, 'showRetryDiagnostics')}
                                    help={t(lang, 'showRetryDiagnosticsDesc')}
                                    action={
                                        <Toggle
                                            checked={!!config.showRetryDiagnostics}
                                            onChange={(v) => updateConfig('showRetryDiagnostics', v)}
                                        />
                                    }
                                />

                                <SettingsCard
                                    title={t(lang, 'appearance')}
                                    summary={<><span className={`w-2 h-2 rounded-full ${themeMeta.bg}`} />{langLabel}</>}
                                    summaryTone="on"
                                >
                                    <SubRow
                                        title={t(lang, 'themeStyle')}
                                        control={
                                            <div className="flex items-center gap-2.5">
                                                {THEMES.map(theme => (
                                                    <button
                                                        key={theme.id}
                                                        type="button"
                                                        onClick={() => updateConfig('theme', theme.id)}
                                                        className={`w-5 h-5 rounded-full ${theme.bg} border-2 border-transparent transition-all duration-200 ${
                                                            config.theme === theme.id
                                                                ? 'ring-2 ring-skin-text scale-110 border-white shadow-md'
                                                                : 'hover:scale-110 hover:border-skin-border opacity-70 hover:opacity-100'
                                                        }`}
                                                        title={theme.label}
                                                        aria-label={theme.label}
                                                    />
                                                ))}
                                            </div>
                                        }
                                    />
                                    <SubRow
                                        title={t(lang, 'interfaceLanguage')}
                                        control={
                                            <div className="flex bg-skin-fill p-0.5 rounded-lg border border-skin-border">
                                                {LANGUAGES.map(item => (
                                                    <button
                                                        key={item.id}
                                                        type="button"
                                                        onClick={() => updateConfig('language', item.id)}
                                                        className={`px-2 py-1 text-[10px] rounded-md transition-all font-medium ${lang === item.id ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted hover:text-skin-text'}`}
                                                    >
                                                        {item.label}
                                                    </button>
                                                ))}
                                            </div>
                                        }
                                    />
                                </SettingsCard>
                            </>
                        )}

                        {/* ---------------- 漫画与重绘 ---------------- */}
                        {tab === 'manga' && (
                            <>
                                <SettingsCard
                                    title={t(lang, 'enableMangaMode')}
                                    help={t(lang, 'enableMangaModeDesc')}
                                    action={
                                        <Toggle
                                            checked={config.enableMangaMode}
                                            onChange={(v) => updateConfig('enableMangaMode', v)}
                                        />
                                    }
                                >
                                    <OffDim off={!config.enableMangaMode}>
                                        <SubRow
                                            title={t(lang, 'enableBubbleDetection')}
                                            desc={t(lang, 'enableBubbleDetectionDesc')}
                                            control={<Toggle size="sm" checked={config.enableBubbleDetection} onChange={(v) => updateConfig('enableBubbleDetection', v)} />}
                                        />
                                        <SubRow
                                            title={t(lang, 'enableOCR')}
                                            desc={t(lang, 'enableOCRDesc')}
                                            control={<Toggle size="sm" checked={config.enableOCR} onChange={(v) => updateConfig('enableOCR', v)} />}
                                        />
                                        <SubRow
                                            title={t(lang, 'enableManualEditor')}
                                            help={t(lang, 'enableManualEditorDesc')}
                                            control={<Toggle size="sm" checked={config.enableManualEditor} onChange={(v) => updateConfig('enableManualEditor', v)} />}
                                        />
                                        {config.enableManualEditor && (
                                            <SubRow
                                                title={t(lang, 'enableVerticalTextDefault')}
                                                desc={t(lang, 'enableVerticalTextDefaultDesc')}
                                                control={<Toggle size="sm" checked={config.enableVerticalTextDefault} onChange={(v) => updateConfig('enableVerticalTextDefault', v)} />}
                                            />
                                        )}
                                        {config.enableManualEditor && (
                                            <SubRow
                                                title={t(lang, 'editorFontGlobal')}
                                                help={t(lang, 'editorFontGlobalDesc')}
                                                control={
                                                    <select
                                                        value={config.editorFontFamily}
                                                        onChange={(e) => updateConfig('editorFontFamily', e.target.value)}
                                                        className="px-2 py-1 text-[10px] border border-skin-border rounded bg-skin-surface text-skin-text max-w-[170px]"
                                                    >
                                                        <option value={SYSTEM_FONT_ID}>{t(lang, 'editorFontSystem')}</option>
                                                        {EDITOR_FONTS.map(f => (
                                                            <option key={f.id} value={f.id}>{f.label[lang]}</option>
                                                        ))}
                                                    </select>
                                                }
                                            />
                                        )}
                                        {config.enableManualEditor && (
                                            <SubRow
                                                title={t(lang, 'editorAutoTextColor')}
                                                help={t(lang, 'editorAutoTextColorDesc')}
                                                control={<Toggle size="sm" checked={config.editorAutoTextColor} onChange={(v) => updateConfig('editorAutoTextColor', v)} />}
                                            />
                                        )}
                                    </OffDim>
                                </SettingsCard>

                                <SettingsCard
                                    title={t(lang, 'useFullImageMasking')}
                                    help={t(lang, 'useFullImageMaskingDesc')}
                                    summary={config.useFullImageMasking && config.useInvertedMasking
                                        ? t(lang, 'stateInverted')
                                        : undefined}
                                    summaryTone="on"
                                    action={
                                        <Toggle
                                            checked={config.useFullImageMasking}
                                            onChange={(v) => updateConfig('useFullImageMasking', v)}
                                        />
                                    }
                                >
                                    <OffDim off={!config.useFullImageMasking}>
                                        <SubRow
                                            title={t(lang, 'useInvertedMasking')}
                                            help={t(lang, 'useInvertedMaskingDesc')}
                                            control={<Toggle size="sm" checked={config.useInvertedMasking} onChange={(v) => updateConfig('useInvertedMasking', v)} />}
                                        />
                                        <div className="bg-skin-fill/30 p-3 rounded-lg border border-skin-border space-y-2">
                                            <div className="flex items-center gap-2">
                                                <label className="text-[10px] uppercase font-bold text-skin-muted">{t(lang, 'fullImageOpaquePercent')}</label>
                                                <HelpTip text={t(lang, 'fullImageOpaquePercentDesc')} />
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <input
                                                    type="range" min="80" max="100" step="1"
                                                    value={config.fullImageOpaquePercent}
                                                    onChange={(e) => updateConfig('fullImageOpaquePercent', Number(e.target.value))}
                                                    className="flex-1 h-1 bg-skin-border rounded-lg appearance-none cursor-pointer accent-skin-primary"
                                                />
                                                <div className="relative">
                                                    <input
                                                        type="number" min="0" max="100"
                                                        value={config.fullImageOpaquePercent}
                                                        onChange={(e) => updateConfig('fullImageOpaquePercent', Math.max(0, Math.min(100, Number(e.target.value))))}
                                                        className="w-12 p-1 text-xs text-center border border-skin-border rounded bg-skin-surface"
                                                    />
                                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[9px] text-skin-muted pointer-events-none">%</span>
                                                </div>
                                            </div>
                                        </div>
                                    </OffDim>
                                </SettingsCard>

                                <SettingsCard
                                    title={t(lang, 'aiPayloadCompression')}
                                    help={t(lang, 'aiPayloadCompressionDesc')}
                                    action={
                                        <Toggle
                                            checked={config.enableAiPayloadCompression}
                                            onChange={(v) => updateConfig('enableAiPayloadCompression', v)}
                                        />
                                    }
                                >
                                    <OffDim off={!config.enableAiPayloadCompression}>
                                        <div className="space-y-3">
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-skin-muted block mb-1">{t(lang, 'aiPayloadTranslationTargetKB')}</label>
                                                <div className="relative">
                                                    <input
                                                        type="number" min="50" max="10000" step="50"
                                                        value={config.aiPayloadTranslationTargetKB}
                                                        onChange={(e) => updateConfig('aiPayloadTranslationTargetKB', Math.max(50, Math.min(10000, Number(e.target.value) || 500)))}
                                                        className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 pr-10"
                                                    />
                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-skin-muted pointer-events-none">KB</span>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="text-[10px] uppercase font-bold text-skin-muted block mb-1">{t(lang, 'aiPayloadRedrawTargetKB')}</label>
                                                <div className="relative">
                                                    <input
                                                        type="number" min="100" max="20000" step="100"
                                                        value={config.aiPayloadRedrawTargetKB}
                                                        onChange={(e) => updateConfig('aiPayloadRedrawTargetKB', Math.max(100, Math.min(20000, Number(e.target.value) || 1500)))}
                                                        className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 pr-10"
                                                    />
                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-skin-muted pointer-events-none">KB</span>
                                                </div>
                                            </div>
                                        </div>
                                        <p className="text-[10px] text-skin-muted leading-tight">{t(lang, 'aiPayloadTargetKBHint')}</p>
                                    </OffDim>
                                </SettingsCard>

                                {/* 整批重试轮数：和右侧 dock「处理选项」里的是同一个配置，
                                    放在这里是为了编辑器模式（WorkflowDock 不渲染）也能调整。 */}
                                <SettingsCard
                                    title={t(lang, 'endRetryRoundsLabel')}
                                    help={t(lang, 'endRetryRoundsDesc')}
                                    summary={`${config.maxRetryRounds}`}
                                    summaryTone={config.maxRetryRounds > 0 ? 'on' : 'off'}
                                >
                                    <div className="flex items-center gap-3">
                                        <input
                                            type="number" min="0" step="1"
                                            value={config.maxRetryRounds}
                                            onChange={(e) => updateConfig('maxRetryRounds', Math.max(0, Number(e.target.value) || 0))}
                                            className="w-20 p-2 text-xs text-center border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                        />
                                        <span className="flex-1 text-[10px] text-skin-muted leading-tight">{t(lang, 'endRetryRoundsDesc')}</span>
                                    </div>
                                </SettingsCard>
                            </>
                        )}

                        {/* ---------------- 翻译 ---------------- */}
                        {tab === 'translation' && (
                            <>
                                {/* Split out of the mode switch: the endpoint can (and
                                    usually should) be configured before the mode is on. */}
                                <SettingsCard
                                    title={t(lang, 'translationApiLabel')}
                                    summary={translationApiSummary}
                                    summaryTone={translationApiReady ? 'on' : 'off'}
                                    help={t(lang, 'translationApiDesc')}
                                >
                                    <ApiProfileSwitcher
                                        profiles={config.translationApiProfiles || []}
                                        activeId={config.activeTranslationApiProfileId ?? null}
                                        current={{
                                            baseUrl: config.translationBaseUrl,
                                            apiKey: config.translationApiKey,
                                            model: config.translationModel,
                                        }}
                                        onProfilesChange={(profiles, activeId) => {
                                            updateConfig('translationApiProfiles', profiles);
                                            updateConfig('activeTranslationApiProfileId', activeId);
                                        }}
                                        onApply={(values) => {
                                            updateConfig('translationBaseUrl', values.baseUrl);
                                            updateConfig('translationApiKey', values.apiKey);
                                            updateConfig('translationModel', values.model);
                                        }}
                                        language={lang}
                                    />
                                    <div>
                                        <label className="text-[10px] text-skin-muted block mb-1">{t(lang, 'baseUrl')}</label>
                                        <input
                                            type="text"
                                            value={config.translationBaseUrl}
                                            onChange={(e) => updateConfig('translationBaseUrl', e.target.value)}
                                            className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-[10px] text-skin-muted block mb-1">{t(lang, 'apiKey')}</label>
                                        <SecretInput
                                            value={config.translationApiKey}
                                            onChange={(value) => updateConfig('translationApiKey', value)}
                                            language={lang}
                                            className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                        />
                                    </div>
                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <label className="text-[10px] text-skin-muted block">{t(lang, 'model')}</label>
                                            <button onClick={fetchTransModels} className="text-[10px] text-skin-primary hover:underline">{t(lang, 'fetchList')}</button>
                                        </div>
                                        <div className="relative" ref={transModelAnchorRef}>
                                            <input
                                                type="text"
                                                value={config.translationModel}
                                                onChange={(e) => updateConfig('translationModel', e.target.value)}
                                                className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                            />
                                            <FloatingPanel
                                                open={transModels.length > 0}
                                                anchorRef={transModelAnchorRef}
                                                maxHeight={120}
                                                className="overflow-y-auto border border-skin-border rounded bg-skin-surface shadow-lg"
                                            >
                                                {transModels.map(m => (
                                                    <div
                                                        key={m}
                                                        onClick={() => { updateConfig('translationModel', m); setTransModels([]); }}
                                                        className="px-2 py-1 text-[10px] hover:bg-skin-fill cursor-pointer truncate"
                                                    >
                                                        {m}
                                                    </div>
                                                ))}
                                            </FloatingPanel>
                                        </div>
                                    </div>
                                </SettingsCard>

                                <SettingsCard
                                    title={t(lang, 'enableTranslationMode')}
                                    help={t(lang, 'enableTranslationModeDesc')}
                                    action={
                                        <Toggle
                                            checked={config.enableTranslationMode}
                                            onChange={(enabled) => {
                                                setConfig(prev => ({
                                                    ...prev,
                                                    enableTranslationMode: enabled,
                                                    prompt: enabled ? TRANSLATION_MODE_IMAGE_PROMPT : prev.prompt,
                                                }));
                                            }}
                                        />
                                    }
                                >
                                    <SubRow
                                        title={t(lang, 'sendMaskedContextForTranslation')}
                                        help={t(lang, 'sendMaskedContextForTranslationDesc')}
                                        control={
                                            <Toggle
                                                size="sm"
                                                checked={config.sendMaskedContextForTranslation}
                                                onChange={(enabled) => {
                                                    // Each mode keeps its own prompt slot: park the
                                                    // current one under the old key, restore the
                                                    // cached (or default) one for the new mode.
                                                    const currentPrompt = config.translationPrompt;
                                                    const oldSlotKey = !enabled ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                                    const newSlotKey = enabled ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                                    const cachedPrompt = (config as any)[newSlotKey];
                                                    const newPrompt = cachedPrompt || (enabled ? TRANSLATION_CONTEXT_SYSTEM_PROMPT : DEFAULT_TRANSLATION_PROMPT);
                                                    setConfig(prev => ({
                                                        ...prev,
                                                        sendMaskedContextForTranslation: enabled,
                                                        [oldSlotKey]: currentPrompt,
                                                        translationPrompt: newPrompt,
                                                    }));
                                                }}
                                            />
                                        }
                                    />

                                    <div>
                                        <div className="flex justify-between items-center mb-1">
                                            <label className="text-[10px] text-skin-muted block">{t(lang, 'translationPromptLabel')}</label>
                                            <button
                                                onClick={() => {
                                                    const defaultPrompt = config.sendMaskedContextForTranslation ? TRANSLATION_CONTEXT_SYSTEM_PROMPT : DEFAULT_TRANSLATION_PROMPT;
                                                    const slotKey = config.sendMaskedContextForTranslation ? 'translationPromptWithContext' : 'translationPromptNoContext';
                                                    setConfig(prev => ({
                                                        ...prev,
                                                        translationPrompt: defaultPrompt,
                                                        [slotKey]: '',
                                                    }));
                                                }}
                                                className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer flex items-center gap-1"
                                                title={t(lang, 'resetToDefault')}
                                            >
                                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                                {t(lang, 'reset')}
                                            </button>
                                        </div>
                                        <textarea
                                            value={config.translationPrompt}
                                            onChange={(e) => updateConfig('translationPrompt', e.target.value)}
                                            className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 h-24 resize-none shadow-sm"
                                            placeholder={t(lang, 'translationPromptPlaceholder')}
                                        />
                                    </div>

                                    {/* Opt-in legacy behaviour: the redraw stage runs the
                                        translation call itself for boxes that have no
                                        cached translation yet. Off = the two stages stay
                                        decoupled (redraw only reads the cache). */}
                                    <SubRow
                                        title={t(lang, 'translateBeforeRedraw')}
                                        help={t(lang, 'translateBeforeRedrawDesc')}
                                        control={
                                            <Toggle
                                                size="sm"
                                                checked={config.translateBeforeRedraw}
                                                onChange={(v) => updateConfig('translateBeforeRedraw', v)}
                                            />
                                        }
                                    />

                                    {/* Stage separation: translation is an independent task
                                        (sidebar 「翻译所有图片」) that fills the cache; with
                                        必须翻译 on, generation only redraws boxes that
                                        already have one and skips (not fails) the rest.
                                        Moot while 重绘前翻译 auto-fills the cache inline. */}
                                    <div className={config.translateBeforeRedraw ? 'opacity-40 pointer-events-none select-none' : ''}>
                                        <SubRow
                                            title={t(lang, 'requireTranslation')}
                                            help={t(lang, 'requireTranslationDesc')}
                                            control={
                                                <Toggle
                                                    size="sm"
                                                    checked={config.requireTranslationForGeneration}
                                                    onChange={(v) => updateConfig('requireTranslationForGeneration', v)}
                                                />
                                            }
                                        />
                                    </div>

                                    {/* Editor typesetting: ask the same vision call to also
                                        classify each region's original typeface. */}
                                    <SubRow
                                        title={t(lang, 'enableFontAutoDetect')}
                                        help={t(lang, 'enableFontAutoDetectDesc')}
                                        control={
                                            <Toggle
                                                size="sm"
                                                checked={config.enableFontAutoDetect}
                                                onChange={(v) => updateConfig('enableFontAutoDetect', v)}
                                            />
                                        }
                                    />
                                </SettingsCard>

                                {/* Own card rather than a nested block: the glossary is
                                    data (and the only destructive action in here), not a
                                    translation behaviour. */}
                                <SettingsCard
                                    title={t(lang, 'glossary')}
                                    help={t(lang, 'glossaryDesc')}
                                    summary={config.enableGlossary
                                        ? t(lang, 'glossaryCount', { count: glossaryCount })
                                        : undefined}
                                    summaryTone="on"
                                    action={
                                        <Toggle
                                            checked={config.enableGlossary}
                                            onChange={(v) => updateConfig('enableGlossary', v)}
                                        />
                                    }
                                >
                                    <OffDim off={!config.enableGlossary}>
                                        <div className="flex items-center justify-end gap-2">
                                            <button
                                                onClick={() => {
                                                    if (glossaryClearArmed) {
                                                        updateConfig('glossaryText', '');
                                                        setGlossaryClearArmed(false);
                                                    } else {
                                                        setGlossaryClearArmed(true);
                                                        setTimeout(() => setGlossaryClearArmed(false), 3000);
                                                    }
                                                }}
                                                className={`text-[9px] px-1.5 py-0.5 rounded border transition-all ${
                                                    glossaryClearArmed
                                                        ? 'bg-rose-500 text-white border-rose-600'
                                                        : 'text-skin-muted border-skin-border hover:text-rose-500 hover:border-rose-500'
                                                }`}
                                            >
                                                {glossaryClearArmed ? t(lang, 'glossaryClearConfirm') : t(lang, 'glossaryClear')}
                                            </button>
                                        </div>
                                        <textarea
                                            value={config.glossaryText || ''}
                                            onChange={(e) => updateConfig('glossaryText', e.target.value)}
                                            className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 h-24 resize-none shadow-sm font-mono"
                                            placeholder={glossaryCount === 0 ? t(lang, 'glossaryEmpty') : t(lang, 'glossaryPlaceholder')}
                                        />
                                    </OffDim>
                                </SettingsCard>
                            </>
                        )}

                        {/* ---------------- 数据管理 ---------------- */}
                        {tab === 'data' && (
                            <SettingsCard
                                title={t(lang, 'configBackup')}
                                help={t(lang, 'configBackupDesc')}
                            >
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleExportConfig}
                                        className="flex-1 py-2 text-[11px] font-medium rounded-lg border border-skin-border text-skin-text hover:border-skin-primary hover:text-skin-primary transition-colors"
                                    >
                                        {t(lang, 'configExport')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleImportClick}
                                        className={`flex-1 py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                                            importArmed
                                                ? 'bg-rose-500 border-rose-600 text-white'
                                                : 'border-skin-border text-skin-text hover:border-skin-primary hover:text-skin-primary'
                                        }`}
                                    >
                                        {t(lang, 'configImport')}
                                    </button>
                                </div>
                                {/* Destructive, so it gets its own row instead of sitting
                                    next to 导出/导入 under the same cursor path. */}
                                <button
                                    type="button"
                                    onClick={handleInitialize}
                                    title={t(lang, 'configInitHint')}
                                    className={`w-full py-2 text-[11px] font-medium rounded-lg border transition-colors ${
                                        initArmed
                                            ? 'bg-rose-500 border-rose-600 text-white'
                                            : 'border-rose-500/50 text-rose-500 hover:bg-rose-500/10'
                                    }`}
                                >
                                    {t(lang, 'configInit')}
                                </button>
                                <input
                                    ref={configFileRef}
                                    type="file"
                                    accept="application/json,.json"
                                    className="hidden"
                                    onChange={handleConfigFile}
                                />
                                {backupStatus && (
                                    <p className={`text-[10px] leading-snug ${
                                        backupStatus.tone === 'ok'
                                            ? 'text-emerald-600 dark:text-emerald-400'
                                            : 'text-amber-600 dark:text-amber-400'
                                    }`}>
                                        {backupStatus.text}
                                    </p>
                                )}
                            </SettingsCard>
                        )}
                    </div>
                </div>

                <div className="p-4 border-t border-skin-border bg-skin-fill/30">
                    <button onClick={onClose} className="w-full py-2 bg-skin-primary text-skin-primary-fg rounded-lg font-bold">
                        {t(lang, 'close')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default GlobalSettings;
