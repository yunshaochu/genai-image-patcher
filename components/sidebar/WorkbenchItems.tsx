
import React, { useState, useEffect } from 'react';
import { UploadedImage, AppConfig, Region } from '../../types';
import { t } from '../../services/translations';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion } from '../../services/imageUtils';

export const FullImageMaskRow: React.FC<{
  image: UploadedImage;
  config: AppConfig;
  onPatchUpdate: (base64: string) => void;
  onOpenEditor: () => void;
  showEditor: boolean;
}> = ({ image, config, onPatchUpdate, onOpenEditor, showEditor }) => {
  const [maskedPreview, setMaskedPreview] = useState<string | null>(null);
  
  useEffect(() => {
    let active = true;
    const generatePreview = async () => {
      try {
        const imgEl = await loadImage(image.previewUrl);
        let preview: string;
        if (config.useInvertedMasking) {
            preview = createInvertedMultiMaskedFullImage(imgEl, image.regions);
        } else {
            preview = createMultiMaskedFullImage(imgEl, image.regions);
        }
        if (active) setMaskedPreview(preview);
      } catch (e) {
        console.error("Failed to create masked preview", e);
      }
    };
    generatePreview();
    return () => { active = false; };
  }, [image.previewUrl, image.regions, config.useInvertedMasking, config.useFullImageMasking]);

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
                onPatchUpdate(evt.target.result as string);
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
             <button 
                onClick={async () => {
                    if (maskedPreview) {
                        try {
                            const res = await fetch(maskedPreview);
                            const blob = await res.blob();
                            await navigator.clipboard.write([new ClipboardItem({[blob.type]: blob})]);
                        } catch(e) { console.error(e); }
                    }
                }}
                disabled={!maskedPreview}
                className="w-full text-[9px] px-1 py-1 bg-skin-surface border border-skin-border rounded hover:bg-skin-fill transition-colors text-center truncate"
             >
                {t(config.language, 'copyCrop')}
             </button>
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
                
                {showEditor && (
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <button 
                            onClick={(e) => { e.stopPropagation(); onOpenEditor(); }}
                            className="p-1 rounded bg-white text-skin-primary shadow-sm hover:scale-110 transition-transform"
                            title={t(config.language, 'editor_title')}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                        </button>
                    </div>
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
  onPatchUpdate: (base64: string) => void;
  lang: 'zh' | 'en';
  onOpenEditor: () => void;
  onOcr: () => void;
  showOcr: boolean;
  showEditor: boolean;
}> = ({ region, image, onPatchUpdate, lang, onOpenEditor, onOcr, showOcr, showEditor }) => {
  const [sourceCrop, setSourceCrop] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    const generateCrop = async () => {
      try {
        const imgEl = await loadImage(image.previewUrl);
        const crop = await cropRegion(imgEl, region);
        if (active) setSourceCrop(crop);
      } catch (e) {
        console.error("Failed to crop for manual view", e);
      }
    };
    generateCrop();
    return () => { active = false; };
  }, [image.previewUrl, region]);

  const handleCopy = async () => {
    if (!sourceCrop) return;
    try {
      const response = await fetch(sourceCrop);
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error("Copy failed", e);
      alert("Browser blocked copy. Please right click image to copy.");
    }
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
                onPatchUpdate(evt.target.result as string);
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
                   className="flex-1 text-[9px] px-1 py-1 bg-skin-surface border border-skin-border rounded hover:bg-skin-fill transition-colors text-center truncate"
                   title={t(lang, 'copyCrop')}
                 >
                   {copied ? t(lang, 'copied') : t(lang, 'copyCrop')}
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
                {region.processedImageBase64 ? (
                  <img src={region.processedImageBase64} className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[9px] text-skin-muted text-center px-1">Ctrl+V</span>
                )}
                
                {/* Only show Editor button if showEditor is true */}
                {showEditor && (
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <button 
                            onClick={(e) => { e.stopPropagation(); onOpenEditor(); }}
                            className="p-1 rounded bg-white text-skin-primary shadow-sm hover:scale-110 transition-transform"
                            title={t(lang, 'editor_title')}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                        </button>
                    </div>
                )}
             </div>
             
             <div className={`text-[9px] font-bold py-1 ${
                 region.status === 'completed' ? 'text-emerald-500' : 
                 region.status === 'failed' ? 'text-rose-500' :
                 'text-skin-muted'
             }`}>
                {region.status === 'failed' ? t(lang, 'status_failed') : region.status === 'completed' ? 'Done' : 'Empty'}
             </div>
          </div>
      </div>
      
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
