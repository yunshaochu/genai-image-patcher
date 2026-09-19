
import { useState, useRef } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region, isRegionPaintable } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, stitchImageInverted, extractCropFromFullImage, compressImageToTargetSize, PaddingInfo, urlToBase64, base64ToObjectURLAsync, releaseObjectURL } from '../services/imageUtils';
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
 * Synchronous mirror of per-region status + retry count used purely for retry-loop
 * control inside handleProcess.
 *
 * We can't rely on React state (imagesRef.current) for this: setState calls inside
 * async catch handlers are batched and committed by React's scheduler as a
 * MessageChannel macrotask, but the chain from the catch back to the next while-loop
 * iteration is pure microtasks (Promise resolutions of processRegionTask →
 * runWithConcurrency's Promise.all → handleProcess's await). React has not yet
 * committed the failure update by the time the loop re-reads state, so failed
 * regions still appear to be in 'processing' status — the filter excludes them
 * and the loop exits without retrying.
 *
 * This map is updated synchronously alongside every React-state status transition
 * (line 159 'processing', success completions, failure catches). The loop reads
 * exclusively from here.
 */
type RegionRunState = {
    status: Region['status'];
    retryCount: number;
};

/**
 * True when ≥50% of `r`'s area is covered by an existing region. Used to
 * deduplicate auto-detection results against already-present boxes so that
 * re-running detection doesn't stack duplicate bubbles on an image.
 *
 * Class-aware: a `bubble` outline fully contains its `text_bubble` children,
 * so naive area dedup would either drop the children or drop the outline.
 * Dedup therefore only compares regions of the same detected class; manual /
 * legacy regions (no class) dedupe against any text class, and context-only
 * markers (bubble outlines) only dedupe against each other.
 */
const regionOverlapsExisting = (
    r: Pick<Region, 'x' | 'y' | 'width' | 'height' | 'detectedClass' | 'contextOnly'>,
    existing: readonly Pick<Region, 'x' | 'y' | 'width' | 'height' | 'detectedClass' | 'contextOnly'>[]
): boolean => {
    const rArea = r.width * r.height;
    if (rArea <= 0) return false;
    for (const e of existing) {
        // Context-only markers must not suppress, or be suppressed by, real
        // (paintable/editable) regions.
        if (r.contextOnly || e.contextOnly) {
            if (!(r.contextOnly && e.contextOnly)) continue;
        } else if (r.detectedClass && e.detectedClass && r.detectedClass !== e.detectedClass) {
            continue;
        }
        const ix = Math.min(r.x + r.width, e.x + e.width) - Math.max(r.x, e.x);
        const iy = Math.min(r.y + r.height, e.y + e.height) - Math.max(r.y, e.y);
        if (ix <= 0 || iy <= 0) continue;
        if ((ix * iy) / rArea >= 0.5) return true;
    }
    return false;
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
    // Synchronous mirror of `isDetecting` for re-entry protection — see
    // handleAutoDetect. State alone has an async commit window.
    const isDetectingRef = useRef(false);

    // Mirror of `images` for sync access inside async loops. We use it to
    // re-pick the in-scope image list each retry iteration (so newly added /
    // removed images flow through). Per-region status/retryCount for retry
    // control comes from a separate local map — see RegionRunState above.
    const imagesRef = useRef(images);
    imagesRef.current = images;

    // Which regions the AI redraw pipeline paints, governed by
    // config.generationRegionSource ('text' = text boxes, 'bubble' = whole
    // bubble outlines; text_free and manual regions always paint).
    const paintable = (r: Region): boolean =>
        isRegionPaintable(r, config.generationRegionSource ?? 'text');

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

    const processSingleImage = async (
        imageSnapshot: UploadedImage,
        signal: AbortSignal,
        globalSemaphore: AsyncSemaphore,
        localRegionState: Map<string, RegionRunState>
    ) => {
        if (signal.aborted) return;
        if (imageSnapshot.isSkipped) return;

        // Build regionsMap from imageSnapshot, but PATCH each entry with the latest
        // status/retryCount from localRegionState. This is the fix for the retry-loop
        // staleness bug: between iterations, imagesRef.current can lag behind the
        // last failure setState by one React commit cycle, so a region that just
        // failed still appears here as 'processing' (or with an old retryCount).
        // localRegionState is the synchronous truth.
        const regionsMap = new Map<string, Region>();
        imageSnapshot.regions.forEach(r => {
            const local = localRegionState.get(r.id);
            if (local) {
                regionsMap.set(r.id, { ...r, status: local.status, retryCount: local.retryCount });
            } else {
                // Region not yet tracked (e.g. added by auto-detect mid-run, or first
                // pass over a fresh image). Seed localRegionState from the snapshot.
                localRegionState.set(r.id, { status: r.status, retryCount: r.retryCount ?? 0 });
                regionsMap.set(r.id, r);
            }
        });

        // Helper to keep regionsMap and localRegionState in lockstep. ALL status
        // transitions on a region must go through this so the retry loop sees the
        // change immediately, without waiting for React to commit.
        const setRegion = (next: Region) => {
            regionsMap.set(next.id, next);
            localRegionState.set(next.id, { status: next.status, retryCount: next.retryCount ?? 0 });
        };

        // When a whole-bubble region gets AI-redrawn, the original text inside
        // it is wiped — mark contained text_bubble regions so the editor
        // typesets onto the AI bubble patch and skips erasure (aiBubbleBase).
        // NOT for inverted masking (region pixels stay original there), so
        // only call this on paths that actually replace the region's pixels.
        const markBubbleContainedTexts = (bubble: Region) => {
            if (bubble.detectedClass !== 'bubble') return;
            const bx = bubble.anchorX ?? bubble.x;
            const by = bubble.anchorY ?? bubble.y;
            const bw = bubble.anchorWidth ?? bubble.width;
            const bh = bubble.anchorHeight ?? bubble.height;
            for (const r of regionsMap.values()) {
                if (r.id === bubble.id || r.aiBubbleBase) continue;
                if (r.source !== 'auto' || r.detectedClass !== 'text_bubble') continue;
                const cx = r.x + r.width / 2;
                const cy = r.y + r.height / 2;
                if (cx >= bx && cx <= bx + bw && cy >= by && cy <= by + bh) {
                    setRegion({ ...r, aiBubbleBase: true });
                }
            }
        };

        let initialRegions = [...imageSnapshot.regions];
        // Regions excluded by the generation source (e.g. bubble outlines in
        // 'text' mode) don't count as paintable — an image holding ONLY those
        // is still "empty".
        if (!initialRegions.some(paintable) && config.processFullImageIfNoRegions) {
            const fullRegion: Region = {
                id: crypto.randomUUID(),
                x: 0, y: 0, width: 100, height: 100,
                type: 'rect',
                status: 'pending',
                source: 'manual'
            };
            initialRegions = [fullRegion];
            setRegion(fullRegion);
            updateImage(imageSnapshot.id, img => ({ ...img, regions: initialRegions }));
        }

        const allActiveRegions = Array.from(regionsMap.values()).filter(r => r.status !== 'processing');
        // Mask building only covers paintable regions — e.g. in 'text' mode
        // bubble outlines are visual context, never whited-out for the AI.
        const maskRegions = allActiveRegions.filter(paintable);
        // Cap per-region attempts at (maxRetriesPerRegion + 1). A region that's already
        // burned through its retry budget is skipped here even if its image is
        // still being passed through the outer loop (because OTHER regions in
        // it still have budget remaining).
        const maxAttemptsPerRegion = Math.max(1, (config.maxRetriesPerRegion ?? 0) + 1);
        const regionsToProcess = allActiveRegions.filter(r =>
            (r.status === 'pending' || r.status === 'failed')
            && paintable(r)
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
        regionsToProcess.forEach(r => setRegion({ ...r, status: 'processing' }));
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
                    inputImageUrl = await createInvertedMultiMaskedFullImage(maskImg, maskRegions);
                } else {
                    inputImageUrl = await createMultiMaskedFullImage(maskImg, maskRegions);
                }

                // Square Fill Logic — returns Object URL.
                // Inverted masking already outputs a full-image patch, so padding+depad
                // is a no-op round trip that just wastes tokens / time. Skip it.
                let payloadUrl = inputImageUrl;
                let paddingInfo: PaddingInfo | null = null;
                const useSquareFill = config.enableSquareFill && !config.useInvertedMasking;
                if (useSquareFill) {
                    const padded = await padImageToSquare(inputImageUrl, config.squareFillSize);
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
                
                // Depad — center-crop back to the original ratio (resolution preserved)
                if (useSquareFill && paddingInfo) {
                    const depadResultUrl = await depadImageByRatio(apiResultUrl, paddingInfo, config.squareFillCropInset);
                    releaseObjectURL(apiResultUrl);
                    apiResultUrl = depadResultUrl;
                }

                if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

                if (config.useInvertedMasking) {
                    const stitchedUrl = await stitchImageInverted(imageSnapshot.previewUrl, apiResultUrl, regionsToProcess);
                    regionsToProcess.forEach(r => {
                        // AI takes ownership: drop any editor-intermediate patch
                        // (erasure is only a typesetting intermediate state).
                        if (r.processedImageUrl) releaseObjectURL(r.processedImageUrl);
                        setRegion({ ...r, status: 'completed' as const, processedImageUrl: undefined, editorComposited: false, patchMarginX: undefined, patchMarginY: undefined });
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
                        // AI takes ownership: drop any editor-intermediate patch.
                        if (region.processedImageUrl) releaseObjectURL(region.processedImageUrl);
                        const completedRegion = { ...region, processedImageUrl: finalRegionImageUrl, status: 'completed' as const, editorComposited: false, patchMarginX: undefined, patchMarginY: undefined, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                        setRegion(completedRegion);
                        markBubbleContainedTexts(completedRegion);
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
                        setRegion({
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
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, maskRegions);
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
                    const padded = await padImageToSquare(croppedUrl, config.squareFillSize);
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
                
                // Depad — center-crop back to the original ratio (resolution preserved)
                if (config.enableSquareFill && paddingInfo) {
                    const depadResultUrl = await depadImageByRatio(apiResultUrl, paddingInfo, config.squareFillCropInset);
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
                // AI takes ownership: clear editor-composite markers so the
                // editor treats this region as read-only (AI result wins).
                const completedRegion = { ...baseRegion, processedImageUrl: apiResultUrl, status: 'completed' as const, editorComposited: false, patchMarginX: undefined, patchMarginY: undefined, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                setRegion(completedRegion);
                markBubbleContainedTexts(completedRegion);
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
                // and a prior attempt may have set retryCount/errorHistory.
                const baseRegion = regionsMap.get(region.id) ?? region;
                const nextHistory = [...(baseRegion.errorHistory ?? []), errToMsg(err)].slice(-MAX_ERROR_HISTORY);
                const failedRegion = {
                    ...baseRegion,
                    status: 'failed' as const,
                    retryCount: (baseRegion.retryCount ?? 0) + 1,
                    errorHistory: nextHistory,
                };
                setRegion(failedRegion);
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

        // Pick initial targets once, BEFORE clearing diagnostics. Each loop
        // iteration re-reads imagesRef.current to pick up images added or
        // removed mid-run; per-region status comes from localRegionState
        // (see below) so we don't depend on React's commit cycle.
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
        // touches regions in scope (pending/failed, paintable).
        const targetIds = new Set(initialTargets.map(i => i.id));
        updateAllImages(img => {
            if (!targetIds.has(img.id)) return img;
            const anyToReset = img.regions.some(r =>
                (r.status === 'pending' || r.status === 'failed') && paintable(r)
            );
            if (!anyToReset) return img;
            return {
                ...img,
                regions: img.regions.map(r =>
                    (r.status === 'pending' || r.status === 'failed') && paintable(r)
                        ? { ...r, retryCount: 0, errorHistory: [] }
                        : r
                ),
            };
        });

        const actualLimit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
        const globalSemaphore = new AsyncSemaphore(actualLimit);
        // Per-region retry budget: each region can be attempted at most
        // (maxRetriesPerRegion + 1) times. Loop terminates naturally when every
        // region has either succeeded or exhausted its budget — no artificial
        // round cap, no progress-stall heuristic.
        const maxAttemptsPerRegion = Math.max(1, (config.maxRetriesPerRegion ?? 0) + 1);

        // Synchronous mirror of per-region status + retryCount, owned by this
        // handleProcess invocation. See RegionRunState's comment for why we
        // can't read imagesRef.current between iterations. Initialize with the
        // post-reset values for in-scope regions (matching the updateAllImages
        // reset above, which is async and might not be committed yet).
        const localRegionState = new Map<string, RegionRunState>();
        for (const img of initialTargets) {
            if (img.isSkipped) continue;
            for (const r of img.regions) {
                if (!paintable(r)) continue;
                const inScope = r.status === 'pending' || r.status === 'failed';
                localRegionState.set(r.id, {
                    status: r.status,
                    retryCount: inScope ? 0 : (r.retryCount ?? 0),
                });
            }
        }

        try {
            while (true) {
                if (controller.signal.aborted) break;

                // Decide whether each image still has work by consulting localRegionState
                // (the synchronous truth) rather than imagesRef.current (which lags React's
                // commit cycle). New regions added mid-run — e.g. by auto-detect — won't be
                // in localRegionState yet, so fall back to the React state for those.
                const roundTargets = pickTargets().filter(img =>
                    img.regions.some(r => {
                        if (!paintable(r)) return false;
                        const local = localRegionState.get(r.id);
                        if (local) {
                            return (local.status === 'pending' || local.status === 'failed')
                                && local.retryCount < maxAttemptsPerRegion;
                        }
                        return (r.status === 'pending' || r.status === 'failed')
                            && (r.retryCount ?? 0) < maxAttemptsPerRegion;
                    })
                );
                if (roundTargets.length === 0) break;

                if (config.executionMode === 'concurrent') {
                    await runWithConcurrency<UploadedImage, void>(
                        roundTargets,
                        config.concurrencyLimit,
                        (img) => processSingleImage(img, controller.signal, globalSemaphore, localRegionState),
                        controller.signal, 0
                    );
                } else {
                    for (const img of roundTargets) {
                        if (controller.signal.aborted) break;
                        await processSingleImage(img, controller.signal, globalSemaphore, localRegionState);
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
        } finally {
            // Defensive sweep: every exit path (normal completion, abort, error)
            // must leave regions in a terminal state. AbortError handlers inside
            // processSingleImage / processRegionTask silently return without
            // touching status, so a region set to 'processing' at line 159 can
            // stay stuck if its task was aborted before completion. Reset any
            // such leftovers to 'pending' so the user can interact / retry.
            updateAllImages(img => {
                const stuck = img.regions.some(r => r.status === 'processing');
                if (!stuck) return img;
                return {
                    ...img,
                    regions: img.regions.map(r =>
                        r.status === 'processing' ? { ...r, status: 'pending' as const } : r
                    ),
                };
            });
        }
    };

    const handleAutoDetect = async (scope: 'current' | 'all') => {
        // Synchronous re-entry guard. `isDetecting` state alone can't prevent a
        // second invocation: the state commit is async, so a rapid second click
        // (or a delayed render) re-enters and re-detects every image.
        if (isDetectingRef.current) return;
        isDetectingRef.current = true;
        setIsDetecting(true);
        setErrorMsg(null);
        const controller = new AbortController();
        abortControllerRef.current = controller;
        try {
            const targets = scope === 'current'
               ? (selectedImage ? [selectedImage] : [])
               : images.filter(img => !img.isSkipped);
            if (targets.length === 0) {
               return;
            }
            const detectTask = async (img: UploadedImage) => {
               try {
                   const newRegions = await detectBubbles(img.previewUrl, config);
                   if (newRegions.length > 0) {
                       updateImage(img.id, currentImg => {
                           // Drop new boxes that mostly overlap an existing region
                           // (≥50% of the new box's area covered). Re-running
                           // detection (e.g. "current" then "all", or a second
                           // pass) would otherwise stack duplicate bubbles on
                           // already-detected images.
                           const accepted: Region[] = [];
                           for (const r of newRegions) {
                               if (!regionOverlapsExisting(r, currentImg.regions)
                                   && !regionOverlapsExisting(r, accepted)) {
                                   accepted.push(r);
                               }
                           }
                           if (accepted.length === 0) return currentImg; // no-op
                           return { ...currentImg, regions: [...currentImg.regions, ...accepted] };
                       });
                   }
               } catch (e: any) {
                   console.error(`Detection failed for ${img.file.name}:`, e);
               }
            };
            await runWithConcurrency(targets, config.concurrencyLimit, detectTask, controller.signal, 0);
        } catch (e: any) {
            setErrorMsg("Detection Error: " + e.message);
        } finally {
            isDetectingRef.current = false;
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
