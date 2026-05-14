
import { useState, useRef } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, depadImageFromSquare, stitchImageInverted, extractCropFromFullImage, compressImageToTargetSize, PaddingInfo, urlToBase64, base64ToObjectURLAsync, releaseObjectURL } from '../services/imageUtils';
import { generateRegionEdit, generateTranslation } from '../services/aiService';
import { AsyncSemaphore, runWithConcurrency } from '../services/concurrencyUtils';
import { t } from '../services/translations';
import { detectBubbles } from '../services/detectionService';

/**
 * Cap the number of error-history entries stored on a region. Each entry is
 * a short message string; keeping the most recent few is enough for the user
 * to spot patterns ("always 429" vs. "always policy violation").
 */
const MAX_ERROR_HISTORY = 5;

/** Trim a thrown error down to a single short string for UI display. */
const errToMsg = (err: any): string => {
    const raw = err?.message || String(err);
    return raw.length > 240 ? raw.slice(0, 240) + '…' : raw;
};

/**
 * Sentinel string that marks the start of a cached translation block inside
 * `region.customPrompt`. Anything BEFORE this line is treated as the user's
 * own instructions; anything AFTER is reused as the cached translation
 * result (skipping the translation API on subsequent runs).
 *
 * To force a re-translation, the user can delete this line (or the whole
 * customPrompt) in the sidebar textarea.
 */
const TRANSLATION_CACHE_MARKER = '以下是为你提供的图片文字以及文字在图上的坐标/位置数据，请参考：';

const splitTranslationCache = (prompt?: string): { userPart: string; cached: string | null } => {
    if (!prompt) return { userPart: '', cached: null };
    const idx = prompt.indexOf(TRANSLATION_CACHE_MARKER);
    if (idx < 0) return { userPart: prompt.trim(), cached: null };
    const cached = prompt.slice(idx + TRANSLATION_CACHE_MARKER.length).trim();
    return {
        userPart: prompt.slice(0, idx).trim(),
        cached: cached.length > 0 ? cached : null,
    };
};

const writeTranslationCache = (userPart: string, translation: string): string => {
    return userPart
        ? `${userPart}\n\n${TRANSLATION_CACHE_MARKER}\n${translation}`
        : `${TRANSLATION_CACHE_MARKER}\n${translation}`;
};

/**
 * Merge processing results from a regionsMap snapshot onto the LIVE image.regions
 * array, by id. Only "processing-result" fields (status, processedImageUrl,
 * anchor*) are copied; user-editable fields (x/y/w/h, customPrompt, restoreBoxes,
 * etc.) are kept from the live state so user edits made during processing —
 * dragging another region, adding a new one, editing a prompt — are preserved.
 *
 * Regions in the live state that aren't in regionsMap (e.g. newly added during
 * processing) are passed through untouched. Regions in regionsMap that the user
 * deleted from the live state are silently dropped.
 */
const mergeProcessedRegions = (
    img: UploadedImage,
    regionsMap: Map<string, Region>
): Region[] => {
    return img.regions.map(r => {
        const processed = regionsMap.get(r.id);
        if (!processed) return r;
        return {
            ...r,
            status: processed.status,
            processedImageUrl: processed.processedImageUrl ?? r.processedImageUrl,
            anchorX: processed.anchorX ?? r.anchorX,
            anchorY: processed.anchorY ?? r.anchorY,
            anchorWidth: processed.anchorWidth ?? r.anchorWidth,
            anchorHeight: processed.anchorHeight ?? r.anchorHeight,
            // Retry diagnostics — processed.* always wins so we don't lose
            // the latest count/history when a parallel region update races.
            retryCount: processed.retryCount ?? r.retryCount,
            errorHistory: processed.errorHistory ?? r.errorHistory,
        };
    });
};

export function useImageProcessor(
    images: UploadedImage[],
    updateImage: (id: string, updater: (img: UploadedImage) => UploadedImage) => void,
    updateAllImages: (updater: (img: UploadedImage) => UploadedImage) => void,
    config: AppConfig,
    selectedImage: UploadedImage | undefined
) {
    const [processingState, setProcessingState] = useState<ProcessingStep>(ProcessingStep.IDLE);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isDetecting, setIsDetecting] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Mirror of `images` for sync access inside async loops (round-based retry
    // needs to read the latest region statuses between rounds without waiting
    // for a re-render).
    const imagesRef = useRef(images);
    imagesRef.current = images;

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        updateAllImages(img => ({
            ...img,
            regions: img.regions.map(r => r.status === 'processing' ? { ...r, status: 'pending' } : r)
        }));
        setProcessingState(ProcessingStep.IDLE);
        setErrorMsg(t(config.language, 'stopped_by_user'));
    };

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
            updateImage(imageSnapshot.id, img => ({ ...img, regions: initialRegions }));
        }

        const allActiveRegions = Array.from(regionsMap.values()).filter(r => r.status !== 'processing');
        // Cap per-region attempts at (maxRetries + 1). A region that's already
        // burned through its retry budget is skipped here even if its image is
        // still being passed through the round loop (because OTHER regions in
        // it still have budget remaining).
        const maxAttemptsPerRegion = Math.max(1, (config.maxRetries ?? 0) + 1);
        const regionsToProcess = allActiveRegions.filter(r =>
            (r.status === 'pending' || r.status === 'failed')
            && !r.contextOnly
            && (r.retryCount ?? 0) < maxAttemptsPerRegion
        );
        if (regionsToProcess.length === 0) return;

        const imgElement = await loadImage(imageSnapshot.originalUrl || imageSnapshot.previewUrl);
        // The mask canvas is created at the source image resolution. Using the
        // original (e.g. 6000x8000) burns ~190MB of canvas memory; the preview
        // is already capped at 2048 in balanced mode, so prefer it for mask
        // input. cropRegion / single-region path keeps imgElement at full res
        // so per-region crops sent to the API stay sharp.
        const maskImg = imageSnapshot.previewUrl && imageSnapshot.previewUrl !== imageSnapshot.originalUrl
            ? await loadImage(imageSnapshot.previewUrl)
            : imgElement;
        regionsToProcess.forEach(r => regionsMap.set(r.id, { ...r, status: 'processing' }));
        updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));

        if (signal.aborted) return;
        setProcessingState(ProcessingStep.CROPPING);

        if (config.useFullImageMasking) {
            await globalSemaphore.acquire();
            try {
                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
                
                // Handle Inverted Masking — now returns Object URL
                let inputImageUrl: string;
                if (config.useInvertedMasking) {
                    inputImageUrl = await createInvertedMultiMaskedFullImage(maskImg, allActiveRegions);
                } else {
                    inputImageUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions);
                }

                // Square Fill Logic — returns Object URL.
                // Inverted masking already outputs a full-image patch, so padding+depad
                // is a no-op round trip that just wastes tokens / time. Skip it.
                let payloadUrl = inputImageUrl;
                let paddingInfo: PaddingInfo | null = null;
                const useSquareFill = config.enableSquareFill && !config.useInvertedMasking;
                if (useSquareFill) {
                    const padded = await padImageToSquare(inputImageUrl);
                    payloadUrl = padded.url;
                    paddingInfo = padded.info;
                    // Release the non-padded input — we now have the padded version
                    releaseObjectURL(inputImageUrl);
                }

                // Compress for AI payload — separate encodings for translation
                // (smaller target, token-efficient) and redraw (larger target,
                // preserves dims for the stitch/depad workflow). Both keep pixel
                // dimensions, so masking/depadding math is unaffected.
                let translationPayloadUrl = payloadUrl;
                let redrawPayloadUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    translationPayloadUrl = config.enableTranslationMode
                        ? await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB })
                        : redrawPayloadUrl;
                    releaseObjectURL(payloadUrl);
                }

                // Convert to base64 lazily; each API call uses its own compressed payload.
                let translationBase64: string | null = null;
                let redrawBase64: string | null = null;
                const getTranslationBase64 = async () => {
                    if (translationBase64 == null) translationBase64 = await urlToBase64(translationPayloadUrl);
                    return translationBase64;
                };
                const getRedrawBase64 = async () => {
                    if (redrawBase64 == null) redrawBase64 = await urlToBase64(redrawPayloadUrl);
                    return redrawBase64;
                };

                let translationText = '';
                // Split image-level customPrompt the same way region.customPrompt is split:
                // userPart = user-written instructions (overrides global prompt in this mode),
                // cached = prior translation block (if any). Reused → skip translation API.
                const { userPart: imageUserPart, cached: imageCachedTranslation } = splitTranslationCache(imageSnapshot.customPrompt);
                if (config.enableTranslationMode) {
                   if (imageCachedTranslation) {
                       translationText = imageCachedTranslation;
                   } else {
                       setProcessingState(ProcessingStep.API_CALLING);
                       translationText = await generateTranslation(await getTranslationBase64(), config, signal);

                       // Persist translation back into image.customPrompt for reuse next run.
                       if (translationText) {
                           const newImagePrompt = writeTranslationCache(imageUserPart, translationText);
                           updateImage(imageSnapshot.id, img => ({ ...img, customPrompt: newImagePrompt }));
                       }
                   }
                }

                setProcessingState(ProcessingStep.API_CALLING);
                // Global prompt is ALWAYS the base — image/region customPrompts append to it,
                // never replace it. Keeps the global prompt's contract (size/resolution rules,
                // style guides etc.) effective regardless of per-image overrides.
                let effectivePrompt = config.prompt.trim();
                if (imageUserPart) {
                   effectivePrompt += ` ${imageUserPart}`;
                }
                if (translationText) {
                    effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
                }
                let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, config, signal);
                translationBase64 = null;
                redrawBase64 = null;
                // apiResultBase64 is a data:image/... string from the API

                // Release the payload URLs — we're done with them
                if (translationPayloadUrl !== redrawPayloadUrl) releaseObjectURL(translationPayloadUrl);
                releaseObjectURL(redrawPayloadUrl);

                // Convert API base64 result to Object URL for further processing
                let apiResultUrl: string;
                if (apiResultBase64.startsWith('data:')) {
                    apiResultUrl = await base64ToObjectURLAsync(apiResultBase64);
                    apiResultBase64 = ''; // Allow GC of the large base64 string
                } else {
                    apiResultUrl = apiResultBase64; // Already a URL
                    apiResultBase64 = '';
                }
                
                // Depad — returns Object URL
                if (useSquareFill && paddingInfo) {
                    const depadResultUrl = config.squareFillMode === 'ratio'
                        ? await depadImageByRatio(apiResultUrl, paddingInfo)
                        : await depadImageFromSquare(apiResultUrl, paddingInfo, config.squareFillMargin);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }

                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                if (config.useInvertedMasking) {
                    const stitchedUrl = await stitchImageInverted(imageSnapshot.previewUrl, apiResultUrl, regionsToProcess);
                    regionsToProcess.forEach(r => {
                        regionsMap.set(r.id, { ...r, status: 'completed' as const });
                    });

                    updateImage(imageSnapshot.id, img => {
                        const updatedHistory = [...img.history];
                        // Release old fullAiResultUrl in history if present
                        if (updatedHistory[img.historyIndex]?.fullAiResultUrl) {
                            releaseObjectURL(updatedHistory[img.historyIndex].fullAiResultUrl);
                        }
                        if (updatedHistory[img.historyIndex]) {
                           updatedHistory[img.historyIndex] = {
                               ...updatedHistory[img.historyIndex],
                               fullAiResultUrl: apiResultUrl
                           };
                        }
                        // Release old finalResultUrl
                        if (img.finalResultUrl) releaseObjectURL(img.finalResultUrl);
                        if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                        return {
                            ...img,
                            fullAiResultUrl: apiResultUrl,
                            finalResultUrl: stitchedUrl,
                            regions: mergeProcessedRegions(img, regionsMap),
                            history: updatedHistory
                        };
                    });
                } else {
                    // Standard Masking Mode
                    for (const region of regionsToProcess) {
                        const finalRegionImageUrl = await extractCropFromFullImage(
                            apiResultUrl,
                            region,
                            maskImg.naturalWidth,
                            maskImg.naturalHeight,
                            config.fullImageOpaquePercent
                        );
                        const completedRegion = { ...region, processedImageUrl: finalRegionImageUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                        regionsMap.set(region.id, completedRegion);
                    }

                    updateImage(imageSnapshot.id, img => {
                        const updatedHistory = [...img.history];
                        if (updatedHistory[img.historyIndex]?.fullAiResultUrl) {
                            releaseObjectURL(updatedHistory[img.historyIndex].fullAiResultUrl);
                        }
                        if (updatedHistory[img.historyIndex]) {
                           updatedHistory[img.historyIndex] = {
                               ...updatedHistory[img.historyIndex],
                               fullAiResultUrl: apiResultUrl
                           };
                        }
                        if (img.fullAiResultUrl) releaseObjectURL(img.fullAiResultUrl);

                        return { ...img, fullAiResultUrl: apiResultUrl, regions: mergeProcessedRegions(img, regionsMap), history: updatedHistory };
                    });
                }
            } catch (err: any) {
                if (err.name !== 'AbortError') {
                    const msg = errToMsg(err);
                    regionsToProcess.forEach(r => {
                        const nextHistory = [...(r.errorHistory ?? []), msg].slice(-MAX_ERROR_HISTORY);
                        regionsMap.set(r.id, {
                            ...r,
                            status: 'failed' as const,
                            retryCount: (r.retryCount ?? 0) + 1,
                            errorHistory: nextHistory,
                        });
                    });
                    updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));
                }
            } finally {
                globalSemaphore.release();
            }
            return;
        }

        // Pre-generate masked full image as context for translation (compressed, shared across all regions)
        let maskedContextUrl: string | undefined;
        if (config.enableTranslationMode && config.sendMaskedContextForTranslation) {
            try {
                // Same mask-canvas size concern as the useFullImageMasking branch.
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions);
                if (config.enableAiPayloadCompression) {
                    maskedContextUrl = await compressImageToTargetSize(fullMaskedUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                    releaseObjectURL(fullMaskedUrl);
                } else {
                    maskedContextUrl = fullMaskedUrl;
                }
            } catch (e) {
                console.warn('Failed to generate masked context image for translation:', e);
                maskedContextUrl = undefined;
            }
        }

        // LEGACY / SINGLE REGION PROCESSING (Standard Mode Only)
        const processRegionTask = async (region: Region) => {
            if (signal.aborted) return;
            await globalSemaphore.acquire();
            // Track URLs created in this task for cleanup on error
            let croppedUrl: string | undefined;
            let paddedUrl: string | undefined;
            let translationPayloadUrl: string | undefined;
            let redrawPayloadUrl: string | undefined;
            let apiResultUrl: string | undefined;

            try {
                if (signal.aborted) return;
                croppedUrl = await cropRegion(imgElement, region);

                let payloadUrl = croppedUrl;
                let paddingInfo: PaddingInfo | null = null;
                if (config.enableSquareFill) {
                    const padded = await padImageToSquare(croppedUrl);
                    paddedUrl = padded.url;
                    payloadUrl = paddedUrl;
                    paddingInfo = padded.info;
                    // Release the non-padded crop — we now have the padded version
                    releaseObjectURL(croppedUrl);
                    croppedUrl = undefined;
                }

                if (signal.aborted) return;

                // Compress for AI payload — separate encodings for translation
                // (smaller target) and redraw (larger target). Per-region crops
                // are often already under both targets, in which case the WebP
                // encoder short-circuits at the 0.92 probe.
                let translationActiveUrl = payloadUrl;
                let redrawActiveUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    redrawActiveUrl = redrawPayloadUrl;
                    if (config.enableTranslationMode) {
                        translationPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                        translationActiveUrl = translationPayloadUrl;
                    } else {
                        translationActiveUrl = redrawPayloadUrl;
                    }
                    // Original (cropped/padded) no longer needed
                    releaseObjectURL(payloadUrl);
                    if (paddedUrl) paddedUrl = undefined;
                    if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }
                }

                // Convert to base64 lazily; each API call uses its own compressed payload.
                let translationBase64: string | null = null;
                let redrawBase64: string | null = null;
                const getTranslationBase64 = async () => {
                    if (translationBase64 == null) translationBase64 = await urlToBase64(translationActiveUrl);
                    return translationBase64;
                };
                const getRedrawBase64 = async () => {
                    if (redrawBase64 == null) redrawBase64 = await urlToBase64(redrawActiveUrl);
                    return redrawBase64;
                };

                let translationText = '';
                // Pre-split customPrompt up front: userPart = user instructions,
                // cached = prior translation block (if any). Reused both for the
                // cache-skip check and for rebuilding the prompt below.
                const { userPart: userCustomPrompt, cached: cachedTranslation } = splitTranslationCache(region.customPrompt);
                if (config.enableTranslationMode) {
                   if (cachedTranslation) {
                       translationText = cachedTranslation;
                   } else {
                       setProcessingState(ProcessingStep.API_CALLING);
                       const contextBase64 = maskedContextUrl ? await urlToBase64(maskedContextUrl) : undefined;
                       translationText = await generateTranslation(await getTranslationBase64(), config, signal, contextBase64);

                       // Persist the translation back into region.customPrompt so the
                       // textarea reflects the cached value and next run reuses it.
                       if (translationText) {
                           const newCustomPrompt = writeTranslationCache(userCustomPrompt, translationText);
                           const current = regionsMap.get(region.id);
                           if (current) regionsMap.set(region.id, { ...current, customPrompt: newCustomPrompt });
                           updateImage(imageSnapshot.id, img => ({
                               ...img,
                               regions: img.regions.map(r =>
                                   r.id === region.id ? { ...r, customPrompt: newCustomPrompt } : r
                               )
                           }));
                       }
                   }
                }
                setProcessingState(ProcessingStep.API_CALLING);
                // Global prompt is ALWAYS the base. image.customPrompt (when present in the
                // "no-regions auto-full-image" path) appends to it instead of replacing.
                let basePrompt = config.prompt.trim();
                if (imageSnapshot.regions.length === 0 && config.processFullImageIfNoRegions && imageSnapshot.customPrompt) {
                   const { userPart: imgUserPart } = splitTranslationCache(imageSnapshot.customPrompt);
                   if (imgUserPart) basePrompt += ` ${imgUserPart}`;
                }
                // Use ONLY the user-written portion here; translation is appended
                // separately so the format stays identical whether translation came
                // from the cache or a fresh API call.
                let effectivePrompt = basePrompt;
                if (userCustomPrompt) {
                    effectivePrompt += ` ${userCustomPrompt}`;
                }
                if (translationText) {
                    effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
                }
                let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, config, signal);
                translationBase64 = null; // release reference; let the big string GC
                redrawBase64 = null;

                // Release payload URLs — done with them
                if (translationPayloadUrl && translationPayloadUrl !== redrawPayloadUrl) {
                    releaseObjectURL(translationPayloadUrl);
                    translationPayloadUrl = undefined;
                }
                if (redrawPayloadUrl) {
                    releaseObjectURL(redrawPayloadUrl);
                    redrawPayloadUrl = undefined;
                }
                if (!config.enableAiPayloadCompression) {
                    // payloadUrl was the original cropped/padded URL, not yet released
                    releaseObjectURL(payloadUrl);
                    if (paddedUrl) paddedUrl = undefined;
                    if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }
                }

                // Convert API base64 result to Object URL
                if (apiResultBase64.startsWith('data:')) {
                    apiResultUrl = await base64ToObjectURLAsync(apiResultBase64);
                    apiResultBase64 = ''; // Allow GC
                } else {
                    apiResultUrl = apiResultBase64;
                    apiResultBase64 = '';
                }
                
                // Depad
                if (config.enableSquareFill && paddingInfo) {
                    const depadResultUrl = config.squareFillMode === 'ratio'
                        ? await depadImageByRatio(apiResultUrl, paddingInfo)
                        : await depadImageFromSquare(apiResultUrl, paddingInfo, config.squareFillMargin);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }

                if (signal.aborted) return;

                // Release old region URL before setting new one
                const oldRegion = regionsMap.get(region.id);
                if (oldRegion?.processedImageUrl) releaseObjectURL(oldRegion.processedImageUrl);

                // Base the completed region on the LATEST regionsMap entry (which may
                // already include the cached translation written into customPrompt
                // earlier in this task). Spreading the original `region` snapshot here
                // would silently overwrite that update.
                const baseRegion = regionsMap.get(region.id) ?? region;
                const completedRegion = { ...baseRegion, processedImageUrl: apiResultUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                regionsMap.set(region.id, completedRegion);
                apiResultUrl = undefined; // Ownership transferred to state

                updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                // Clean up any URLs we created in this task
                if (apiResultUrl) releaseObjectURL(apiResultUrl);
                if (translationPayloadUrl && translationPayloadUrl !== redrawPayloadUrl) releaseObjectURL(translationPayloadUrl);
                if (redrawPayloadUrl) releaseObjectURL(redrawPayloadUrl);
                if (paddedUrl) releaseObjectURL(paddedUrl);
                if (croppedUrl) releaseObjectURL(croppedUrl);

                // Base on the latest regionsMap entry — the translation-cache
                // write earlier in this task may have updated customPrompt,
                // and the round before may have set retryCount/errorHistory.
                const baseRegion = regionsMap.get(region.id) ?? region;
                const nextHistory = [...(baseRegion.errorHistory ?? []), errToMsg(err)].slice(-MAX_ERROR_HISTORY);
                const failedRegion = {
                    ...baseRegion,
                    status: 'failed' as const,
                    retryCount: (baseRegion.retryCount ?? 0) + 1,
                    errorHistory: nextHistory,
                };
                regionsMap.set(region.id, failedRegion);
                updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));
            } finally {
                globalSemaphore.release();
            }
        };
        await runWithConcurrency(regionsToProcess, config.concurrencyLimit, processRegionTask, signal, 0);

        // Release shared context URL after all regions are done
        if (maskedContextUrl) releaseObjectURL(maskedContextUrl);
    };

    const handleProcess = async (processAll: boolean) => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setProcessingState(ProcessingStep.CROPPING);
        setErrorMsg(null);

        // Pick initial targets once, BEFORE clearing diagnostics. Subsequent
        // rounds re-read live state via imagesRef so we pick up successes /
        // failures from the previous round.
        const selectedId = selectedImage?.id;
        const pickTargets = (): UploadedImage[] => {
            const live = imagesRef.current;
            return processAll
                ? live.filter(img => !img.isSkipped)
                : (selectedId ? live.filter(img => img.id === selectedId) : []);
        };

        const initialTargets = pickTargets();
        if (initialTargets.length === 0) {
            setProcessingState(ProcessingStep.IDLE);
            return;
        }

        // Clear retry diagnostics on regions about to be (re)processed so
        // counts/history reflect THIS run, not historical attempts. Only
        // touches regions in scope (pending/failed, non-contextOnly).
        const targetIds = new Set(initialTargets.map(i => i.id));
        updateAllImages(img => {
            if (!targetIds.has(img.id)) return img;
            const anyToReset = img.regions.some(r =>
                (r.status === 'pending' || r.status === 'failed') && !r.contextOnly
            );
            if (!anyToReset) return img;
            return {
                ...img,
                regions: img.regions.map(r =>
                    (r.status === 'pending' || r.status === 'failed') && !r.contextOnly
                        ? { ...r, retryCount: 0, errorHistory: [] }
                        : r
                ),
            };
        });

        const actualLimit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
        const globalSemaphore = new AsyncSemaphore(actualLimit);
        // maxRounds = first attempt + N retries. Floor at 1 so the loop runs
        // at least once even when maxRetries is misconfigured.
        const maxRounds = Math.max(1, (config.maxRetries ?? 0) + 1);

        try {
            for (let round = 0; round < maxRounds; round++) {
                if (controller.signal.aborted) break;

                // Re-snapshot each round: picks up live edits, drops images
                // that have no remaining work (all regions succeeded or are
                // capped out at retryCount >= maxRounds).
                const roundTargets = pickTargets().filter(img =>
                    img.regions.some(r =>
                        (r.status === 'pending' || r.status === 'failed')
                        && !r.contextOnly
                        && (r.retryCount ?? 0) < maxRounds
                    )
                );
                if (roundTargets.length === 0) break;

                if (config.executionMode === 'concurrent') {
                    await runWithConcurrency<UploadedImage, void>(
                        roundTargets,
                        config.concurrencyLimit,
                        (img) => processSingleImage(img, controller.signal, globalSemaphore),
                        controller.signal, 0
                    );
                } else {
                    for (const img of roundTargets) {
                        if (controller.signal.aborted) break;
                        await processSingleImage(img, controller.signal, globalSemaphore);
                    }
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
                       updateImage(img.id, currentImg => ({ ...currentImg, regions: [...currentImg.regions, ...newRegions] }));
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

    return {
        processingState,
        setProcessingState,
        errorMsg,
        setErrorMsg,
        isDetecting,
        handleProcess,
        handleStop,
        handleAutoDetect
    };
}
