
import React, { useState, useRef, useEffect, useCallback, lazy, Suspense, Profiler } from 'react';
import { Region, ProcessingStep, AppConfig, RestoreBox, UploadedImage, RedrawIntent, ProcessingMode, workViewOf, effectiveIntentOf } from './types';
import Sidebar from './components/Sidebar';
import EditorCanvas from './components/EditorCanvas';
import EditorDock from './components/EditorDock';
import WorkflowDock from './components/WorkflowDock';
import { loadImage, cropRegion, stitchImage, createInvertedMultiMaskedFullImage, extractCropFromFullImage, stitchImageInverted, releaseObjectURL, cloneObjectUrl } from './services/imageUtils';
import { downloadImagesAsZip } from './services/downloadZip';
// Type-only: mixing an interface into a value import makes the dev server emit a
// runtime import for a name that does not exist ('does not provide an export named …').
import type { ResolvedResultUrl } from './services/downloadZip';
import { downloadWorkStateZip, readWorkStateZip } from './services/workStateTransfer';
import { fetchOpenAIModels } from './services/aiService';
import { recognizeText } from './services/detectionService';
import { t } from './services/translations';
import { resolveAutoFontSize, moveRegionLayer, LayerDirection } from './services/mangaEditor';
import { setDefaultFontFamily } from './services/textLayout';
import { editorFontStack, getEditorFont, ensureEditorFontLoaded } from './services/fontService';
import { useConfig } from './hooks/useConfig';
import { useImageManager } from './hooks/useImageManager';
import { useImageProcessor } from './hooks/useImageProcessor';
import { useMangaEditor, DISCRETE_RECOMPOSITE_DEBOUNCE_MS, editorPerfOn } from './hooks/useMangaEditor';

// Heavy components: only loaded when the user opens the dialogs.
const HelpModal = lazy(() => import('./components/HelpModal'));
const GlobalSettings = lazy(() => import('./components/GlobalSettings'));
const PayloadInspector = lazy(() => import('./components/PayloadInspector'));

/** Does this image have anything beyond the untouched picture? */
const imageHasResult = (img: UploadedImage): boolean =>
  img.regions.some(r => r.status === 'completed') || !!img.finalResultUrl || !!img.fullAiResultUrl;

/**
 * 有效重绘意图 —— 与管线（useImageProcessor.effectiveIntent）同一套规则：
 * 全图遮罩模式看图片级标记，标准模式看这一格自己的覆盖，都没表态 → 全局默认场景。
 *
 * 手动回填也按它决定落点：擦除 → 贴回来的就是干净底图（编辑器可排版 / 解冻填入）；
 * 翻译 / 自定义 → 贴回来的是成品图，AI 产物独占只读。
 */
const targetIntentOf = (
  region: Region | undefined,
  image: UploadedImage | undefined,
  config: AppConfig
): RedrawIntent => {
  const fallback = config.defaultRedrawIntent ?? 'translate';
  // effectiveIntentOf：已完成的框用它"完成时"落库的场景，不跟随当前默认场景。
  return config.useFullImageMasking
    ? effectiveIntentOf(image ?? {}, fallback)
    : effectiveIntentOf(region ?? {}, fallback);
};

export default function App() {
  const { config, setConfig } = useConfig();
  
  const {
    images,
    updateImage,
    updateAllImages,
    selectedImage,
    selectedImageId,
    selectedRegionId,
    setSelectedRegionId,
    viewMode,
    setViewMode,
    addImageFiles,
    uploadProgress,
    handleSelectImage,
    handleUpdateRegions,
    handleUpdateRegionPrompt,
    handleUpdateImagePrompt,
    handleUpdateRegionIntent,
    handleUpdateImageIntent,
    handleUpdateRegionTranslation,
    handleUpdateImageTranslation,
    handleToggleSkip,
    handleDeleteImage,
    handleClearAllImages,
    handleApplyResultAsOriginal,
    handleUndoImage,
    handleRedoImage,
    getStitchedUrl,
    replaceStore
  } = useImageManager(config.performanceMode, config.enableSessionPersistence);

  // Glossary grown by the translate stage is persisted through the config so it
  // survives reloads and is visible/editable in Global Settings.
  const handleGlossaryChange = useCallback((glossaryText: string) => {
      setConfig(prev => (prev.glossaryText === glossaryText ? prev : { ...prev, glossaryText }));
  }, [setConfig]);

  const {
      processingState,
      errorMsg,
      setErrorMsg,
      isDetecting,
      handleProcess,
      handleStop,
      handleAutoDetect,
      handleTranslate
  } = useImageProcessor(images, updateImage, updateAllImages, config, selectedImage, handleGlossaryChange);

  // In-place manga text editor engine (editor workflow mode). All editor data
  // lives on Region fields; this hook owns only caches + debounce timers.
  const {
      busy: editorBusy,
      translating: editorTranslating,
      translatingImageId: editorTranslatingImageId,
      computedFontSizes,
      updateEditorRegion,
      setBrushLayer,
      eraseRegions,
      eraseAllImages,
      restoreErase,
      restoreEraseAllImages,
      dropRegionCache,
      ocrAllRegions,
      translateImageRegions,
      translateAllImages,
      translateSingleImage,
      stopTranslation,
      unfreezeTranslation,
      freezeTranslation,
      resetRegion,
      whitenFrozenTextFree,
      whitenFrozenTextFreeAllImages,
      refreezeWhitedTextFree,
      refreezeWhitedTextFreeAllImages,
      undoFreezeFix,
      freezeUndoDepth,
      unfreezeAiBubbleRegions,
      resyncEditedRegions,
      refreshEditorPatches,
      buildBrushBase,
      clearEditorCaches,
  } = useMangaEditor({ images, updateImage, config, setErrorMsg });

  const [isDragging, setIsDragging] = useState(false);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPayloadInspector, setShowPayloadInspector] = useState(false);
  const [restoreMode, setRestoreMode] = useState(false);
  const [restoreBrushMode, setRestoreBrushMode] = useState(false);
  const [restoreBrushSize, setRestoreBrushSize] = useState(8);
  const [restoreSelectedRegionId, setRestoreSelectedRegionId] = useState<string | null>(null);
  // Run scope + the "gallery can be cleared now" nudge. Both belong to the run
  // actions, which now live in the right-hand dock (WorkflowDock) — while the
  // gallery header they highlight is still in the left sidebar.
  const [processAll, setProcessAll] = useState(false);
  const [clearHighlight, setClearHighlight] = useState(false);
  // Gallery ZIP export (button lives in the sidebar header, the work is here
  // because it needs the same result-URL resolver as Download / Apply).
  const [isZipping, setIsZipping] = useState(false);
  // Whole-work-state pack / restore (gallery + editing session + settings).
  const [workStateBusy, setWorkStateBusy] = useState(false);
  const [workStateStatus, setWorkStateStatus] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);

  const [transModels, setTransModels] = useState<string[]>([]);

  const isEditorMode = config.processingMode === 'editor';
  const isApiMode = config.processingMode === 'api';
  const isManualMode = config.processingMode === 'manual';

  // ── 编辑器字体（嵌字） ────────────────────────────────────────
  // 三步：
  //  1. 同步把字体栈写进排版模块 —— 即使文件还没下载完，排版也已经用正确的
  //     family 名（栈里带兜底字体），不会退化成浏览器默认的怪字体。
  //  2. 交给后端取字体：后端首次会从上游下载并缓存到 server/fonts/，之后前端
  //     直接读后端（浏览器再缓存一层），所以只有第一次真的产生网络下载。
  //  3. 重建已嵌字区域的贴图 —— 旧贴图是用旧字体栅格化好的位图，只改配置不会
  //     自动重画，必须显式重建。
  useEffect(() => {
    setDefaultFontFamily(editorFontStack(config.editorFontFamily));
    const meta = getEditorFont(config.editorFontFamily);
    // 没选字体（系统默认）、或编辑器没被启用时不用做任何事。
    if (!meta || !isEditorMode || !config.enableManualEditor) return;

    let cancelled = false;
    (async () => {
      try {
        await ensureEditorFontLoaded(meta.id, config.pythonBackendUrl);
      } catch (e) {
        if (cancelled) return;
        console.error('Editor font load failed', e);
        setErrorMsg(t(config.language, 'editorFontLoadFailed', { name: meta.label[config.language] }));
        return;
      }
      if (cancelled) return;
      await refreshEditorPatches();
    })();
    return () => { cancelled = true; };
  }, [
    config.editorFontFamily, config.pythonBackendUrl, config.language,
    config.enableManualEditor, isEditorMode,
    setErrorMsg, refreshEditorPatches,
  ]);

  // Whether the selected image has anything to show in the result view. The
  // result tab is always rendered (consistent tab set across images); this flag
  // only drives the "nothing generated yet" hint on top of it.
  const selectedHasResult = !!selectedImage && (
      selectedImage.regions.some(r => r.status === 'completed') || !!selectedImage.finalResultUrl
  );

  // 每个工作流的工作页：编辑器 → 编辑，AI 重绘 → 重绘，手动修补工坊 → 修补。
  // 工作页才是画框 + 实时预览结果的地方，所以进入工作流就落到它上面。
  const workTab = workViewOf(config.processingMode);

  // 工作页不属于当前工作流时（例如从编辑器切到 AI 重绘还停在「编辑」）回到
  // 准备页，画布永远不会停在一个当前工作流里不存在的标签页上。
  useEffect(() => {
      if (viewMode !== 'original' && viewMode !== 'result' && viewMode !== workTab) {
          setViewMode('original');
      }
  }, [viewMode, workTab, setViewMode]);

  // 进入 / 切换工作流 → 自动落到该工作流的工作页。切换图片不会重置（viewMode
  // 是全局的，用户可能正停在「已完成」上逐张看结果）。
  // ref 初值为 null，所以直接用持久化的 processingMode 启动也会落到工作页。
  const prevModeRef = useRef<ProcessingMode | null>(null);
  useEffect(() => {
      if (prevModeRef.current !== config.processingMode) {
          prevModeRef.current = config.processingMode;
          setViewMode(workTab);
      }
  }, [config.processingMode, workTab, setViewMode]);

  // Debounce Timer Ref for Heavy Operations
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Custom wrapper for manual patch updates to handle Full Image row special case
  const handleManualPatchUpdate = useCallback((imageId: string, regionId: string, imageDataUrl: string) => {
    // imageDataUrl is now typically an Object URL (blob:), but may still be base64 from paste

    if (regionId === 'special-full-image-mask') {
        const targetImg = images.find(img => img.id === imageId);
        if (!targetImg) return;

        // Start processing the update
        (async () => {
            const updatedRegions: Region[] = [];
            
            if (config.useInvertedMasking) {
                for (const r of targetImg.regions) {
                    updatedRegions.push({ ...r, status: 'completed' });
                }
                const stitchedUrl = await stitchImageInverted(targetImg.previewUrl, imageDataUrl, updatedRegions);
                
                updateImage(imageId, img => {
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = imageDataUrl;
                    }
                    // Release old URLs
                    if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);
                    if (img.finalResultUrl) releaseObjectURL(img.finalResultUrl);

                    return {
                        ...img,
                        fullAiResultUrl: imageDataUrl,
                        finalResultUrl: stitchedUrl,
                        regions: updatedRegions,
                        history: currentHistory
                    };
                });
            } else {
                for (const r of targetImg.regions) {
                    try {
                        const crop = await extractCropFromFullImage(
                            imageDataUrl, 
                            r, 
                            targetImg.originalWidth, 
                            targetImg.originalHeight,
                            config.fullImageOpaquePercent
                        );
                        const cropIntent = targetIntentOf(r, targetImg, config);
                        const cropEraseBase = cropIntent === 'erase' ? await cloneObjectUrl(crop) : undefined;
                        if (cropEraseBase && r.aiEraseBaseUrl) releaseObjectURL(r.aiEraseBaseUrl);
                        updatedRegions.push({
                            ...r,
                            processedImageUrl: crop,
                            status: 'completed',
                            // 场景落库：这格是按 cropIntent 回填的，之后不再跟随默认场景。
                            redrawIntent: cropIntent,
                            anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height,
                            ...(cropIntent === 'erase'
                                ? { aiErasedBase: true, editorErased: false, editorWhitedOut: false, aiEraseBaseUrl: cropEraseBase ?? r.aiEraseBaseUrl }
                                : { aiErasedBase: undefined, aiEraseBaseUrl: undefined }),
                        });
                    } catch (e) {
                        console.error("Failed to extract crop for region", r.id, e);
                        updatedRegions.push({ ...r, status: 'failed' });
                    }
                }
                
                updateImage(imageId, img => {
                    const currentHistory = [...img.history];
                    if (currentHistory[img.historyIndex]) {
                       currentHistory[img.historyIndex].fullAiResultUrl = imageDataUrl;
                    }
                    if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                    return {
                        ...img,
                        fullAiResultUrl: imageDataUrl,
                        regions: updatedRegions,
                        history: currentHistory
                    };
                });
            }
        })();
        return;
    }

    // 回填落点按有效重绘意图走：「擦除」= 贴回来的是干净底图（aiErasedBase +
    // 独立底图槽），编辑器可以在它上面排版、也能「解冻填入」；「翻译 / 自定义」
    // = 贴回来的是成品图，AI 产物独占只读。
    const targetImg = images.find(img => img.id === imageId);
    const pasteIntent = targetIntentOf(targetImg?.regions.find(r => r.id === regionId), targetImg, config);
    void (async () => {
        const eraseBase = pasteIntent === 'erase' ? await cloneObjectUrl(imageDataUrl) : undefined;
        updateImage(imageId, img => {
            // Release old region URL before replacing
            const oldRegion = img.regions.find(r => r.id === regionId);
            if (oldRegion?.processedImageUrl) releaseObjectURL(oldRegion.processedImageUrl);
            // 旧底图只在真的拿到新底图时才回收（否则留着还能继续当底图用）。
            if (eraseBase && oldRegion?.aiEraseBaseUrl) releaseObjectURL(oldRegion.aiEraseBaseUrl);

            const updatedRegions = img.regions.map(r => {
                if (r.id !== regionId) return r;
                const pasted: Region = {
                    ...r,
                    processedImageUrl: imageDataUrl,
                    status: 'completed' as const,
                    // 场景落库：这格是按 pasteIntent 回填的，之后不再跟随默认场景。
                    redrawIntent: pasteIntent,
                    anchorX: r.x, anchorY: r.y, anchorWidth: r.width, anchorHeight: r.height,
                    // 贴回来的图是按当前框裁的，不带编辑器溢出边距，也不是编辑器
                    // 合成的产物。
                    patchMarginX: undefined,
                    patchMarginY: undefined,
                    editorComposited: false,
                };
                return pasteIntent === 'erase'
                    ? { ...pasted, aiErasedBase: true, editorErased: false, editorWhitedOut: false, aiEraseBaseUrl: eraseBase ?? r.aiEraseBaseUrl }
                    : { ...pasted, aiErasedBase: undefined, aiEraseBaseUrl: undefined };
            });

            const currentHistory = [...img.history];
            if (currentHistory[img.historyIndex]) {
                currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions: updatedRegions };
            }

            return { ...img, regions: updatedRegions, history: currentHistory };
        });
    })();
  }, [images, config.useInvertedMasking, config.fullImageOpaquePercent, config.defaultRedrawIntent, updateImage]);

  // --- Interaction Start Handler (Called by EditorCanvas on mousedown) ---
  const handleInteractionStart = useCallback(() => {
      // Cancel any pending debounce timer
      if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = null;
      }
  }, []);

  // --- Regions Update Handler ---
  // Green frame resize/move no longer re-crops processedImageUrl.
  // The processed image stays at its anchor size; the green frame acts as a viewport window.
  const onRegionsChanged = useCallback((imageId: string, newRegions: Region[]) => {
      // Regions the user deleted (canvas ✕ / Delete key) no longer need their
      // editor caches — drop them here so every delete path stays consistent.
      const prevImage = images.find(img => img.id === imageId);
      if (prevImage) {
          const nextIds = new Set(newRegions.map(r => r.id));
          for (const r of prevImage.regions) {
              if (!nextIds.has(r.id)) dropRegionCache(imageId, r.id);
          }
      }
      handleUpdateRegions(imageId, newRegions);

      // Editor mode: geometry changes of edited regions trigger a debounced
      // re-layout + re-composite of their patches (erasure cache is keyed by
      // geometry, so only moved boxes do real work).
      if (config.processingMode === 'editor') {
          resyncEditedRegions(imageId, newRegions);
          return;
      }

      if (config.useInvertedMasking) {
          const targetImage = images.find(img => img.id === imageId);
          if (targetImage && targetImage.fullAiResultUrl) {
              if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
              debounceTimerRef.current = setTimeout(async () => {
                  const stitchedUrl = await stitchImageInverted(targetImage.previewUrl, targetImage.fullAiResultUrl!, newRegions);
                  updateImage(imageId, img => ({ ...img, finalResultUrl: stitchedUrl }));
              }, 200);
          }
          return;
      }
  }, [handleUpdateRegions, config.useInvertedMasking, config.processingMode, images, updateImage, resyncEditedRegions, dropRegionCache]);

  // --- Handlers ---
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    // Reset value first so re-selecting the same file(s) still fires onChange.
    e.target.value = '';
    if (files && files.length > 0) {
      await addImageFiles(Array.from(files));
    }
  }, [addImageFiles]);

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

  // Delete / Backspace removes the selected box — mirrors the canvas' ✕ button.
  const handleDeleteSelectedRegion = useCallback(() => {
      if (!selectedImage || !selectedRegionId) return;
      const region = selectedImage.regions.find(r => r.id === selectedRegionId);
      // Processing boxes stay locked (same rule as the in-canvas delete button).
      if (!region || region.status === 'processing') return;
      dropRegionCache(selectedImage.id, selectedRegionId);
      handleUpdateRegions(
        selectedImage.id,
        selectedImage.regions.filter(r => r.id !== selectedRegionId)
      );
      setSelectedRegionId(null);
  }, [selectedImage, selectedRegionId, dropRegionCache, handleUpdateRegions, setSelectedRegionId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        const target = e.target as HTMLElement;
        if (target.matches('input, textarea') || target.isContentEditable) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (!selectedRegionId) return;
            e.preventDefault();
            handleDeleteSelectedRegion();
            return;
        }
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
  }, [images, selectedImageId, handleSelectImage, selectedRegionId, handleDeleteSelectedRegion]);

  const handleOcrRegion = useCallback(async (imageId: string, regionId: string) => {
     const img = images.find(i => i.id === imageId);
     const region = img?.regions.find(r => r.id === regionId);
     if (!img || !region) return;
     updateImage(imageId, currentImg => ({
         ...currentImg,
         regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: true } : r)
     }));
     try {
         const imgEl = await loadImage(img.previewUrl);
         const cropUrl = await cropRegion(imgEl, region);
         const text = await recognizeText(cropUrl, config);
         // Release the temporary crop URL after OCR is done
         releaseObjectURL(cropUrl);
         updateImage(imageId, currentImg => ({
             ...currentImg,
             regions: currentImg.regions.map(r => r.id === regionId ? { ...r, ocrText: text, isOcrLoading: false } : r)
         }));
     } catch (e: any) {
         setErrorMsg("OCR Error: " + e.message);
         updateImage(imageId, currentImg => ({
             ...currentImg,
             regions: currentImg.regions.map(r => r.id === regionId ? { ...r, isOcrLoading: false } : r)
         }));
     }
  }, [images, config, updateImage, setErrorMsg]);

  // --- RESTORE BOXES HANDLER ---
  const handleUpdateRestoreBoxes = useCallback((regionId: string, boxes: RestoreBox[]) => {
      updateAllImages(img => ({
          ...img,
          regions: img.regions.map(r => r.id === regionId ? { ...r, restoreBoxes: boxes } : r)
      }));
  }, [updateAllImages]);

  const handleUpdateRestoreMask = useCallback((regionId: string, maskBase64: string | null) => {
      updateAllImages(img => ({
          ...img,
          regions: img.regions.map(r => r.id === regionId ? { ...r, restoreMaskUrl: maskBase64 || undefined } : r)
      }));
  }, [updateAllImages]);

  /**
   * The picture exactly as the 已完成 tab renders it (see the result branch in
   * the JSX) — the single source of truth for Download, ZIP export and
   * 应用为原图, so a saved file can never disagree with the canvas.
   *
   * `fresh` returns an uncached URL for callers that KEEP it (应用为原图 stores
   * it as the image's new previewUrl): the stitch cache revokes its own entries
   * when the image signature changes, which would break the image.
   * `release` flags URLs created right here — cache/original URLs are owned
   * elsewhere and must never be revoked.
   */
  const resolveResultUrl = useCallback(async (image: UploadedImage, fresh = false): Promise<ResolvedResultUrl> => {
      // Patch overflow margins are an editor-workflow affordance only: in
      // AI 重绘 / 手动修补工坊 the stitch crops them back to the box so the
      // exported picture matches what those workflows show on the canvas.
      const honorPatchOverflow = config.processingMode === 'editor';
      if (config.useInvertedMasking && image.fullAiResultUrl) {
          return {
              url: await stitchImageInverted(image.previewUrl, image.fullAiResultUrl, image.regions),
              release: true,
          };
      }
      // Nothing painted: the result tab shows the untouched picture, so hand back
      // the original file itself (the preview may be a downscaled copy). Exception:
      // after 应用为原图 the preview IS the committed picture while originalUrl still
      // points at the pre-apply source — export the preview so Download / ZIP match
      // the canvas instead of silently shipping the old image.
      const hasPatch = image.regions.some(r => r.status === 'completed' && r.processedImageUrl);
      if (!hasPatch) {
          return {
              url: image.appliedAsOriginal ? image.previewUrl : (image.originalUrl || image.previewUrl),
              release: false,
          };
      }
      if (fresh) return { url: await stitchImage(image.previewUrl, image.regions, honorPatchOverflow), release: true };
      return { url: await getStitchedUrl(image, honorPatchOverflow), release: false };
  }, [config.useInvertedMasking, config.processingMode, getStitchedUrl]);

  // ON-DEMAND STITCHING for Download — scope-aware: 当前图片 = that one file,
  // 全部 = ZIP of everything that has a result, plus the images marked as skipped.
  // Applied-as-original images count too: their result is now the committed
  // previewUrl, so they must not silently vanish from a 全部 download.
  const handleDownload = useCallback(async (scopeAll: boolean) => {
      try {
          if (scopeAll) {
              const targets = images.filter(img => imageHasResult(img) || img.appliedAsOriginal || !!img.isSkipped);
              if (targets.length === 0) return;
              await downloadImagesAsZip(targets, resolveResultUrl);
              setClearHighlight(true);
              return;
          }
          if (!selectedImage) return;
          const { url, release } = await resolveResultUrl(selectedImage);
          const link = document.createElement('a');
          link.href = url;
          link.download = selectedImage.file.name.replace(/\.[^.]+$/, '') + '.png';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          // Only release if we created the URL here; cached URLs are owned by useImageManager.
          if (release) releaseObjectURL(url);
          // Result is on disk — nudge the user to free the local session.
          setClearHighlight(true);
      } catch (e) {
          console.error("Failed to stitch for download", e);
          setErrorMsg("Failed to generate download image.");
      }
  }, [images, selectedImage, resolveResultUrl, setErrorMsg]);

  /**
   * Gallery ZIP export (button in the sidebar header): EVERY image in the
   * gallery, each written as its 已完成 rendering. Untouched pictures resolve to
   * their original file, so "export the gallery" stays one predictable action
   * that no longer depends on how far the run got.
   */
  const handleDownloadAllZip = useCallback(async () => {
      if (images.length === 0) return;
      setIsZipping(true);
      try {
          await downloadImagesAsZip(images, resolveResultUrl);
          setClearHighlight(true);
      } catch (e) {
          console.error("Zip generation failed", e);
          setErrorMsg("Failed to create zip file");
      } finally {
          setIsZipping(false);
      }
  }, [images, resolveResultUrl, setErrorMsg]);

  /**
   * Whole-work-state export: the gallery, every image's editing state (regions,
   * AI patches, editor text/erase/brush layers, history-relevant blobs) and the
   * settings, as one ZIP. Unlike the IndexedDB session mirror this file is
   * portable — import it later (or on another machine) to restore everything.
   */
  const handleExportWorkState = useCallback(async () => {
      if (images.length === 0) return;
      setWorkStateBusy(true);
      setWorkStateStatus(null);
      try {
          const name = await downloadWorkStateZip(images, selectedImageId, config);
          setWorkStateStatus({ text: t(config.language, 'workStateExported', { name }), tone: 'ok' });
      } catch (e: any) {
          console.error("Work state export failed", e);
          setWorkStateStatus({
              text: t(config.language, 'workStateExportFailed', { reason: e?.message || '' }),
              tone: 'warn',
          });
      } finally {
          setWorkStateBusy(false);
      }
  }, [images, selectedImageId, config]);

  /** Restore a previously exported work-state ZIP: replaces the gallery and
   *  merges the packaged settings (validated — see workStateTransfer.ts). */
  const handleImportWorkState = useCallback(async (file: File) => {
      setWorkStateBusy(true);
      setWorkStateStatus(null);
      try {
          const outcome = await readWorkStateZip(file, config);
          if (outcome.status === 'error') {
              const errorKey = outcome.error === 'not-a-zip'
                  ? 'workStateErrNotZip'
                  : outcome.error === 'bad-manifest'
                      ? 'workStateErrBadManifest'
                      : outcome.error === 'version-unsupported'
                          ? 'workStateErrVersion'
                          : 'workStateErrEmpty';
              setWorkStateStatus({ text: t(config.language, errorKey), tone: 'warn' });
              return;
          }
          // Editor caches are keyed by region geometry only — dropping them
          // keeps a restored region from reusing a base erased for another one.
          clearEditorCaches();
          replaceStore(outcome.images, outcome.selectedImageId);
          if (outcome.config) setConfig(outcome.config);
          setWorkStateStatus({
              text: outcome.configAppliedCount > 0
                  ? t(config.language, 'workStateImportedWithConfig', { count: outcome.images.length, settings: outcome.configAppliedCount })
                  : t(config.language, 'workStateImported', { count: outcome.images.length }),
              tone: 'ok',
          });
      } catch (e: any) {
          console.error("Work state import failed", e);
          setWorkStateStatus({
              text: t(config.language, 'workStateImportFailed', { reason: e?.message || '' }),
              tone: 'warn',
          });
      } finally {
          setWorkStateBusy(false);
      }
  }, [config, replaceStore, setConfig, clearEditorCaches]);

  // ON-DEMAND STITCHING for Apply — scope-aware. 全部 applies every image that
  // HAS a result; untouched images are skipped on purpose: applying one would
  // clear its regions and push a history entry for a picture that would look
  // exactly the same afterwards.
  const handleApplyAsOriginalWrapper = useCallback(async (scopeAll: boolean) => {
      const targets = scopeAll
          ? images.filter(imageHasResult)
          : (selectedImage ? [selectedImage] : []);
      for (const image of targets) {
          try {
              const { url } = await resolveResultUrl(image, true);
              // Ownership moves to the image (it becomes the new previewUrl), so
              // `release` is deliberately ignored here.
              handleApplyResultAsOriginal(image.id, url);
          } catch (e) {
              console.error("Failed to stitch for apply", e);
              setErrorMsg("Failed to apply changes.");
          }
      }
  }, [images, selectedImage, resolveResultUrl, handleApplyResultAsOriginal, setErrorMsg]);

  // --- REFINEMENT HANDLER (Scroll to adjust box) ---
  const handleAdjustRegion = useCallback(async (imageId: string, regionId: string, isExpand: boolean) => {
      const img = images.find(i => i.id === imageId);
      if (!img) return;
      
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

      // Inverted Mode Refinement (requires fullAiResultUrl)
      if (config.useInvertedMasking && img.fullAiResultUrl) {
          if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
          debounceTimerRef.current = setTimeout(async () => {
              const stitchedUrl = await stitchImageInverted(img.previewUrl, img.fullAiResultUrl!, updatedRegions);
              updateImage(imageId, i => ({ ...i, finalResultUrl: stitchedUrl }));
          }, 200);
      }
  }, [images, config.useInvertedMasking, handleUpdateRegions, updateImage]);

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

  const updateConfig = useCallback((key: keyof AppConfig, value: any) => {
      setConfig(prev => ({ ...prev, [key]: value }));
  }, [setConfig]);

  const fetchTransModels = useCallback(async () => {
      if (!config.translationBaseUrl || !config.translationApiKey) return;
      try {
          const models = await fetchOpenAIModels(config.translationBaseUrl, config.translationApiKey);
          setTransModels(models);
      } catch(e) { console.error(e); }
  }, [config.translationBaseUrl, config.translationApiKey]);

  // Stable adapters for EditorCanvas — bind selectedImage.id so the child only sees a regionId arg.
  const selectedImageId_safe = selectedImage?.id;
  const editorOnUpdateRegions = onRegionsChanged;
  const editorOnOcrRegion = useCallback((regionId: string) => {
      if (selectedImageId_safe) handleOcrRegion(selectedImageId_safe, regionId);
  }, [selectedImageId_safe, handleOcrRegion]);
  const editorOnAdjustRegionSize = useCallback((regionId: string, isExpand: boolean) => {
      if (selectedImageId_safe) handleAdjustRegion(selectedImageId_safe, regionId, isExpand);
  }, [selectedImageId_safe, handleAdjustRegion]);
  // Reset / Redo goes through the editor engine so a `bubble` takes its
  // contained text boxes with it (freezing text that would otherwise be lost).
  const editorOnResetRegion = useCallback((regionId: string) => {
      if (selectedImageId_safe) resetRegion(selectedImageId_safe, regionId);
  }, [selectedImageId_safe, resetRegion]);

  // 叠放次序：贴图部分重叠时谁盖谁 = regions 数组下标（下标越大越靠上）。
  // ↑ / ↓ 挪一层（与相邻项交换），⤒ / ⤓ 直接搬到数组末尾 / 开头；
  // 没动就不写状态（moveRegionLayer 返回原数组）。
  const reorderRegion = useCallback((imageId: string, regionId: string, dir: LayerDirection) => {
      updateImage(imageId, img => {
          const regions = moveRegionLayer(img.regions, regionId, dir);
          if (regions === img.regions) return img;
          // 和 handleUpdateRegions 一样把当前 history 条目同步过去，撤销/重做
          // 才不会把旧顺序带回来。
          const currentHistory = [...img.history];
          if (currentHistory[img.historyIndex]) {
              currentHistory[img.historyIndex] = { ...currentHistory[img.historyIndex], regions };
          }
          return { ...img, regions, history: currentHistory };
      });
  }, [updateImage]);
  // 编辑器面板只认识 regionId（目标图 = 当前选中图）。
  const editorOnReorderRegion = useCallback((regionId: string, dir: LayerDirection) => {
      if (selectedImageId_safe) reorderRegion(selectedImageId_safe, regionId, dir);
  }, [selectedImageId_safe, reorderRegion]);

  // Ctrl+wheel over the SELECTED box in the editor workflow steps its font
  // size by ±5 — the same step the dock's ± buttons use (EditorDock
  // stepFontSize). Base = explicit size → the size the compositor resolved →
  // the auto-fit size computed on the spot. The on-the-spot value matters on a
  // fresh/restored session: `computedFontSizes` is in-memory only, so a box
  // that has not been composited yet would otherwise step from a hard-coded 16
  // (first step jumping to 21 / 11 instead of auto ± 5).
  const editorOnStepFontSize = useCallback((delta: number) => {
      if (!selectedImage || !selectedRegionId) return;
      const region = selectedImage.regions.find(r => r.id === selectedRegionId);
      if (!region) return;
      const base = region.editorStyle?.fontSize
          ?? computedFontSizes[selectedRegionId]
          ?? resolveAutoFontSize(
              region,
              selectedImage.originalWidth,
              selectedImage.originalHeight,
              !!config.enableVerticalTextDefault,
              selectedImage.previewUrl !== selectedImage.originalUrl
          )
          ?? 16;
      const next = Math.min(400, Math.max(6, Math.round(base + delta)));
      if (next === Math.round(base)) return;
      // A wheel step is a discrete action: short debounce (still coalesces a
      // continuous gesture into one composite) instead of the typing window.
      updateEditorRegion(
          selectedImage.id,
          region.id,
          { editorStyle: { fontSize: next } },
          { debounceMs: DISCRETE_RECOMPOSITE_DEBOUNCE_MS }
      );
  }, [selectedImage, selectedRegionId, computedFontSizes, config.enableVerticalTextDefault, updateEditorRegion]);

  // Stable adapters for Sidebar.
  const sidebarOnOpenGlobalSettings = useCallback(() => setShowGlobalSettings(true), []);
  const sidebarOnOpenHelp = useCallback(() => setShowHelp(true), []);
  const sidebarOnOpenPayloadInspector = useCallback(() => setShowPayloadInspector(true), []);

  // Temporary (companion to the editorPerf pipeline timing): attributes the
  // per-keystroke re-render cost to a subtree. Logs only >10 ms renders.
  const onRenderPerf = useCallback((id: string, phase: string, actualDuration: number) => {
    if (!editorPerfOn() || actualDuration <= 10) return;
    console.log(`[editorPerf] render ${id} (${phase}) ${actualDuration.toFixed(1)}ms`);
  }, []);

  return (
    <div 
      className="flex h-screen w-screen bg-skin-fill text-skin-text overflow-hidden font-sans relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <Profiler id="Sidebar" onRender={onRenderPerf}>
      <Sidebar
        config={config}
        setConfig={setConfig}
        images={images}
        selectedImageId={selectedImageId}
        onSelectImage={handleSelectImage}
        onUpload={handleUpload}
        currentImage={selectedImage}
        onDeleteImage={handleDeleteImage}
        onClearAllImages={handleClearAllImages} 
        onToggleSkip={handleToggleSkip}
        onAutoDetect={handleAutoDetect}
        isDetecting={isDetecting}
        onOpenGlobalSettings={sidebarOnOpenGlobalSettings}
        onOpenHelp={sidebarOnOpenHelp}
        onOpenPayloadInspector={sidebarOnOpenPayloadInspector}
        onDownloadAllZip={handleDownloadAllZip}
        isZipping={isZipping}
        onExportWorkState={handleExportWorkState}
        onImportWorkState={handleImportWorkState}
        workStateBusy={workStateBusy}
        workStateStatus={workStateStatus}
        uploadProgress={uploadProgress}
        clearHighlight={clearHighlight}
        setClearHighlight={setClearHighlight}
      />
      </Profiler>
      
      <main className="flex-1 min-w-0 relative bg-checkerboard flex">
        {/* Canvas column. The right-hand docks are IN FLOW (not overlays), so the
            canvas viewport really shrinks by their width and EditorCanvas
            re-fits / re-centres the picture inside the visible area — the dock
            never covers the artwork and the fit-zoom accounts for the space. */}
        <div className="flex-1 min-w-0 relative flex flex-col">
        {selectedImage ? (
           <>
             <div className="absolute top-4 left-4 z-10 flex gap-2">
                 <button 
                   onClick={() => { setViewMode('original'); setRestoreMode(false); }}
                   className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'original' ? 'bg-skin-primary text-skin-primary-fg border-skin-primary' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                 >
                   {t(config.language, 'readyToCreate')}
                 </button>
                  {/* 工作页：每个工作流一个（编辑器→编辑 / AI 重绘→重绘 /
                      手动修补工坊→修补）。三者等价：框可见可改，框内贴图实时
                      预览，所以能一边改一边看结果。 */}
                  {isEditorMode && (
                     <button 
                         onClick={() => { setViewMode('edit'); setRestoreMode(false); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'edit' ? 'bg-sky-500 text-white border-sky-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {t(config.language, 'editorEditTab')}
                     </button>
                  )}
                  {isApiMode && (
                     <button 
                         onClick={() => { setViewMode('redraw'); setRestoreMode(false); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'redraw' ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {t(config.language, 'redrawTab')}
                     </button>
                  )}
                  {isManualMode && (
                     <button 
                         onClick={() => { setViewMode('patch'); setRestoreMode(false); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'patch' ? 'bg-fuchsia-500 text-white border-fuchsia-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {t(config.language, 'patchTab')}
                     </button>
                  )}
                  {/* The result tab is ALWAYS available so the tab set is the same
                      for every image (a fresh image used to hide it, which made the
                      header jump around between images). With nothing generated it
                      simply shows the untouched picture, flagged by the hint below. */}
                  <button
                      onClick={() => { setViewMode('result'); setRestoreMode(false); }}
                      className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${viewMode === 'result' && !restoreMode ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                  >
                      {t(config.language, 'status_completed')}
                  </button>
                  {viewMode === 'result' && selectedImage.regions.some(r => r.status === 'completed') && (
                     <button 
                         onClick={() => { setRestoreMode(!restoreMode); setRestoreBrushMode(false); setRestoreSelectedRegionId(null); }}
                         className={`px-3 py-1.5 rounded-full text-xs font-bold backdrop-blur-md border shadow-sm transition-all ${restoreMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-skin-surface/80 text-skin-text border-skin-border hover:bg-skin-surface'}`}
                     >
                         {restoreMode ? '退出还原' : '🔧 框选还原'}
                     </button>
                  )}
                  {/* Restore toolbar - only when restore mode is active */}
                  {restoreMode && (
                    <div className="flex gap-1 items-center">
                      <button
                        onClick={() => setRestoreBrushMode(false)}
                        className={`px-2 py-1 text-[10px] font-bold rounded border ${!restoreBrushMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-black/60 text-amber-400 border-amber-400/50 hover:border-amber-400'}`}
                      >□ 框选</button>
                      <button
                        onClick={() => setRestoreBrushMode(true)}
                        className={`px-2 py-1 text-[10px] font-bold rounded border ${restoreBrushMode ? 'bg-amber-500 text-white border-amber-500' : 'bg-black/60 text-amber-400 border-amber-400/50 hover:border-amber-400'}`}
                      >🖌 涂抹</button>
                      {restoreBrushMode && (
                        <>
                          <span className="text-[9px] text-white/70 ml-1">大小</span>
                          <input type="range" min="1" max="20" step="0.5" value={restoreBrushSize}
                            onChange={(e) => setRestoreBrushSize(Number(e.target.value))}
                            className="w-10 h-1 accent-amber-400" />
                          <span className="text-[9px] text-white/60 w-4">{restoreBrushSize}</span>
                        </>
                      )}
                      <button
                        onClick={() => {
                          if (!restoreSelectedRegionId || !selectedImage) return;
                          updateImage(selectedImage.id, img => ({
                              ...img,
                              regions: img.regions.map(r => {
                                if (r.id !== restoreSelectedRegionId) return r;
                                return { ...r, restoreBoxes: undefined, restoreMaskUrl: undefined };
                              })
                          }));
                        }}
                        className="px-2 py-1 text-[10px] font-bold bg-rose-500/80 text-white rounded border border-rose-500 hover:bg-rose-500 disabled:opacity-30"
                        disabled={!restoreSelectedRegionId}
                      >清除</button>
                    </div>
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

             {/* The result tab is always clickable, so say why it can look empty
                 on an image nothing has been redrawn for yet. Skipped images
                 already carry their own "skipped" chip — no hint there. */}
             {viewMode === 'result' && !selectedHasResult && !selectedImage.isSkipped && (
                 <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-20 pointer-events-none px-3 py-1 rounded-full border border-skin-border bg-skin-surface/90 backdrop-blur-sm text-[11px] text-skin-muted shadow-sm animate-in fade-in">
                     {t(config.language, 'noResultYet')}
                 </div>
             )}

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
                  <Profiler id="EditorCanvas" onRender={onRenderPerf}>
                <EditorCanvas
                    key={selectedImage.id}
                    image={selectedImage}
                    onUpdateRegions={editorOnUpdateRegions}
                    // Processing no longer locks the whole canvas. Individual
                    // regions in `status === 'processing'` are still per-region
                    // read-only (handled inside EditorCanvas / useCanvasInteraction),
                    // and useImageProcessor merges results by id so user edits to
                    // other regions during processing are preserved.
                    disabled={false}
                    language={config.language}
                    selectedRegionId={selectedRegionId}
                    onSelectRegion={setSelectedRegionId}
                    onOcrRegion={editorOnOcrRegion}
                    showOcrButton={config.enableMangaMode && config.enableOCR}
                    onAdjustRegionSize={editorOnAdjustRegionSize}
                    onResetRegion={editorOnResetRegion}
                    onInteractionStart={handleInteractionStart}
                    viewMode={viewMode}
                    restoreMode={restoreMode}
                    onUpdateRestoreBoxes={restoreMode ? handleUpdateRestoreBoxes : undefined}
                    onUpdateRestoreMask={restoreMode ? handleUpdateRestoreMask : undefined}
                    restoreBrushMode={restoreBrushMode}
                    restoreBrushSize={restoreBrushSize}
                    restoreSelectedRegionId={restoreSelectedRegionId}
                    onSelectRestoreRegion={setRestoreSelectedRegionId}
                    showRetryDiagnostics={!!config.showRetryDiagnostics}
                    regionDisplay={isEditorMode ? 'editor' : 'generation'}
                    defaultRedrawIntent={config.defaultRedrawIntent ?? 'translate'}
                    // Typeset overflow stays visible ONLY in the editor workflow;
                    // AI 重绘 / 手动修补工坊 clip patches back to their box.
                    allowPatchOverflow={isEditorMode}
                    // Editor tab only: Ctrl+wheel over the selected box = 字号 ±5.
                    onStepSelectedFontSize={isEditorMode && viewMode === 'edit' ? editorOnStepFontSize : undefined}
                />
                </Profiler>
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

        {/* Global error toast — inside the canvas column so it centres over the
            visible canvas rather than over the dock. */}
        {errorMsg && (
            <div className="absolute bottom-8 left-1/2 -translate-x-1/2 bg-rose-500 text-white px-4 py-2 rounded-lg shadow-lg text-sm font-medium animate-in fade-in slide-in-from-bottom-4 flex items-center gap-2 z-50">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                {errorMsg}
                <button onClick={() => setErrorMsg(null)} className="ml-2 opacity-80 hover:opacity-100">✕</button>
            </div>
        )}
        </div>

        {/* Editor dock (editor workflow, '编辑' tab) — always present there:
            no box selected → global batch ops (erase/OCR/translate); box
            selected → that box's text/direction/font-size/erase/OCR/brush.
            AI-owned boxes render read-only inside the dock. */}
        {isEditorMode && viewMode === 'edit' && selectedImage && (
          <EditorDock
            image={selectedImage}
            images={images}
            config={config}
            selectedRegionId={selectedRegionId}
            onSelectRegion={setSelectedRegionId}
            busy={editorBusy}
            computedFontSizes={computedFontSizes}
            onConfigChange={updateConfig}
            onUpdateRegion={(regionId, updates, opts) => updateEditorRegion(selectedImage.id, regionId, updates, opts)}
            onOcrRegion={(regionId) => handleOcrRegion(selectedImage.id, regionId)}
            buildBrushBase={(regionId) => buildBrushBase(selectedImage.id, regionId)}
            onBrushChange={(regionId, url) => setBrushLayer(selectedImage.id, regionId, url)}
            onErase={(scope) => eraseRegions(selectedImage.id, scope, selectedRegionId)}
            onEraseAllImages={(scope) => eraseAllImages(scope)}
            onRestoreErase={(scope) => restoreErase(selectedImage.id, scope, selectedRegionId)}
            onRestoreEraseAllImages={(scope) => restoreEraseAllImages(scope)}
            onOcrAll={() => ocrAllRegions(selectedImage.id)}
            onTranslate={() => translateSingleImage(selectedImage.id)}
            onTranslateAll={() => translateAllImages()}
            translating={editorTranslating}
            translatingImageId={editorTranslatingImageId}
            onStopTranslate={stopTranslation}
            onUnfreeze={(regionId) => unfreezeTranslation(selectedImage.id, regionId)}
            onFreeze={(regionId) => freezeTranslation(selectedImage.id, regionId)}
            onWhitenFrozenTextFree={() => whitenFrozenTextFree(selectedImage.id)}
            onWhitenFrozenTextFreeAll={whitenFrozenTextFreeAllImages}
            onRefreezeWhitedTextFree={() => refreezeWhitedTextFree(selectedImage.id)}
            onRefreezeWhitedTextFreeAll={refreezeWhitedTextFreeAllImages}
            onUndoFreezeFix={undoFreezeFix}
            freezeUndoDepth={freezeUndoDepth}
            onRevealAiBase={() => unfreezeAiBubbleRegions(selectedImage.id)}
            onDownload={handleDownload}
            onApplyAsOriginal={handleApplyAsOriginalWrapper}
            onReorderRegion={(regionId, dir) => editorOnReorderRegion(regionId, dir)}
          />
        )}

        {/* Right-side dock for the API workflows (AI 重绘 / 手动修补工坊) —
            the panels that configure a run sit next to the canvas instead of in
            the left sidebar. Rendered outside the image branch so 提示词 /
            连接设置 / 处理选项 are reachable with an empty gallery too. */}
        {!isEditorMode && (
          <WorkflowDock
            config={config}
            onConfigChange={updateConfig}
            currentImage={selectedImage}
            selectedRegionId={selectedRegionId}
            onUpdateRegionPrompt={handleUpdateRegionPrompt}
            onUpdateImagePrompt={handleUpdateImagePrompt}
            onUpdateRegionIntent={handleUpdateRegionIntent}
            onUpdateImageIntent={handleUpdateImageIntent}
            onUpdateRegionTranslation={handleUpdateRegionTranslation}
            onUpdateImageTranslation={handleUpdateImageTranslation}
            onManualPatchUpdate={handleManualPatchUpdate}
            onOcrRegion={handleOcrRegion}
            onReorderRegion={reorderRegion}
            images={images}
            processingState={processingState}
            processAll={processAll}
            onProcessAllChange={setProcessAll}
            onTranslate={handleTranslate}
            onProcess={handleProcess}
            onStop={handleStop}
            onDownload={handleDownload}
            onApplyAsOriginal={handleApplyAsOriginalWrapper}
          />
        )}
      </main>
      
      {showGlobalSettings && (
        <Suspense fallback={null}>
          <GlobalSettings
            config={config}
            setConfig={setConfig}
            updateConfig={updateConfig}
            transModels={transModels}
            setTransModels={setTransModels}
            fetchTransModels={fetchTransModels}
            onClose={() => setShowGlobalSettings(false)}
          />
        </Suspense>
      )}
      {showHelp && (
          <Suspense fallback={null}>
              <HelpModal onClose={() => setShowHelp(false)} language={config.language} />
          </Suspense>
      )}
      {showPayloadInspector && (
          <Suspense fallback={null}>
              <PayloadInspector
                  language={config.language}
                  onClose={() => setShowPayloadInspector(false)}
              />
          </Suspense>
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
