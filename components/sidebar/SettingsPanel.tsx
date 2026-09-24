
import React, { useState, useRef, useEffect } from 'react';
import { AppConfig } from '../../types';
import { t } from '../../services/translations';
import { ApiProfileSwitcher } from './ApiProfileSwitcher';
import { SecretInput } from './SecretInput';

interface SettingsPanelProps {
    config: AppConfig;
    onChange: (key: keyof AppConfig, value: any) => void;
    onFetchModels: () => void;
    modelList: string[];
    isLoadingModels: boolean;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ 
    config, 
    onChange, 
    onFetchModels, 
    modelList, 
    isLoadingModels 
}) => {
    const lang = config.language;
    const [showModelDropdown, setShowModelDropdown] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setShowModelDropdown(false);
            }
        };
        if (showModelDropdown) {
            document.addEventListener('mousedown', handleClickOutside);
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showModelDropdown]);

    return (
        <div className="space-y-4">
            {/* Provider Switch */}
            <div>
                <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'provider')}</label>
                <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
                    <button
                        onClick={() => onChange('provider', 'gemini')}
                        title={t(lang, 'providerGeminiHint')}
                        className={`flex-1 py-1.5 text-[10px] rounded-md transition-all font-medium ${config.provider === 'gemini' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted hover:text-skin-text'}`}
                    >
                        Gemini
                    </button>
                    <button
                        onClick={() => onChange('provider', 'openai')}
                        title={t(lang, 'providerOpenAiHint')}
                        className={`flex-1 py-1.5 text-[10px] rounded-md transition-all font-medium ${config.provider === 'openai' ? 'bg-skin-surface shadow-sm text-skin-primary' : 'text-skin-muted hover:text-skin-text'}`}
                    >
                        OpenAI
                    </button>
                </div>
            </div>

            {/* OpenAI Specifics */}
            {config.provider === 'openai' && (
                <>
                    {/* Saved endpoints: one click swaps url/key/model as a set. */}
                    <ApiProfileSwitcher
                        profiles={config.imageApiProfiles || []}
                        activeId={config.activeImageApiProfileId ?? null}
                        current={{
                            baseUrl: config.openaiBaseUrl,
                            apiKey: config.openaiApiKey,
                            model: config.openaiModel,
                        }}
                        onProfilesChange={(profiles, activeId) => {
                            onChange('imageApiProfiles', profiles);
                            onChange('activeImageApiProfileId', activeId);
                        }}
                        onApply={(values) => {
                            onChange('openaiBaseUrl', values.baseUrl);
                            onChange('openaiApiKey', values.apiKey);
                            onChange('openaiModel', values.model);
                        }}
                        language={lang}
                    />
                    <div className="animate-in fade-in slide-in-from-top-1">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'baseUrl')}</label>
                        <input 
                            type="text" 
                            value={config.openaiBaseUrl}
                            onChange={(e) => onChange('openaiBaseUrl', e.target.value)}
                            className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                            placeholder="https://api.openai.com/v1"
                        />
                    </div>
                    <div className="animate-in fade-in slide-in-from-top-2">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'apiKey')}</label>
                        <SecretInput
                            value={config.openaiApiKey}
                            onChange={(value) => onChange('openaiApiKey', value)}
                            language={lang}
                            className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                            placeholder="sk-..."
                        />
                    </div>
                    <div className="relative animate-in fade-in slide-in-from-top-3">
                        <div className="flex justify-between items-center mb-1">
                            <label className="text-[10px] uppercase font-bold text-skin-muted block">{t(lang, 'model')}</label>
                            <button 
                                onClick={onFetchModels}
                                disabled={isLoadingModels}
                                className="text-[10px] text-skin-primary hover:underline disabled:opacity-50"
                            >
                                {isLoadingModels ? t(lang, 'fetching') : t(lang, 'fetchList')}
                            </button>
                        </div>
                        <div className="relative" ref={dropdownRef}>
                            <input 
                                type="text" 
                                value={config.openaiModel}
                                onChange={(e) => onChange('openaiModel', e.target.value)}
                                onFocus={() => modelList.length > 0 && setShowModelDropdown(true)}
                                className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                                placeholder={t(lang, 'modelIdPlaceholder')}
                            />
                            {showModelDropdown && modelList.length > 0 && (
                                <div className="absolute top-full left-0 right-0 mt-1 max-h-40 overflow-y-auto bg-skin-surface border border-skin-border rounded-lg shadow-lg z-50 custom-scrollbar">
                                    {modelList.map(model => (
                                        <div 
                                            key={model}
                                            onClick={() => {
                                                onChange('openaiModel', model);
                                                setShowModelDropdown(false);
                                            }}
                                            className="px-3 py-2 text-xs hover:bg-skin-fill cursor-pointer truncate text-skin-text"
                                        >
                                            {model}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                    <div className="animate-in fade-in slide-in-from-top-4 pt-1">
                        <label className="flex items-center gap-2 cursor-pointer group">
                            <input 
                                type="checkbox" 
                                checked={config.openaiStream}
                                onChange={(e) => onChange('openaiStream', e.target.checked)}
                                className="rounded border-skin-border text-skin-primary focus:ring-skin-primary"
                            />
                            <span className="text-xs text-skin-muted group-hover:text-skin-text transition-colors">Enable Stream (Beta)</span>
                        </label>
                    </div>
                </>
            )}

            {/* Gemini Specifics */}
            {config.provider === 'gemini' && (
                <>
                    <div className="animate-in fade-in slide-in-from-top-1">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">API Key (Optional Override)</label>
                        <SecretInput
                            value={config.geminiApiKey}
                            onChange={(value) => onChange('geminiApiKey', value)}
                            language={lang}
                            className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                            placeholder="Leave empty to use env API_KEY"
                        />
                    </div>
                    <div className="animate-in fade-in slide-in-from-top-2">
                        <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(lang, 'model')}</label>
                        <input
                            type="text"
                            value={config.geminiModel}
                            onChange={(e) => onChange('geminiModel', e.target.value)}
                            className="w-full p-2 text-xs border border-skin-border rounded-lg bg-skin-surface focus:border-skin-primary transition-colors focus:ring-1 focus:ring-skin-primary/50"
                        />
                    </div>
                </>
            )}
        </div>
    );
};
