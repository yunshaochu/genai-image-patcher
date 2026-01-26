import React, { useState, useRef, useEffect } from 'react';
import { UploadedImage, Region, ProcessingStep, AppConfig } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import PatchEditor, { TextObject } from './components/PatchEditor';
import { loadImage, cropRegion, stitchImage } from './services/imageUtils';
import { generateRegionEdit } from './services/aiService';
import { detectBubbles, recognizeText } from './services/detectionService';
import { t } from './services/translations';
import { AsyncSemaphore, runWithConcurrency } from './services/concurrencyUtils';
import { useConfig } from './hooks/useConfig';
import { useImageManager } from './hooks/useImageManager';

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
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages, // Added
    handleManualPatchUpdate,
    // History Actions
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
  
  // Editor State
  const [editingRegion, setEditingRegion] = useState<{ 
      imageId: string, 
      regionId: string, 
      startBase64: string,
      initialTextObjects?: TextObject[] // New: Pass initial text when opening full editor
  } | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);

  // --- File Upload Handlers ---
  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      await addImageFiles(Array.from(e.target.files));
    }
    e.target.value = '';
  };

  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
           return;
        }
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

  // --- EDITOR HANDLERS ---
  const handleOpenEditor = async (imageId: string, regionId: string) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;

      if (regionId === 'manual-full-image') {
          // CONVERT REGIONS TO TEXT OBJECTS
          const textObjects: TextObject[] = img.regions.map((r, index) => {
             // Basic heuristic for font size based on box height (approx 1/2 of height is text body)
             // We convert percentage coords to pixels
             const boxH = (r.height / 100) * img.originalHeight;
             const fontSize = Math.max(14, Math.round(boxH * 0.3)); 
             const width = (r.width / 100) * img.originalWidth;
             const height = (r.height / 100) * img.originalHeight;
             
             return {
                 id: r.id, // Reuse region ID to potentially link back later
                 x: (r.x / 100) * img.originalWidth,
                 y: (r.y / 100) * img.originalHeight,
                 width: width,
                 height: height,
                 text: r.ocrText || `Text ${index + 1}`, // Default text so the box is visible
                 fontSize: fontSize,
                 color: '#000000',
                 outlineColor: '#ffffff',
                 outlineWidth: 3,
                 backgroundColor: 'transparent',
                 isVertical: r.height > r.width * 1.5, // Simple heuristic for vertical text
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
      
      // If editing a single region, check if it has OCR text to prepopulate
      let singleTextObj: TextObject[] | undefined = undefined;
      if (region.ocrText) {
          singleTextObj = [{
             id: crypto.randomUUID(),
             x: 10, y: 10, // Relative to the crop, hard to guess perfect center without crop dim calc
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

  // --- OCR HANDLER ---
  const handleOcrRegion = async (imageId: string, regionId: string) => {
     const img = images.find(i => i.id === imageId);
     const region = img?.regions.find(r => r.id === regionId);
     if (!img || !region) return;

     // Set Loading
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
         
         // Update with Text
         setImages(prev => prev.map(currentImg => 
            currentImg.id === imageId 
              ? {
                  ...currentImg,
                  regions: currentImg.regions.map(r => r.id === regionId ? { ...r, ocrText: text, isOcrLoading: false } : r)
                }
              : currentImg
         ));
     } catch (e: any) {
         console.error("OCR Failed", e);
         setErrorMsg("OCR Error: " + e.message);
         
         // Reset Loading
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

  // --- AUTO DETECTION HANDLER ---
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
         console.error(e);
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

    // Handle "Process Full Image" option
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

    // Set status to processing
    regionsToProcess.forEach(r => regionsMap.set(r.id, { ...r, status: 'processing' }));
    setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));

    if (signal.aborted) return;
    setProcessingState(ProcessingStep.CROPPING);

    const processRegionTask = async (region: Region) => {
        if (signal.aborted) return;
        await globalSemaphore.acquire();
        
        try {
            if (signal.aborted) return;
            const croppedBase64 = await cropRegion(imgElement, region);
            if (signal.aborted) return;

            setProcessingState(ProcessingStep.API_CALLING);
            
            const globalPrompt = config.prompt.trim();
            const regionSpecificPrompt = region.customPrompt ? region.customPrompt.trim() : '';
            const effectivePrompt = regionSpecificPrompt.length > 0 ? `${globalPrompt} ${regionSpecificPrompt}` : globalPrompt;

            const processedBase64 = await generateRegionEdit(croppedBase64, effectivePrompt, config, signal);
            if (signal.aborted) return;

            const completedRegion = { ...region, processedImageBase64: processedBase64, status: 'completed' as const };
            regionsMap.set(region.id, completedRegion);

            setProcessingState(ProcessingStep.STITCHING);
            const currentAllRegions = Array.from(regionsMap.values());
            const stitchedUrl = await stitchImage(imageSnapshot.previewUrl, currentAllRegions);

            setImages(prev => prev.map(img => {
                if (img.id !== imageSnapshot.id) return img;
                return { ...img, finalResultUrl: stitchedUrl, regions: currentAllRegions };
            }));

        } catch (err: any) {
            if (err.name === 'AbortError') return;
            console.error(`Region ${region.id} failed`, err);
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
             console.error("Global processing error", e);
             setErrorMsg(e.message || "Unknown error occurred");
        }
        setProcessingState(ProcessingStep.IDLE);
    }
  };

  const handleDownload = () => {
      if (!selectedImage || !selectedImage.finalResultUrl) return;
      const link = document.createElement('a');
      link.href = selectedImage.finalResultUrl;
      link.download = `patched_${selectedImage.file.name}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
  };

  // --- DRAG & DROP UI EVENTS ---
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

  // Check if Editor tools should be visible
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
        onDeleteImage={handleDeleteImage}
        onClearAllImages={handleClearAllImages} // Passed
        onToggleSkip={handleToggleSkip}
        onAutoDetect={handleAutoDetect}
        isDetecting={isDetecting}
        onOpenEditor={(imageId, regionId) => handleOpenEditor(imageId, regionId)} 
        onOcrRegion={(imageId, regionId) => handleOcrRegion(imageId, regionId)}
        onOpenGlobalSettings={() => setShowGlobalSettings(true)}
        onOpenHelp={() => setShowHelp(true)}
        showEditor={showEditor} // Pass to Sidebar
        onApplyAsOriginal={() => selectedImage && handleApplyResultAsOriginal(selectedImage.id)} // Pass handler
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
                 {selectedImage.finalResultUrl && (
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

                 {/* Undo/Redo Controls for Image History */}
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

             {viewMode === 'original' ? (
                <EditorCanvas
                    image={selectedImage}
                    onUpdateRegions={handleUpdateRegions}
                    disabled={processingState !== ProcessingStep.IDLE && processingState !== ProcessingStep.DONE}
                    language={config.language}
                    onOpenEditor={(regionId) => handleOpenEditor(selectedImage.id, regionId)}
                    selectedRegionId={selectedRegionId}
                    onSelectRegion={setSelectedRegionId}
                    onOcrRegion={(regionId) => handleOcrRegion(selectedImage.id, regionId)}
                    showOcrButton={config.enableMangaMode && config.enableOCR}
                    showEditorButton={showEditor} // Pass to Canvas
                />
             ) : (
                <div className="w-full h-full flex items-center justify-center p-8">
                    <img src={selectedImage.finalResultUrl} className="max-h-[85vh] max-w-full object-contain shadow-2xl rounded-lg ring-1 ring-skin-border" alt="Result" />
                </div>
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
         />
      )}

      {/* GLOBAL SETTINGS MODAL - Rendered here to be top level z-index */}
      {showGlobalSettings && (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
           <div className="bg-skin-surface max-w-sm w-full rounded-xl shadow-2xl flex flex-col border border-skin-border animate-in fade-in zoom-in-95">
              <div className="p-4 border-b border-skin-border flex justify-between items-center">
                 <h3 className="font-bold text-lg">{t(config.language, 'globalSettings')}</h3>
                 <button onClick={() => setShowGlobalSettings(false)} className="p-1 hover:bg-skin-fill rounded">✕</button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                  
                  {/* Master Switch: Manga Module */}
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

                  {/* Sub-Switch: Bubble Detection */}
                  {config.enableMangaMode && (
                     <div className="pl-4 border-l-2 border-skin-border space-y-4">
                         {/* Bubble Detection */}
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

                         {/* OCR */}
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

                         {/* Manual Editor */}
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