
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { UploadedImage, Region, ProcessingStep, AppConfig, Language } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import PatchEditor, { TextObject } from './components/PatchEditor';
import { loadImage, cropRegion, stitchImage, createMaskedFullImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, extractCropFromFullImage, stitchImageInverted, padImageToSquare, depadImageFromSquare, PaddingInfo } from './services/imageUtils';
import { generateRegionEdit, generateTranslation, fetchOpenAIModels } from './services/aiService';
import { detectBubbles, recognizeText } from './services/detectionService';
import { t } from './services/translations';
import { AsyncSemaphore, runWithConcurrency } from './services/concurrencyUtils';
import { useConfig, DEFAULT_TRANSLATION_PROMPT, TRANSLATION_MODE_IMAGE_PROMPT } from './hooks/useConfig';
import { useImageManager } from './hooks/useImageManager';

// --- HELP MODAL COMPONENT ---
const HelpModal = ({ onClose, language }: { onClose: () => void, language: Language }) => {
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

export default function App() {
  const { config, setConfig } = useConfig();
  
  const {
    images,
    setImages,
    selectedImage,
    selectedImageId,
    selectedRegionId,
    setSelectedRegionId,
    viewMode,
    setViewMode,
    addImageFiles,
    handleSelectImage,
    handleUpdateRegions,
    handleUpdateRegionPrompt,
    handleUpdateImagePrompt,
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages, 
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage
  } = useImageManager();

  const [processingState, setProcessingState] = useState<ProcessingStep>(ProcessingStep.IDLE);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  const [transModels, setTransModels] = useState<string[]>([]);
  const [editingRegion, setEditingRegion] = useState<{ 
      imageId: string, 
      regionId: string, 
      startBase64: string,
      initialTextObjects?: TextObject[]
  } | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // Debounce Timer Ref for Heavy Operations
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Operation Version Ref for Race Condition Handling
  const operationVersionRef = useRef<number>(0);

  // Custom wrapper for manual patch updates to handle Full Image row special case
  const handleManualPatchUpdate = (imageId: string, regionId: string, base64: string) => {
    // We can't do async inside the setImages directly cleanly if we want to run extractCropFromFullImage loop
    // So we handle the special case outside setImages first if needed, OR we trigger a side effect.
    
    // For 'special-full-image-mask', we need to update fullAiResultUrl AND update all regions.
    // Since extractCropFromFullImage is async, we should handle it here.
    
    if (regionId === 'special-full-image-mask') {
        const targetImg = images.find(img => img.id === imageId);
        if (!targetImg) return;

        // Start processing the update
        (async () => {
            const updatedRegions: Region[] = [];
            
            // If Inverted Masking, we don't necessarily extract crops for patches (because the result IS the background),
            // but we might still want to mark them completed.
            // If Standard Masking, we MUST extract crops.
            
            if (config.useInvertedMasking) {
                // Inverted Mode: Just mark all as completed
                for (const r of targetImg.regions) {
                    updatedRegions.push({ ...r, status: 'completed' });
                }
                // Also trigger stitch
                const stitchedUrl = await stitchImageInverted(targetImg.previewUrl, base64, updatedRegions);
                
                setImages(prev => prev.map(img => {
                    if (img.id !== imageId) return img;
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = base64;
                    }
                    return { 
                        ...img, 
                        fullAiResultUrl: base64,
                        finalResultUrl: stitchedUrl,
                        regions: updatedRegions, 
                        history: currentHistory 
                    };
                }));
            } else {
                // Standard Mode: Extract all crops
                for (const r of targetImg.regions) {
                    try {
                        const crop = await extractCropFromFullImage(
                            base64, 
                            r, 
                            targetImg.originalWidth, 
                            targetImg.originalHeight,
                            config.fullImageOpaquePercent
                        );
                        updatedRegions.push({ ...r, processedImageBase64: crop, status: 'completed' });
                    } catch (e) {
                        console.error("Failed to extract crop for region", r.id, e);
                        updatedRegions.push({ ...r, status: 'failed' });
                    }
                }
                
                setImages(prev => prev.map(img => {
                    if (img.id !== imageId) return img;
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = base64;
                    }
                    return { 
                        ...img, 
                        fullAiResultUrl: base64,
                        regions: updatedRegions, 
                        history: currentHistory 
                    };
                }));
            }
        })();
        return;
    }

    setImages(prev => {
        return prev.map(img => {
            if (img.id !== imageId) return img;
            
            let updatedRegions: Region[];
            
            // Legacy/Alternative Manual Full Image as a new region (fallback)
            if (regionId === 'manual-full-image') {
               const fullRegion: Region = {
                   id: crypto.randomUUID(),
                   x: 0, y: 0, width: 100, height: 100,
                   type: 'rect',
                   status: 'completed',
                   processedImageBase64: base64,
                   source: 'manual'
               };
               updatedRegions = [...img.regions, fullRegion];
            } else {
               updatedRegions = img.regions.map(r => 
                 r.id === regionId ? { ...r, processedImageBase64: base64, status: 'completed' as const } : r
               );
            }

            const currentHistory = [...img.history];
            if (currentHistory[img.historyIndex]) {
                currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
            }

            return { ...img, regions: updatedRegions, history: currentHistory };
        });
    });
  };

  // --- Interaction Start Handler (Called by EditorCanvas on mousedown) ---
  const handleInteractionStart = useCallback(() => {
      // 1. Cancel any pending debounce timer
      if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
      }
      // 2. Increment version to invalidate any running async operations
      operationVersionRef.current++;
      
      // 3. Clear 'isRecalculating' flags immediately if user starts moving a yellow box
      setImages(prev => prev.map(img => ({
          ...img,
          regions: img.regions.map(r => ({ ...r, isRecalculating: false }))
      })));
  }, [setImages]);

  // --- Regions Update Handler with Auto Stitching ---
  const onRegionsChanged = (imageId: string, newRegions: Region[]) => {
      // 1. Optimistic Update
      handleUpdateRegions(imageId, newRegions);

      // If Inverted Masking is ON, we don't do complex crop extractions on move, because the result IS the background.
      // Changing box size in Inverted Mode technically means "Reveal more/less of the Original".
      // We might need to re-stitch the Inverted Result.
      if (config.useInvertedMasking) {
          const targetImage = images.find(img => img.id === imageId);
          if (targetImage && targetImage.fullAiResultUrl) {
              if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = setTimeout(async () => {
                  const stitchedUrl = await stitchImageInverted(targetImage.previewUrl, targetImage.fullAiResultUrl!, newRegions);
                  setImages(prev => prev.map(img => img.id === imageId ? { ...img, finalResultUrl: stitchedUrl } : img));
              }, 200);
          }
          return;
      }

      const targetImage = images.find(img => img.id === imageId);
      if (!targetImage) return;

      // 2. Debounce Heavy Process
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      operationVersionRef.current++;
      const currentVersion = operationVersionRef.current;

      debounceTimerRef.current = setTimeout(async () => {
          if (operationVersionRef.current !== currentVersion) return;

          // Mark recalculating if needed
          setImages(prev => prev.map(img => {
              if (img.id !== imageId) return img;
              return {
                  ...img,
                  regions: img.regions.map(r => {
                      const changed = newRegions.find(nr => nr.id === r.id && nr.status === 'completed' && img.fullAiResultUrl);
                      return changed ? { ...r, isRecalculating: true } : r;
                  })
              };
          }));

          let hasChanges = false;
          // Re-crop high quality from full result if moved
          const updatedRegions = await Promise.all(newRegions.map(async (newRegion) => {
              if (operationVersionRef.current !== currentVersion) return newRegion;
              
              const oldRegion = targetImage.regions.find(r => r.id === newRegion.id);
              if (newRegion.status === 'completed' && targetImage.fullAiResultUrl && oldRegion) {
                  const posChanged = 
                      Math.abs(newRegion.x - oldRegion.x) > 0.001 ||
                      Math.abs(newRegion.y - oldRegion.y) > 0.001 ||
                      Math.abs(newRegion.width - oldRegion.width) > 0.001 ||
                      Math.abs(newRegion.height - oldRegion.height) > 0.001;

                  if (posChanged) {
                      hasChanges = true;
                      try {
                          const newCrop = await extractCropFromFullImage(
                              targetImage.fullAiResultUrl,
                              newRegion,
                              targetImage.originalWidth,
                              targetImage.originalHeight,
                              config.fullImageOpaquePercent
                          );
                          if (operationVersionRef.current !== currentVersion) return newRegion;
                          return { ...newRegion, processedImageBase64: newCrop, isRecalculating: false };
                      } catch (e) {
                          console.error("Failed to re-extract crop", e);
                          return { ...newRegion, isRecalculating: false };
                      }
                  }
              }
              return { ...newRegion, isRecalculating: false };
          }));

          if (operationVersionRef.current === currentVersion) {
              const finalRegions = hasChanges ? updatedRegions : newRegions;
              // Just update regions, NO AUTO STITCHING (Standard Mode)
              handleUpdateRegions(imageId, finalRegions);
          }
          debounceTimerRef.current = null;
      }, 500);
  };

  // --- Handlers ---
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await addImageFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (let i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                const file = items[i].getAsFile();
                if (file) files.push(file);
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            await addImageFiles(files);
        }
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [addImageFiles]); 

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.matches('input, textarea') || target.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            if (images.length === 0) return;
            const currentIndex = images.findIndex(img => img.id === selectedImageId);
            let newIndex = currentIndex;
            if (currentIndex === -1) {
                newIndex = 0;
            } else {
                if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
                    newIndex = Math.max(0, currentIndex - 1);
                } else {
                    newIndex = Math.min(images.length - 1, currentIndex + 1);
                }
            }
            if (newIndex !== currentIndex) {
                handleSelectImage(images[newIndex].id);
            }
        }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [images, selectedImageId, handleSelectImage]);

  const handleOpenEditor = async (imageId: string, regionId: string) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;

      if (regionId === 'manual-full-image') {
          const textObjects: TextObject[] = img.regions.map((r, index) => {
             const boxH = (r.height / 100) * img.originalHeight;
             const fontSize = Math.max(14, Math.round(boxH * 0.3)); 
             const width = (r.width / 100) * img.originalWidth;
             const height = (r.height / 100) * img.originalHeight;
             return {
                 id: r.id,
                 x: (r.x / 100) * img.originalWidth,
                 y: (r.y / 100) * img.originalHeight,
                 width: width,
                 height: height,
                 text: r.ocrText || `Text ${index + 1}`,
                 fontSize: fontSize,
                 color: '#000000',
                 outlineColor: '#ffffff',
                 outlineWidth: 3,
                 backgroundColor: 'transparent',
                 isVertical: r.height > r.width * 1.5,
                 isBold: true,
                 rotation: 0
             };
          });
          setEditingRegion({
              imageId,
              regionId,
              startBase64: img.finalResultUrl || img.previewUrl,
              initialTextObjects: textObjects
          });
          return;
      }

      const region = img.regions.find(r => r.id === regionId);
      if (!region) return;
      let startBase64 = region.processedImageBase64;
      if (!startBase64) {
         const imgEl = await loadImage(img.previewUrl);
         startBase64 = await cropRegion(imgEl, region);
      }
      let singleTextObj: TextObject[] | undefined = undefined;
      if (region.ocrText) {
          singleTextObj = [{
             id: crypto.randomUUID(),
             x: 10, y: 10,
             text: region.ocrText,
             fontSize: 24,
             color: '#000000',
             outlineColor: '#ffffff',
             outlineWidth: 3,
             backgroundColor: 'transparent',
             isVertical: region.height > region.width * 1.5,
             isBold: true,
             rotation: 0
          }];
      }
      setEditingRegion({ imageId, regionId, startBase64, initialTextObjects: singleTextObj });
  };

  const handleEditorSave = (newBase64: string) => {
      if (editingRegion) {
          handleManualPatchUpdate(editingRegion.imageId, editingRegion.regionId, newBase64);
      }
      setEditingRegion(null);
  };

  const handleOcrRegion = async (imageId: string, regionId: string) => {
     const img = images.find(i => i.id === imageId);
     const region = img?.regions.find(r => r.id === regionId);
     if (!img || !region) return;
     setImages(prev => prev.map(currentImg => 
         currentImg.id === imageId 
           ? {
               ...currentImg,
               regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: true } : r)
             }
           : currentImg
     ));
     try {
         const imgEl = await loadImage(img.previewUrl);
         const crop = await cropRegion(imgEl, region);
         const text = await recognizeText(crop, config);
         setImages(prev => prev.map(currentImg => 
            currentImg.id === imageId 
              ? {
                  ...currentImg,
                  regions: currentImg.regions.map(r => r.id === regionId ? { ...r, ocrText: text, isOcrLoading: false } : r)
                }
              : currentImg
         ));
     } catch (e: any) {
         setErrorMsg("OCR Error: " + e.message);
         setImages(prev => prev.map(currentImg => 
            currentImg.id === imageId 
              ? {
                  ...currentImg,
                  regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: false } : r)
                }
              : currentImg
         ));
     }
  };

  const handleAutoDetect = async (scope: 'current' | 'all') => {
     setIsDetecting(true);
     setErrorMsg(null);
     const controller = new AbortController();
     abortControllerRef.current = controller;
     try {
         const targets = scope === 'current' 
            ? (selectedImage ? [selectedImage] : [])
            : images.filter(img => !img.isSkipped);
         if (targets.length === 0) {
            setIsDetecting(false);
            return;
         }
         const detectTask = async (img: UploadedImage) => {
            try {
                const newRegions = await detectBubbles(img.previewUrl, config);
                if (newRegions.length > 0) {
                    setImages(prev => prev.map(currentImg => 
                        currentImg.id === img.id 
                           ? { ...currentImg, regions: [...currentImg.regions, ...newRegions] }
                           : currentImg
                    ));
                }
            } catch (e: any) {
                console.error(`Detection failed for ${img.file.name}:`, e);
            }
         };
         await runWithConcurrency(targets, config.concurrencyLimit, detectTask, controller.signal, 0);
     } catch (e: any) {
         setErrorMsg("Detection Error: " + e.message);
     } finally {
         setIsDetecting(false);
         abortControllerRef.current = null;
     }
  };

  // --- CORE PROCESSING LOGIC ---
  const processSingleImage = async (imageSnapshot: UploadedImage, signal: AbortSignal, globalSemaphore: AsyncSemaphore) => {
    if (signal.aborted) return;
    if (imageSnapshot.isSkipped) return;

    const regionsMap = new Map<string, Region>();
    imageSnapshot.regions.forEach(r => regionsMap.set(r.id, r));

    let initialRegions = [...imageSnapshot.regions];
    if (initialRegions.length === 0 && config.processFullImageIfNoRegions) {
        const fullRegion: Region = {
            id: crypto.randomUUID(),
            x: 0, y: 0, width: 100, height: 100,
            type: 'rect',
            status: 'pending',
            source: 'manual'
        };
        initialRegions = [fullRegion];
        regionsMap.set(fullRegion.id, fullRegion);
        setImages(prev => prev.map(img => 
            img.id === imageSnapshot.id ? { ...img, regions: initialRegions } : img
        ));
    }

    const regionsToProcess = Array.from(regionsMap.values()).filter(r => r.status === 'pending' || r.status === 'failed');
    if (regionsToProcess.length === 0) return;

    const imgElement = await loadImage(imageSnapshot.previewUrl);
    regionsToProcess.forEach(r => regionsMap.set(r.id, { ...r, status: 'processing' }));
    setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));

    if (signal.aborted) return;
    setProcessingState(ProcessingStep.CROPPING);

    if (config.useFullImageMasking) {
        await globalSemaphore.acquire();
        try {
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
            
            // Handle Inverted Masking
            let inputImageBase64;
            if (config.useInvertedMasking) {
                inputImageBase64 = createInvertedMultiMaskedFullImage(imgElement, regionsToProcess);
            } else {
                inputImageBase64 = createMultiMaskedFullImage(imgElement, regionsToProcess);
            }

            // Square Fill Logic
            let payloadBase64 = inputImageBase64;
            let paddingInfo: PaddingInfo | null = null;
            if (config.enableSquareFill) {
                const padded = await padImageToSquare(inputImageBase64);
                payloadBase64 = padded.base64;
                paddingInfo = padded.info;
            }

            let translationText = '';
            if (config.enableTranslationMode) {
               setProcessingState(ProcessingStep.API_CALLING); 
               // Use payload (padded or not) for translation too
               translationText = await generateTranslation(payloadBase64, config, signal);
            }
            setProcessingState(ProcessingStep.API_CALLING);
            let basePrompt = config.prompt.trim();
            if (imageSnapshot.customPrompt) {
               basePrompt = imageSnapshot.customPrompt.trim();
            }
            let effectivePrompt = basePrompt;
            if (translationText) {
                effectivePrompt += `\n\n以下是为你提供的图片文字以及文字在图上的坐标/位置数据，请参考：\n${translationText}`;
            }
            let apiResultBase64 = await generateRegionEdit(payloadBase64, effectivePrompt, config, signal);
            
            // Depad Square Logic
            if (config.enableSquareFill && paddingInfo) {
                apiResultBase64 = await depadImageFromSquare(apiResultBase64, paddingInfo);
            }

            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

            if (config.useInvertedMasking) {
                // Inverted Mode: The result IS the background.
                // We stitch immediately because EditorCanvas doesn't support floating 'Background' patches.
                const stitchedUrl = await stitchImageInverted(imageSnapshot.previewUrl, apiResultBase64, regionsToProcess);
                
                // For regions, we mark them completed but they don't really hold the 'patch' content in this mode.
                regionsToProcess.forEach(r => {
                    regionsMap.set(r.id, { ...r, status: 'completed' as const });
                });
                const currentAllRegions = Array.from(regionsMap.values());

                setImages(prev => prev.map(img => {
                    if (img.id !== imageSnapshot.id) return img;
                    const updatedHistory = [...img.history];
                    if (updatedHistory[img.historyIndex]) {
                       updatedHistory[img.historyIndex].fullAiResultUrl = apiResultBase64;
                    }
                    return { 
                        ...img, 
                        fullAiResultUrl: apiResultBase64, 
                        finalResultUrl: stitchedUrl,
                        regions: currentAllRegions, 
                        history: updatedHistory 
                    };
                }));
            } else {
                // Standard Masking Mode
                for (const region of regionsToProcess) {
                    const finalRegionImageBase64 = await extractCropFromFullImage(
                        apiResultBase64, 
                        region, 
                        imgElement.naturalWidth, 
                        imgElement.naturalHeight,
                        config.fullImageOpaquePercent
                    );
                    const completedRegion = { ...region, processedImageBase64: finalRegionImageBase64, status: 'completed' as const };
                    regionsMap.set(region.id, completedRegion);
                }

                // NO AUTO STITCHING HERE (Standard Mode)
                const currentAllRegions = Array.from(regionsMap.values());
                
                setImages(prev => prev.map(img => {
                    if (img.id !== imageSnapshot.id) return img;
                    const updatedHistory = [...img.history];
                    if (updatedHistory[img.historyIndex]) {
                       updatedHistory[img.historyIndex].fullAiResultUrl = apiResultBase64;
                    }
                    return { ...img, fullAiResultUrl: apiResultBase64, regions: currentAllRegions, history: updatedHistory };
                }));
            }
        } catch (err: any) {
            if (err.name !== 'AbortError') {
                regionsToProcess.forEach(r => {
                    regionsMap.set(r.id, { ...r, status: 'failed' as const });
                });
                setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));
            }
        } finally {
            globalSemaphore.release();
        }
        return;
    }

    // LEGACY / SINGLE REGION PROCESSING (Standard Mode Only)
    const processRegionTask = async (region: Region) => {
        if (signal.aborted) return;
        await globalSemaphore.acquire();
        try {
            if (signal.aborted) return;
            const inputImageBase64 = await cropRegion(imgElement, region);
            
            // Square Fill Logic
            let payloadBase64 = inputImageBase64;
            let paddingInfo: PaddingInfo | null = null;
            if (config.enableSquareFill) {
                const padded = await padImageToSquare(inputImageBase64);
                payloadBase64 = padded.base64;
                paddingInfo = padded.info;
            }

            if (signal.aborted) return;
            let translationText = '';
            if (config.enableTranslationMode) {
               setProcessingState(ProcessingStep.API_CALLING); 
               translationText = await generateTranslation(payloadBase64, config, signal);
            }
            setProcessingState(ProcessingStep.API_CALLING);
            let basePrompt = config.prompt.trim();
            if (imageSnapshot.regions.length === 0 && config.processFullImageIfNoRegions && imageSnapshot.customPrompt) {
               basePrompt = imageSnapshot.customPrompt.trim();
            }
            const regionSpecificPrompt = region.customPrompt ? region.customPrompt.trim() : '';
            let effectivePrompt = basePrompt;
            if (regionSpecificPrompt) {
                effectivePrompt += ` ${regionSpecificPrompt}`;
            }
            if (translationText) {
                effectivePrompt += `\n\n以下是为你提供的图片文字以及文字在图上的坐标/位置数据，请参考：\n${translationText}`;
            }
            let apiResultBase64 = await generateRegionEdit(payloadBase64, effectivePrompt, config, signal);
            
            // Depad Square Logic
            if (config.enableSquareFill && paddingInfo) {
                apiResultBase64 = await depadImageFromSquare(apiResultBase64, paddingInfo);
            }

            if (signal.aborted) return;
            const completedRegion = { ...region, processedImageBase64: apiResultBase64, status: 'completed' as const };
            regionsMap.set(region.id, completedRegion);
            
            // NO AUTO STITCHING
            const currentAllRegions = Array.from(regionsMap.values());
            
            setImages(prev => prev.map(img => {
                if (img.id !== imageSnapshot.id) return img;
                return { ...img, regions: currentAllRegions };
            }));
        } catch (err: any) {
            if (err.name === 'AbortError') return;
            const failedRegion = { ...region, status: 'failed' as const };
            regionsMap.set(region.id, failedRegion);
            setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));
        } finally {
            globalSemaphore.release();
        }
    };
    await runWithConcurrency(regionsToProcess, config.concurrencyLimit, processRegionTask, signal, 0);
  };

  const handleStop = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
      }
      setImages(prev => prev.map(img => ({
          ...img,
          regions: img.regions.map(r => r.status === 'processing' ? { ...r, status: 'pending' } : r)
      })));
      setProcessingState(ProcessingStep.IDLE);
      setErrorMsg(t(config.language, 'stopped_by_user'));
  };

  const handleProcess = async (processAll: boolean) => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setProcessingState(ProcessingStep.CROPPING);
    setErrorMsg(null);
    const targets: UploadedImage[] = processAll 
        ? images.filter(img => !img.isSkipped)
        : (selectedImage ? [selectedImage] : []);
    if (targets.length === 0) {
        setProcessingState(ProcessingStep.IDLE);
        return;
    }
    const actualLimit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
    const globalSemaphore = new AsyncSemaphore(actualLimit);
    try {
        if (config.executionMode === 'concurrent') {
            await runWithConcurrency<UploadedImage, void>(
                targets, 
                config.concurrencyLimit, 
                (img) => processSingleImage(img, controller.signal, globalSemaphore),
                controller.signal, 0 
            );
        } else {
            for (const img of targets) {
                if (controller.signal.aborted) break;
                await processSingleImage(img, controller.signal, globalSemaphore);
            }
        }
        if (controller.signal.aborted) setErrorMsg(t(config.language, 'stopped_by_user'));
        setProcessingState(ProcessingStep.DONE);
    } catch (e: any) {
        if (e.name !== 'AbortError') {
             setErrorMsg(e.message || "Unknown error occurred");
        }
        setProcessingState(ProcessingStep.IDLE);
    }
  };

  // ON-DEMAND STITCHING for Download
  const handleDownload = async () => {
      if (!selectedImage) return;
      try {
          let stitchedUrl: string;
          if (config.useInvertedMasking && selectedImage.fullAiResultUrl) {
              stitchedUrl = await stitchImageInverted(selectedImage.previewUrl, selectedImage.fullAiResultUrl, selectedImage.regions);
          } else {
              stitchedUrl = await stitchImage(selectedImage.previewUrl, selectedImage.regions);
          }
          const link = document.createElement('a');
          link.href = stitchedUrl;
          link.download = `patched_${selectedImage.file.name}`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
      } catch (e) {
          console.error("Failed to stitch for download", e);
          setErrorMsg("Failed to generate download image.");
      }
  };
  
  // ON-DEMAND STITCHING for Apply
  const handleApplyAsOriginalWrapper = async () => {
      if (!selectedImage) return;
      try {
          // Perform stitch only when applying
          let stitchedUrl: string;
          if (config.useInvertedMasking && selectedImage.fullAiResultUrl) {
              stitchedUrl = await stitchImageInverted(selectedImage.previewUrl, selectedImage.fullAiResultUrl, selectedImage.regions);
          } else {
              stitchedUrl = await stitchImage(selectedImage.previewUrl, selectedImage.regions);
          }
          handleApplyResultAsOriginal(selectedImage.id, stitchedUrl);
      } catch (e) {
          console.error("Failed to stitch for apply", e);
          setErrorMsg("Failed to apply changes.");
      }
  };

  // --- REFINEMENT HANDLER (Scroll to adjust box) ---
  const handleAdjustRegion = useCallback(async (imageId: string, regionId: string, isExpand: boolean) => {
      const img = images.find(i => i.id === imageId);
      if (!img || !img.fullAiResultUrl) return;
      
      const region = img.regions.find(r => r.id === regionId);
      if (!region || region.status !== 'completed') return;

      const step = 1.0; 
      const direction = isExpand ? 1 : -1;
      
      let newX = region.x - (step * direction);
      let newY = region.y - (step * direction);
      let newW = region.width + (step * 2 * direction);
      let newH = region.height + (step * 2 * direction);

      if (newW < 1) return;
      if (newH < 1) return;
      if (newX < 0) { newW += newX; newX = 0; }
      if (newY < 0) { newH += newY; newY = 0; }
      if (newX + newW > 100) newW = 100 - newX;
      if (newY + newH > 100) newH = 100 - newY;

      const updatedRegions = img.regions.map(r => 
        r.id === regionId 
          ? { ...r, x: newX, y: newY, width: newW, height: newH } 
          : r
      );
      handleUpdateRegions(imageId, updatedRegions);

      // Inverted Mode Refinement
      if (config.useInvertedMasking) {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(async () => {
              const stitchedUrl = await stitchImageInverted(img.previewUrl, img.fullAiResultUrl!, updatedRegions);
              setImages(prev => prev.map(i => i.id === imageId ? { ...i, finalResultUrl: stitchedUrl } : i));
          }, 200);
          return;
      }

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      
      operationVersionRef.current++;
      const currentVersion = operationVersionRef.current;
      
      debounceTimerRef.current = setTimeout(async () => {
          if (operationVersionRef.current !== currentVersion) return;

          setImages(prev => prev.map(i => {
              if (i.id !== imageId) return i;
              return {
                  ...i,
                  regions: i.regions.map(r => r.id === regionId ? { ...r, isRecalculating: true } : r)
              };
          }));

          try {
              const newCropBase64 = await extractCropFromFullImage(
                  img.fullAiResultUrl!,
                  { ...region, x: newX, y: newY, width: newW, height: newH },
                  img.originalWidth,
                  img.originalHeight,
                  config.fullImageOpaquePercent
              );

              if (operationVersionRef.current !== currentVersion) return;

              const finalRegions = img.regions.map(r => 
                r.id === regionId 
                  ? { ...r, x: newX, y: newY, width: newW, height: newH, processedImageBase64: newCropBase64, isRecalculating: false } 
                  : { ...r, isRecalculating: false }
              );
              
              handleUpdateRegions(imageId, finalRegions);
              
              // NO AUTO STITCH
              
          } catch (e) {
              console.error("Adjustment processing failed", e);
              setImages(prev => prev.map(i => ({
                  ...i,
                  regions: i.regions.map(r => ({ ...r, isRecalculating: false }))
              })));
          }
          debounceTimerRef.current = null;
      }, 500); 
  }, [images, config.fullImageOpaquePercent, config.useInvertedMasking, handleUpdateRegions, setImages]);

  // --- DRAG & DROP ---
  const onDragEnter = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
       await addImageFiles(Array.from(e.dataTransfer.files));
    }
  };

  const updateConfig = (key: keyof AppConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
  };

  const fetchTransModels = async () => {
      if (!config.translationBaseUrl || !config.translationApiKey) return;
      try {
          const models = await fetchOpenAIModels(config.translationBaseUrl, config.translationApiKey);
          setTransModels(models);
      } catch(e) { console.error(e); }
  };

  const showEditor = config.enableMangaMode && config.enableManualEditor;

  return (
    <div 
      className="flex h-screen w-screen bg-skin-fill text-skin-text overflow-hidden font-sans relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        selectedRegionId={selectedRegionId}
        onSelectImage={handleSelectImage}
        onUpload={handleUpload}
        onProcess={handleProcess}
        onStop={handleStop}
        processingState={processingState}
        currentImage={selectedImage}
        onDownload={handleDownload}
        onManualPatchUpdate={handleManualPatchUpdate}
        onUpdateRegionPrompt={handleUpdateRegionPrompt}
        onUpdateImagePrompt={handleUpdateImagePrompt}
        onDeleteImage={handleDeleteImage}
        onClearAllImages={handleClearAllImages} 
        onToggleSkip={handleToggleSkip}
        onAutoDetect={handleAutoDetect}
        isDetecting={isDetecting}
        onOpenEditor={(imageId, regionId) => handleOpenEditor(imageId, regionId)} 
        onOcrRegion={(imageId, regionId) => handleOcrRegion(imageId, regionId)}
        onOpenGlobalSettings={() => setShowGlobalSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
        showEditor={showEditor} 
        onApplyAsOriginal={handleApplyAsOriginalWrapper} 
      />
      
      <main className="flex-1 relative bg-checkerboard flex flex-col">
        {selectedImage ? (
           <>
             <div className="absolute top-4 left-4 z-10 flex gap-2">
                 <button 
                   onClick={() => setViewMode('original')}
                   className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'original' ? 'bg-skin-primary text-skin-primary-fg border-skin-primary' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                 >
                   {t(config.language, 'readyToCreate')}
                 </button>
                 {(selectedImage.regions.some(r => r.status === 'completed') || selectedImage.isSkipped || selectedImage.finalResultUrl) && (
                    <button 
                        onClick={() => setViewMode('result')}
                        className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'result' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                    >
                        {t(config.language, 'status_completed')}
                    </button>
                 )}
                 {selectedImage.isSkipped && (
                     <span className="px-3 py-1.5 rounded-full text-xs font-bold bg-zinc-500 text-white border border-zinc-500 backdrop-blur-md shadow-sm">
                        {t(config.language, 'skipped')}
                     </span>
                 )}

                 <div className="flex gap-1 ml-2 border-l border-white/20 pl-2">
                    <button
                        onClick={() => handleUndoImage(selectedImage.id)}
                        disabled={selectedImage.historyIndex <= 0}
                        className="px-2 py-1.5 rounded-full bg-skin-surface/80 hover:bg-white text-skin-text disabled:opacity-40 disabled:hover:bg-skin-surface/80 border border-skin-border backdrop-blur-md shadow-sm transition-all"
                        title={t(config.language, 'undoImage')}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                    </button>
                    <button
                        onClick={() => handleRedoImage(selectedImage.id)}
                        disabled={selectedImage.historyIndex >= selectedImage.history.length - 1}
                        className="px-2 py-1.5 rounded-full bg-skin-surface/80 hover:bg-white text-skin-text disabled:opacity-40 disabled:hover:bg-skin-surface/80 border border-skin-border backdrop-blur-md shadow-sm transition-all"
                        title={t(config.language, 'redoImage')}
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"></path></svg>
                    </button>
                 </div>
             </div>

             {viewMode === 'result' && config.useInvertedMasking && selectedImage.finalResultUrl ? (
                 // Special Render for Inverted Mode Result: Just the full stitched image
                 <div className="w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
                    <div className="relative shadow-xl">
                        <img 
                            src={selectedImage.finalResultUrl} 
                            className="max-h-[85vh] max-w-full block object-contain pointer-events-none rounded bg-skin-surface shadow-sm ring-1 ring-skin-border"
                            alt="Result"
                        />
                    </div>
                 </div>
             ) : (
                 // Standard Mode (Original & Result using EditorCanvas) or Inverted Mode Original
                 <EditorCanvas
                    image={selectedImage}
                    onUpdateRegions={(imageId, newRegions) => onRegionsChanged(imageId, newRegions)}
                    disabled={processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE}
                    language={config.language}
                    onOpenEditor={(regionId) => handleOpenEditor(selectedImage.id, regionId)}
                    selectedRegionId={selectedRegionId}
                    onSelectRegion={setSelectedRegionId}
                    onOcrRegion={(regionId) => handleOcrRegion(selectedImage.id, regionId)}
                    showOcrButton={config.enableMangaMode && config.enableOCR}
                    showEditorButton={showEditor}
                    onAdjustRegionSize={(regionId, isExpand) => handleAdjustRegion(selectedImage.id, regionId, isExpand)}
                    onInteractionStart={handleInteractionStart}
                    viewMode={viewMode}
                />
             )}
           </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-skin-muted select-none">
            <div className="w-24 h-24 mb-4 rounded-3xl bg-skin-surface border-2 border-dashed border-skin-border flex items-center justify-center animate-pulse">
                <svg className="w-10 h-10 text-skin-border" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"></path></svg>
            </div>
            <p className="text-lg font-medium">{t(config.language, 'readyToCreate')}</p>
            <p className="text-sm opacity-60">{t(config.language, 'uploadHint')}</p>
          </div>
        )}

        {errorMsg && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-rose-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2 z-50">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-2 opacity-80 hover:opacity-100">✕</button>
            </div>
        )}
      </main>
      
      {editingRegion && (
         <PatchEditor 
            imageBase64={editingRegion.startBase64}
            onSave={handleEditorSave}
            onCancel={() => setEditingRegion(null)}
            language={config.language}
            initialTextObjects={editingRegion.initialTextObjects}
            defaultVertical={config.enableVerticalTextDefault}
         />
      )}

      {showGlobalSettings && (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
           {/* Global Settings Content (Same as previous) */}
           <div className="bg-skin-surface max-w-sm w-full rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
              <div className="p-4 border-b border-skin-border flex justify-between items-center">
                 <h3 className="font-bold text-lg">{t(config.language, 'globalSettings')}</h3>
                 <button onClick={() => setShowGlobalSettings(false)} className="p-1 hover:bg-skin-fill rounded">✕</button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
                  <div className="flex items-center justify-between">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'enableMangaMode')}</div>
                          <div className="text-xs text-skin-muted">{t(config.language, 'enableMangaModeDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={config.enableMangaMode}
                            onChange={(e) => updateConfig('enableMangaMode', e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.enableMangaMode && (
                     <div className="pl-4 border-l-2 border-skin-border space-y-4 mt-4">
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableBubbleDetection')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableBubbleDetectionDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    className="sr-only peer"
                                    checked={config.enableBubbleDetection}
                                    onChange={(e) => updateConfig('enableBubbleDetection', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableOCR')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableOCRDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    className="sr-only peer"
                                    checked={config.enableOCR}
                                    onChange={(e) => updateConfig('enableOCR', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableManualEditor')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'enableManualEditorDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    className="sr-only peer"
                                    checked={config.enableManualEditor}
                                    onChange={(e) => updateConfig('enableManualEditor', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                         {config.enableManualEditor && (
                             <div className="flex items-center justify-between">
                                <div>
                                    <div className="text-xs font-bold text-skin-text">{t(config.language, 'enableVerticalTextDefault')}</div>
                                    <div className="text-[10px] text-skin-muted">{t(config.language, 'enableVerticalTextDefaultDesc')}</div>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input 
                                        type="checkbox" 
                                        className="sr-only peer"
                                        checked={config.enableVerticalTextDefault}
                                        onChange={(e) => updateConfig('enableVerticalTextDefault', e.target.checked)}
                                    />
                                    <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                                </label>
                             </div>
                         )}
                     </div>
                  )}
                  <div className="flex items-center justify-between border-t border-skin-border pt-4 mt-4">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'useFullImageMasking')}</div>
                          <div className="text-xs text-skin-muted max-w-[200px]">{t(config.language, 'useFullImageMaskingDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={config.useFullImageMasking}
                            onChange={(e) => updateConfig('useFullImageMasking', e.target.checked)}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.useFullImageMasking && (
                      <div className="pl-4 border-l-2 border-skin-border space-y-4 mt-4 animate-in fade-in slide-in-from-top-1">
                          <div className="flex items-center justify-between">
                            <div>
                                <div className="text-xs font-bold text-skin-text">{t(config.language, 'useInvertedMasking')}</div>
                                <div className="text-[10px] text-skin-muted">{t(config.language, 'useInvertedMaskingDesc')}</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input 
                                    type="checkbox" 
                                    className="sr-only peer"
                                    checked={config.useInvertedMasking}
                                    onChange={(e) => updateConfig('useInvertedMasking', e.target.checked)}
                                />
                                <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-skin-primary"></div>
                            </label>
                         </div>
                      
                          <div className="bg-skin-fill/30 p-3 rounded-lg border border-skin-border space-y-2">
                              <label className="text-[10px] uppercase font-bold text-skin-muted block">{t(config.language, 'fullImageOpaquePercent')}</label>
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
                              <p className="text-[10px] text-skin-muted leading-tight">{t(config.language, 'fullImageOpaquePercentDesc')}</p>
                          </div>
                      </div>
                  )}
                  <div className="flex items-center justify-between border-t border-skin-border pt-4 mt-4">
                      <div>
                          <div className="text-sm font-bold text-skin-text">{t(config.language, 'enableTranslationMode')}</div>
                          <div className="text-xs text-skin-muted max-w-[200px]">{t(config.language, 'enableTranslationModeDesc')}</div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input 
                            type="checkbox" 
                            className="sr-only peer"
                            checked={config.enableTranslationMode}
                            onChange={(e) => {
                                const enabled = e.target.checked;
                                setConfig(prev => ({ 
                                    ...prev, 
                                    enableTranslationMode: enabled,
                                    prompt: enabled ? TRANSLATION_MODE_IMAGE_PROMPT : prev.prompt
                                }));
                            }}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-skin-primary"></div>
                      </label>
                  </div>
                  {config.enableTranslationMode && (
                      <div className="bg-skin-fill/30 p-3 rounded-lg border border-skin-border space-y-3 animate-in fade-in slide-in-from-top-2">
                          <h4 className="text-xs font-bold text-skin-text uppercase tracking-wider">{t(config.language, 'translationSettings')}</h4>
                          <div>
                              <label className="text-[10px] text-skin-muted block mb-1">{t(config.language, 'baseUrl')}</label>
                              <input 
                                  type="text" 
                                  value={config.translationBaseUrl}
                                  onChange={(e) => updateConfig('translationBaseUrl', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                              />
                          </div>
                          <div>
                              <label className="text-[10px] text-skin-muted block mb-1">{t(config.language, 'apiKey')}</label>
                              <input 
                                  type="password" 
                                  value={config.translationApiKey}
                                  onChange={(e) => updateConfig('translationApiKey', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                              />
                          </div>
                          <div>
                              <div className="flex justify-between items-center mb-1">
                                <label className="text-[10px] text-skin-muted block">{t(config.language, 'model')}</label>
                                <button onClick={fetchTransModels} className="text-[10px] text-skin-primary hover:underline">{t(config.language, 'fetchList')}</button>
                              </div>
                              <div className="relative">
                                  <input 
                                      type="text" 
                                      value={config.translationModel}
                                      onChange={(e) => updateConfig('translationModel', e.target.value)}
                                      className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50"
                                  />
                                  {transModels.length > 0 && (
                                      <div className="mt-1 max-h-24 overflow-y-auto border border-skin-border rounded bg-skin-surface absolute z-10 w-full shadow-lg">
                                          {transModels.map(m => (
                                              <div 
                                                key={m} 
                                                onClick={() => { updateConfig('translationModel', m); setTransModels([]); }}
                                                className="px-2 py-1 text-[10px] hover:bg-skin-fill cursor-pointer truncate"
                                              >
                                                  {m}
                                              </div>
                                          ))}
                                      </div>
                                  )}
                              </div>
                          </div>
                          <div>
                              <div className="flex justify-between items-center mb-1">
                                  <label className="text-[10px] text-skin-muted block">{t(config.language, 'translationPromptLabel')}</label>
                                  <button 
                                      onClick={() => updateConfig('translationPrompt', DEFAULT_TRANSLATION_PROMPT)}
                                      className="text-[9px] text-skin-primary hover:underline bg-transparent border-0 cursor-pointer flex items-center gap-1"
                                      title={t(config.language, 'resetToDefault')}
                                  >
                                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                                      {t(config.language, 'reset')}
                                  </button>
                              </div>
                              <textarea 
                                  value={config.translationPrompt}
                                  onChange={(e) => updateConfig('translationPrompt', e.target.value)}
                                  className="w-full p-2 text-xs border border-skin-border rounded bg-skin-surface focus:ring-1 focus:ring-skin-primary/50 h-24 resize-none shadow-sm"
                                  placeholder={t(config.language, 'translationPromptPlaceholder')}
                              />
                          </div>
                      </div>
                  )}
              </div>
              <div className="p-4 border-t border-skin-border bg-skin-fill/30">
                  <button onClick={() => setShowGlobalSettings(false)} className="w-full py-2 bg-skin-primary text-skin-primary-fg rounded-lg font-bold">
                     {t(config.language, 'close')}
                  </button>
              </div>
           </div>
        </div>
      )}
      {showHelp && (
          <HelpModal onClose={() => setShowHelp(false)} language={config.language} />
      )}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-skin-fill/80 backdrop-blur-sm flex items-center justify-center animate-in fade-in duration-200 pointer-events-none">
           <div className="w-[80%] h-[80%] border-4 border-dashed border-skin-primary rounded-3xl flex flex-col items-center justify-center text-skin-primary">
              <svg className="w-24 h-24 mb-4 animate-bounce" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
              <h2 className="text-3xl font-bold">{t(config.language, 'dropToUpload')}</h2>
           </div>
        </div>
      )}
    </div>
  );
}