
import React, { useState, useEffect, useRef } from 'react';
import { UploadedImage, AppConfig, Region, Language, RedrawIntent, isRegionPaintable } from '../../types';
import { defaultRegionPrompt } from '../../hooks/useConfig';
import { t } from '../../services/translations';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, releaseObjectURL, PaddingInfo } from '../../services/imageUtils';
import { CopyOutcome, buildWorkbenchPrompt, copyImageAndTextToClipboard, copyTextToClipboard } from '../../services/workbenchCopy';

/**
 * Square-fill paste helper: when the copied image was padded to a square
 * (paddingInfo captured at copy time), center-crop the pasted result back to
 * the original ratio before it is applied. Returns the input unchanged when
 * square fill is off or the info is missing — zero overhead in that case.
 */
const depadPastedImage = async (dataUrl: string, info: PaddingInfo | null, cropInset: number): Promise<string> => {
    if (!info) return dataUrl;
    try {
        return await depadImageByRatio(dataUrl, info, cropInset);
    } catch (e) {
        console.error('Square fill depad on paste failed, using pasted image as-is', e);
        return dataUrl;
    }
};

/** Transient copy feedback: 'idle' → outcome → back to 'idle' after 2s. */
const useCopyFeedback = () => {
    const [status, setStatus] = useState<CopyOutcome | 'idle'>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const flash = (next: CopyOutcome | 'idle') => {
        if (timer.current) clearTimeout(timer.current);
        setStatus(next);
        if (next !== 'idle') timer.current = setTimeout(() => setStatus('idle'), 2000);
    };
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    return { status, flash };
};

/** Caption of the 「复制图文」 button for the current feedback state. */
const imageCopyLabel = (lang: Language, outcome: CopyOutcome | 'idle'): string => {
    switch (outcome) {
        case 'image+text': return t(lang, 'copiedImagePrompt');
        case 'image': return t(lang, 'copiedImageOnly');
        case 'text': return t(lang, 'copiedPromptOnly');
        case 'failed': return t(lang, 'copyFailedShort');
        default: return t(lang, 'copyImagePrompt');
    }
};

/** Caption of the 「复制提示词」 button for the current feedback state. */
const textCopyLabel = (lang: Language, outcome: CopyOutcome | 'idle'): string => {
    switch (outcome) {
        case 'text': return t(lang, 'copiedPromptOnly');
        case 'failed': return t(lang, 'copyFailedShort');
        default: return t(lang, 'copyPromptOnly');
    }
};

const copyButtonClass =
    'flex-1 min-w-0 text-[9px] px-1 py-1 bg-skin-surface border border-skin-border rounded hover:bg-skin-fill transition-colors text-center truncate disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * The intent-specific prompt text of a region / image — the SAME text the app
 * would send for the box's current redraw scene, so what the user pastes into
 * an external AI matches the in-app run.
 *
 * The default scene prompt is NOT materialised into the slot (it is shown as a
 * placeholder), so an empty slot must fall back to it — otherwise the copy
 * would only carry the global prompt.
 */
const intentSlotText = (
    v: { customPrompt?: string; customPromptErase?: string; customPromptFree?: string; redrawIntent?: RedrawIntent },
    defaultIntent: RedrawIntent
): string => {
    const intent = v.redrawIntent ?? defaultIntent ?? 'translate';
    const slot = (intent === 'erase' ? v.customPromptErase
        : intent === 'custom' ? v.customPromptFree
            : v.customPrompt) ?? '';
    return slot.trim() || defaultRegionPrompt(intent);
};

export const FullImageMaskRow: React.FC<{
  image: UploadedImage;
  config: AppConfig;
  onPatchUpdate: (base64: string) => void;
}> = ({ image, config, onPatchUpdate }) => {
  const [maskedPreview, setMaskedPreview] = useState<string | null>(null);
  // Padding info of the square-filled copy (null when square fill is off)
  const paddingInfoRef = useRef<PaddingInfo | null>(null);
  const imgCopy = useCopyFeedback();
  const txtCopy = useCopyFeedback();
  // The whole-image row has no region: the prompt it exports is the global one
  // plus this image's intent-specific prompt (default scene prompt included).
  const promptText = buildWorkbenchPrompt(config, {
    imagePrompt: intentSlotText(image, config.defaultRedrawIntent ?? 'translate'),
  });

  useEffect(() => {
    let active = true;
    const generatePreview = async () => {
      try {
        const imgEl = await loadImage(image.previewUrl);
        // Only paintable regions (per the configured generation source) are
        // whited out of the masked copy — everything else stays visible.
        const maskRegions = image.regions.filter(r =>
          isRegionPaintable(r, config.generationRegionSource ?? 'text')
        );
        let preview: string;
        if (config.useInvertedMasking) {
            preview = await createInvertedMultiMaskedFullImage(imgEl, maskRegions);
        } else {
            preview = await createMultiMaskedFullImage(imgEl, maskRegions);
        }
        // Square fill: pad the masked copy to a square with a blurred
        // background (same as the API path). Inverted masking is skipped,
        // mirroring the API path — padding would be undone immediately.
        let info: PaddingInfo | null = null;
        if (config.enableSquareFill && !config.useInvertedMasking) {
            const padded = await padImageToSquare(preview, config.squareFillSize);
            releaseObjectURL(preview);
            preview = padded.url;
            info = padded.info;
        }
        if (active) {
          paddingInfoRef.current = info;
          // Release old preview URL before setting new one
          setMaskedPreview(prev => {
            if (prev) releaseObjectURL(prev);
            return preview;
          });
        } else {
          // Component unmounted — release the URL we just created
          releaseObjectURL(preview);
        }
      } catch (e) {
        console.error("Failed to create masked preview", e);
      }
    };
    generatePreview();
    return () => { active = false; };
  }, [image.previewUrl, image.regions, config.useInvertedMasking, config.useFullImageMasking, config.enableSquareFill, config.squareFillSize, config.generationRegionSource]);

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
             if (evt.target?.result) {
                depadPastedImage(evt.target.result as string, paddingInfoRef.current, config.squareFillCropInset)
                    .then(url => onPatchUpdate(url));
             }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    }
  };

  return (
    <div className="flex flex-col gap-2 bg-skin-primary/5 p-2 rounded-lg border-2 border-dashed border-skin-primary/30 relative mb-4">
      <div className="absolute -top-2.5 left-2 bg-skin-surface px-1.5 text-[9px] font-bold text-skin-primary border border-skin-primary/30 rounded">
         {config.useInvertedMasking ? 'FULL IMAGE (REVERSE)' : 'FULL IMAGE (MASKED)'}
      </div>
      <div className="flex items-stretch gap-2 mt-2">
          <div className="flex-1 flex flex-col gap-1 items-center">
             <span className="text-[9px] text-skin-muted uppercase">{t(config.language, 'maskedInput')}</span>
             <div className="w-16 h-16 bg-checkerboard rounded border border-skin-border overflow-hidden relative group">
                {maskedPreview ? (
                  <img src={maskedPreview} className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full animate-pulse bg-skin-fill"></div>
                )}
             </div>
             <div className="flex gap-1 w-full">
                <button
                   onClick={async () => {
                       if (!maskedPreview) return;
                       imgCopy.flash(await copyImageAndTextToClipboard(maskedPreview, promptText));
                   }}
                   disabled={!maskedPreview}
                   className={copyButtonClass}
                   title={t(config.language, 'copyImagePromptTip')}
                >
                   {imageCopyLabel(config.language, imgCopy.status)}
                </button>
                <button
                   onClick={async () => {
                       txtCopy.flash((await copyTextToClipboard(promptText)) ? 'text' : 'failed');
                   }}
                   disabled={!promptText}
                   className={copyButtonClass}
                   title={promptText ? t(config.language, 'copyPromptOnlyTip') : t(config.language, 'copyPromptEmpty')}
                >
                   {textCopyLabel(config.language, txtCopy.status)}
                </button>
             </div>
          </div>

          <div className="flex items-center text-skin-muted flex-col justify-center">
            <svg className="w-4 h-4 text-skin-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path></svg>
          </div>

          <div className="flex-1 flex flex-col gap-1 items-center">
             <span className="text-[9px] text-skin-muted uppercase">{t(config.language, 'fullAiOutput')}</span>
             <div 
               className={`w-16 h-16 bg-skin-surface rounded border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer outline-none transition-all relative group ${
                 image.fullAiResultUrl ? 'border-emerald-400 bg-emerald-50/50' : 'border-skin-border hover:border-skin-primary'
               }`}
               tabIndex={0}
               onPaste={handlePaste}
               title={t(config.language, 'pasteHint')}
             >
                {image.fullAiResultUrl ? (
                  <img src={image.fullAiResultUrl} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[9px] text-skin-muted text-center px-1">Ctrl+V</span>
                )}
             </div>
             
             <div className={`text-[9px] font-bold py-1 ${image.fullAiResultUrl ? 'text-emerald-500' : 'text-skin-muted'}`}>
                {image.fullAiResultUrl ? 'Ready' : 'Empty'}
             </div>
          </div>
      </div>
      <div className="text-[9px] text-skin-muted text-center italic bg-skin-surface/50 rounded py-0.5">
         Paste here updates all crops
      </div>
    </div>
  );
};

export const ManualPatchRow: React.FC<{
  region: Region;
  image: UploadedImage;
  config: AppConfig;
  onPatchUpdate: (base64: string) => void;
  lang: 'zh' | 'en';
  onOcr: () => void;
  showOcr: boolean;
  showRetryDiagnostics: boolean;
}> = ({ region, image, config, onPatchUpdate, lang, onOcr, showOcr, showRetryDiagnostics }) => {
  const [sourceCrop, setSourceCrop] = useState<string | null>(null);
  const [errorHistoryOpen, setErrorHistoryOpen] = useState(false);
  // Padding info of the square-filled copy (null when square fill is off)
  const paddingInfoRef = useRef<PaddingInfo | null>(null);
  const imgCopy = useCopyFeedback();
  const txtCopy = useCopyFeedback();
  // Exactly what the app would send for this box: global prompt + this box's
  // intent-specific prompt (default scene prompt included when the slot is empty).
  const promptText = buildWorkbenchPrompt(config, {
    regionPrompt: intentSlotText(region, config.defaultRedrawIntent ?? 'translate'),
  });

  useEffect(() => {
    let active = true;
    const generateCrop = async () => {
      try {
        const imgEl = await loadImage(image.previewUrl);
        let cropUrl = await cropRegion(imgEl, region);
        // Square fill: pad the copied crop to a square with a blurred
        // background so external AI tools get the model-friendly ratio.
        let info: PaddingInfo | null = null;
        if (config.enableSquareFill) {
            const padded = await padImageToSquare(cropUrl, config.squareFillSize);
            releaseObjectURL(cropUrl);
            cropUrl = padded.url;
            info = padded.info;
        }
        if (active) {
          paddingInfoRef.current = info;
          setSourceCrop(prev => {
            if (prev) releaseObjectURL(prev);
            return cropUrl;
          });
        } else {
          releaseObjectURL(cropUrl);
        }
      } catch (e) {
        console.error("Failed to crop for manual view", e);
      }
    };
    generateCrop();
    return () => { active = false; };
  }, [image.previewUrl, region, config.enableSquareFill, config.squareFillSize]);

  const handleCopy = async () => {
    if (!sourceCrop) return;
    imgCopy.flash(await copyImageAndTextToClipboard(sourceCrop, promptText));
  };

  const handleCopyPrompt = async () => {
    txtCopy.flash((await copyTextToClipboard(promptText)) ? 'text' : 'failed');
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) {
          const reader = new FileReader();
          reader.onload = (evt) => {
             if (evt.target?.result) {
                depadPastedImage(evt.target.result as string, paddingInfoRef.current, config.squareFillCropInset)
                    .then(url => onPatchUpdate(url));
             }
          };
          reader.readAsDataURL(file);
          return;
        }
      }
    }
  };

  return (
    <div className={`flex flex-col gap-2 bg-skin-fill/30 p-2 rounded-lg border ${region.source === 'auto' ? 'border-dashed border-skin-primary/50' : 'border-skin-border'}`}>
      <div className="flex items-stretch gap-2">
          <div className="flex-1 flex flex-col gap-1 items-center">
             <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'sourceCrop')}</span>
             <div className="w-16 h-16 bg-checkerboard rounded border border-skin-border overflow-hidden relative group">
                {sourceCrop ? (
                  <img src={sourceCrop} className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full animate-pulse bg-skin-fill"></div>
                )}
                {region.source === 'auto' && (
                    <div className="absolute top-0 right-0 p-0.5 bg-skin-primary text-white rounded-bl shadow-sm" title="Detected Automatically">
                       <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                    </div>
                )}
             </div>
             <div className="flex gap-1 w-full">
                 <button
                   onClick={handleCopy}
                   disabled={!sourceCrop}
                   className={copyButtonClass}
                   title={t(lang, 'copyImagePromptTip')}
                 >
                   {imageCopyLabel(lang, imgCopy.status)}
                 </button>
                 <button
                   onClick={handleCopyPrompt}
                   disabled={!promptText}
                   className={copyButtonClass}
                   title={promptText ? t(lang, 'copyPromptOnlyTip') : t(lang, 'copyPromptEmpty')}
                 >
                   {textCopyLabel(lang, txtCopy.status)}
                 </button>
             </div>
          </div>

          <div className="flex items-center text-skin-muted flex-col justify-center">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 5l7 7-7 7M5 5l7 7-7 7"></path></svg>
          </div>

          <div 
            className="flex-1 flex flex-col gap-1 items-center"
          >
             <span className="text-[9px] text-skin-muted uppercase">{t(lang, 'patchZone')}</span>
             <div 
               className={`w-16 h-16 bg-skin-surface rounded border-2 border-dashed flex items-center justify-center overflow-hidden cursor-pointer outline-none transition-all relative group ${
                 region.status === 'completed' ? 'border-emerald-400 bg-emerald-50/50' : 'border-skin-border hover:border-skin-primary focus:border-skin-primary focus:ring-1 focus:ring-skin-primary/50'
               }`}
               tabIndex={0}
               onPaste={handlePaste}
               title={t(lang, 'pasteHint')}
             >
                {region.processedImageUrl ? (
                  <img src={region.processedImageUrl} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[9px] text-skin-muted text-center px-1">Ctrl+V</span>
                )}
             </div>
             
             <div className={`text-[9px] font-bold py-1 ${
                 region.status === 'completed' ? 'text-emerald-500' :
                 region.status === 'failed' ? 'text-rose-500' :
                 'text-skin-muted'
             }`}>
                {region.status === 'failed' ? t(lang, 'status_failed') : region.status === 'completed' ? 'Done' : 'Empty'}
             </div>
             {showRetryDiagnostics && (region.retryCount ?? 0) > 0 && (
                <div className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">
                   {t(lang, 'retryBadge').replace('{count}', String(region.retryCount))}
                </div>
             )}
          </div>
      </div>

      {showRetryDiagnostics && region.errorHistory && region.errorHistory.length > 0 && (
        <div className="border-t border-skin-border pt-1.5">
          <button
            onClick={() => setErrorHistoryOpen(v => !v)}
            className="text-[10px] text-skin-muted hover:text-skin-primary transition-colors w-full text-left"
          >
            {errorHistoryOpen
              ? t(lang, 'errorHistoryHide')
              : t(lang, 'errorHistoryShow').replace('{count}', String(region.errorHistory.length))}
          </button>
          {errorHistoryOpen && (
            <ol className="mt-1 space-y-1 list-decimal list-inside text-[10px] text-rose-600/90 break-all">
              {region.errorHistory.map((msg, i) => (
                <li key={i} className="leading-tight">{msg}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      
      {/* OCR Section - Only if enabled */}
      {showOcr && (
        <div className="border-t border-skin-border pt-1.5 flex items-center gap-2">
           <button 
              onClick={onOcr}
              disabled={region.isOcrLoading}
              className="text-[9px] px-2 py-0.5 bg-skin-primary/10 text-skin-primary border border-skin-primary/20 rounded hover:bg-skin-primary/20 transition-colors flex items-center gap-1"
           >
              {region.isOcrLoading ? (
                   <svg className="animate-spin w-2.5 h-2.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
              ) : (
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
              )}
              OCR
           </button>
           <span className="text-[9px] text-skin-text truncate flex-1" title={region.ocrText}>
              {region.ocrText || <span className="text-skin-muted italic">{t(lang, 'ocrPlaceholder')}</span>}
           </span>
           {region.ocrText && (
               <button 
                 onClick={() => navigator.clipboard.writeText(region.ocrText || '')}
                 className="text-[9px] text-skin-muted hover:text-skin-primary"
                 title="Copy Text"
               >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
               </button>
           )}
        </div>
      )}
    </div>
  );
};
