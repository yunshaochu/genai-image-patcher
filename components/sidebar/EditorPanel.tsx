import React from 'react';
import { AppConfig, UploadedImage } from '../../types';
import { t } from '../../services/translations';
import { EraseScope, RestoreScope } from '../../hooks/useMangaEditor';

/**
 * Sidebar panel for the in-place manga text editor (editor workflow mode).
 *
 * Slimmed to batch operations only — per-region editing (text / direction /
 * font size / erase / OCR / brush) lives in the right-side EditorDock, which
 * appears when a box is selected on the canvas' "编辑" tab.
 */

interface EditorPanelProps {
  image: UploadedImage;
  config: AppConfig;
  busy: boolean;
  onConfigChange: (key: keyof AppConfig, value: any) => void;
  onErase: (scope: EraseScope) => void;
  onRestoreErase: (scope: RestoreScope) => void;
  onOcrAll: () => void;
  onTranslate: () => void;
  onTranslateAll: () => void;
}

export const EditorPanel: React.FC<EditorPanelProps> = ({
    image, config, busy, onConfigChange,
    onErase, onRestoreErase, onOcrAll, onTranslate, onTranslateAll,
}) => {
  const lang = config.language;

  // Mirror the hook's scope filter so the translate buttons' disabled state
  // matches what would actually be translated.
  const scope = config.editorTranslationScope ?? 'all';
  const translateTargetCount = image.regions.filter(r =>
    !r.contextOnly && (scope === 'bubble' ? r.detectedClass === 'text_bubble' : true)
  ).length;

  return (
    <div className="space-y-3 animate-in fade-in slide-in-from-right-8">
      {/* Erasure batch actions */}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          onClick={() => onErase('bubbleOnly')}
          disabled={busy}
          className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
          title={t(lang, 'editorEraseBubbleTip')}
        >
          {t(lang, 'editorEraseBubble')}
        </button>
        <button
          onClick={() => onErase('all')}
          disabled={busy}
          className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
          title={t(lang, 'editorEraseAllTip')}
        >
          {t(lang, 'editorEraseAll')}
        </button>
        <button
          onClick={() => onRestoreErase('textFree')}
          disabled={busy}
          className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-text hover:bg-skin-fill disabled:opacity-50 transition-colors"
          title={t(lang, 'editorRestoreFreeTip')}
        >
          {t(lang, 'editorRestoreFree')}
        </button>
        <button
          onClick={() => onRestoreErase('all')}
          disabled={busy}
          className="px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-text hover:bg-skin-fill disabled:opacity-50 transition-colors"
        >
          {t(lang, 'editorRestoreAll')}
        </button>
      </div>

      {config.enableOCR && (
        <button
          onClick={onOcrAll}
          disabled={busy}
          className="w-full px-2 py-1.5 text-[10px] border border-skin-border rounded text-skin-muted hover:text-skin-primary hover:border-skin-primary disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
          {t(lang, 'editorOcrAll')}
        </button>
      )}

      {config.enableTranslationMode && (
        <div className="space-y-1.5">
          {/* Translation scope: bubbles only vs all detected text */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-skin-muted whitespace-nowrap">{t(lang, 'editorTransScope')}</span>
            <div className="flex-1 flex bg-skin-fill p-0.5 rounded border border-skin-border">
              <button
                onClick={() => onConfigChange('editorTranslationScope', 'bubble')}
                className={`flex-1 px-1 py-0.5 text-[9px] rounded transition-all ${scope === 'bubble' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
                title={t(lang, 'editorTransScopeBubbleTip')}
              >
                {t(lang, 'editorTransScopeBubble')}
              </button>
              <button
                onClick={() => onConfigChange('editorTranslationScope', 'all')}
                className={`flex-1 px-1 py-0.5 text-[9px] rounded transition-all ${scope === 'all' ? 'bg-skin-surface shadow-sm text-skin-primary font-bold' : 'text-skin-muted'}`}
                title={t(lang, 'editorTransScopeAllTip')}
              >
                {t(lang, 'editorTransScopeAll')}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={onTranslate}
              disabled={busy || translateTargetCount === 0}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary text-white rounded hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all"
              title={t(lang, 'editorTranslateTip')}
            >
              {t(lang, 'editorTranslateAll')}
            </button>
            <button
              onClick={onTranslateAll}
              disabled={busy}
              className="px-2 py-1.5 text-[10px] font-bold bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 disabled:opacity-50 transition-colors"
              title={t(lang, 'editorTranslateAllImagesTip')}
            >
              {t(lang, 'editorTranslateAllImages')}
            </button>
          </div>
        </div>
      )}

      {busy && (
        <div className="flex items-center justify-center gap-2 text-[10px] text-skin-primary">
          <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
          {t(lang, 'editorWorking')}
        </div>
      )}

      {/* Pointer to the new editing surface */}
      <p className="text-[10px] text-skin-muted leading-relaxed border border-dashed border-skin-border rounded-lg p-2 bg-skin-fill/20">
        {t(lang, 'editorEditHint')}
      </p>
    </div>
  );
};
