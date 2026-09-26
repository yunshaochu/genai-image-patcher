
import { useState, useRef, useEffect } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region, isRegionPaintable, baseImageUrl } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, stitchImageInverted, extractCropFromFullImage, compressImageToTargetSize, PaddingInfo, urlToBase64, base64ToObjectURLAsync, releaseObjectURL } from '../services/imageUtils';
import { generateRegionEdit, generateTranslation } from '../services/aiService';
// `generateTranslation` is used by the translate stage (handleTranslate) and,
// only when 重绘前翻译 (config.translateBeforeRedraw) is on, by the generate
// pipeline to fill a missing translation inline. With the switch off the
// generate pipeline never calls it — translation and redraw are fully
// decoupled stages (see handleTranslate).
import { AsyncSemaphore, runWithConcurrency } from '../services/concurrencyUtils';
import { t } from '../services/translations';
import { detectBubbles } from '../services/detectionService';
import { TRANSLATION_CACHE_MARKER, splitTranslationCache, writeTranslationCache, hasCachedTranslation } from '../services/translationCache';
import { mergeGlossary } from '../services/glossary';
import { findContainedTextRegions } from '../services/mangaEditor';
import { recordPayload, PayloadTransform } from '../services/payloadLog';

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
 * The translation cache helpers (marker / split / write / has) live in
 * services/translationCache.ts — the translate stage, the generate stage and
 * the sidebar all need to agree on what "this box already has a translation"
 * means.
 */

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
    selectedImage: UploadedImage | undefined,
    /** Persist the glossary grown by the translate stage (config.glossaryText). */
    onGlossaryChange?: (glossaryText: string) => void
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

    // Live glossary for the in-flight run. `config.glossaryText` is the
    // persisted copy; a batch must not depend on a React re-render to see the
    // terms merged by an earlier image, so runs read/write this ref and flush
    // it back to the config when they finish. `configRef`/`glossaryRef` give
    // the async loops the freshest values.
    const configRef = useRef(config);
    configRef.current = config;
    const glossaryRef = useRef(config.glossaryText ?? '');
    useEffect(() => {
        // External edits (settings textarea / clear) win while no run is active.
        glossaryRef.current = config.glossaryText ?? '';
    }, [config.glossaryText]);

    /** Merge the term pairs one translation reported into the glossary ref.
     *  Returns true when the glossary actually changed. */
    const absorbTerms = (terms: string): boolean => {
        if (!terms.trim()) return false;
        const next = mergeGlossary(glossaryRef.current, terms);
        if (next === glossaryRef.current) return false;
        glossaryRef.current = next;
        return true;
    };

    /** Persist the run-grown glossary back into the config. */
    const flushGlossary = () => {
        if (!onGlossaryChange) return;
        if (glossaryRef.current === (configRef.current.glossaryText ?? '')) return;
        onGlossaryChange(glossaryRef.current);
    };

    /** 重绘前翻译: with translation mode on, the generate pipeline fills a
     *  missing translation inline (legacy behaviour) instead of redrawing
     *  without it. Off = decoupled stages (default). */
    const inlineTranslateDuringRedraw = () =>
        !!(config.enableTranslationMode && config.translateBeforeRedraw);

    /** 必须翻译 is only meaningful together with translation mode, and is moot
     *  while 重绘前翻译 auto-fills what it would otherwise wait for. */
    const requireTranslation = () =>
        !!(config.enableTranslationMode && config.requireTranslationForGeneration && !config.translateBeforeRedraw);

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

    /**
     * Process one image of the generate stage.
     *
     * Returns true when this invocation actually consumed work (built a payload
     * and/or charged an attempt to at least one region). The caller uses it to
     * detect stalled rounds — with 必须翻译 a round may legitimately do nothing
     * but skip regions, and the loop must not spin on those forever.
     */
    const processSingleImage = async (
        imageSnapshot: UploadedImage,
        signal: AbortSignal,
        globalSemaphore: AsyncSemaphore,
        localRegionState: Map<string, RegionRunState>
    ): Promise<boolean> => {
        if (signal.aborted) return false;
        if (imageSnapshot.isSkipped) return false;

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

        // Shared "this attempt failed" handler: charges one attempt to `failed`
        // (retry budget), appends the error to the diagnostics history, and
        // commits. Bases every update on the LIVE regionsMap entry so a
        // translation cached earlier in the same task isn't overwritten.
        const failRegions = (failed: readonly Region[], err: unknown) => {
            const msg = errToMsg(err);
            failed.forEach(r => {
                const base = regionsMap.get(r.id) ?? r;
                const nextHistory = [...(base.errorHistory ?? []), msg].slice(-MAX_ERROR_HISTORY);
                setRegion({
                    ...base,
                    status: 'failed' as const,
                    retryCount: (base.retryCount ?? 0) + 1,
                    errorHistory: nextHistory,
                });
            });
            updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));
        };

        // A file that cannot even be decoded must not abort the whole batch,
        // and must not leave its regions stuck in 'pending' forever (which the
        // retry loop would then re-pick endlessly): charge one attempt to every
        // in-scope region and let the loop move on.
        const loadImageOrFail = async (): Promise<HTMLImageElement | null> => {
            try {
                // baseImageUrl: after 应用为原图 the committed preview is the real
                // source — originalUrl still holds the pre-apply file, and cropping
                // regions out of it would send the AI the wrong (old) image.
                return await loadImage(baseImageUrl(imageSnapshot));
            } catch (err: any) {
                if (err?.name !== 'AbortError') {
                    const inScope = imageSnapshot.regions.filter(r =>
                        paintable(r) && (r.status === 'pending' || r.status === 'failed')
                    );
                    failRegions(inScope.length > 0 ? inScope : imageSnapshot.regions, err);
                }
                return null;
            }
        };

        // When a whole-bubble region gets AI-redrawn, the original text inside
        // it is wiped — mark contained text_bubble regions so the editor
        // typesets onto the AI bubble patch and skips erasure (aiBubbleBase).
        // NOT for inverted masking (region pixels stay original there), so
        // only call this on paths that actually replace the region's pixels.
        const markBubbleContainedTexts = (bubble: Region) => {
            if (bubble.detectedClass !== 'bubble') return;
            // Containment is defined once, in the editor's bubble ⇄ text status
            // sync (services/mangaEditor.findContainedTextRegions) — the two
            // directions must agree on which text boxes belong to a bubble.
            const all = Array.from(regionsMap.values());
            for (const r of findContainedTextRegions(all, bubble)) {
                if (r.aiBubbleBase) continue;
                setRegion({ ...r, aiBubbleBase: true });
            }
        };

        let initialRegions = [...imageSnapshot.regions];
        // An image with no paintable region of its own that gets the synthetic
        // whole-image box ("处理全图") cannot be pre-translated by the translate
        // stage (there is no region to cache against), so 必须翻译 must not
        // block it — otherwise it could never be generated at all.
        const isSyntheticFullImage = !initialRegions.some(paintable) && !!config.processFullImageIfNoRegions;
        // Regions excluded by the generation source (e.g. bubble outlines in
        // 'text' mode) don't count as paintable — an image holding ONLY those
        // is still "empty".
        if (isSyntheticFullImage) {
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
        let regionsToProcess = allActiveRegions.filter(r =>
            (r.status === 'pending' || r.status === 'failed')
            && paintable(r)
            && (r.retryCount ?? 0) < maxAttemptsPerRegion
        );

        // 必须翻译 (requireTranslationForGeneration): the redraw pipeline only
        // touches boxes whose translation has already been filled in. Boxes
        // without one are SKIPPED, not failed — they stay 'pending', so the
        // retry round below (and every later run, e.g. after the translate
        // stage has been run) re-checks them and generates as soon as the
        // translation shows up. In full-image-masking mode the translation
        // cache is image-level (one payload per image), so the whole image waits.
        if (requireTranslation() && !isSyntheticFullImage) {
            if (config.useFullImageMasking) {
                if (!hasCachedTranslation(imageSnapshot.customPrompt)) return false;
            } else {
                regionsToProcess = regionsToProcess.filter(r => hasCachedTranslation(r.customPrompt));
            }
        }
        if (regionsToProcess.length === 0) return false;

        const imgElement = await loadImageOrFail();
        if (!imgElement) return true; // an attempt was charged to the regions
        // The mask canvas is created at the source image resolution. Using the
        // original (e.g. 6000x8000) burns ~190MB of canvas memory; the preview
        // is already capped at 2048 in balanced mode, so prefer it for mask
        // input. cropRegion / single-region path keeps imgElement at full res
        // so per-region crops sent to the API stay sharp.
        let maskImg = imgElement;
        if (imageSnapshot.previewUrl && imageSnapshot.previewUrl !== imageSnapshot.originalUrl) {
            try {
                maskImg = await loadImage(imageSnapshot.previewUrl);
            } catch {
                maskImg = imgElement; // fall back to the full-res copy
            }
        }
        regionsToProcess.forEach(r => setRegion({ ...r, status: 'processing' }));
        updateImage(imageSnapshot.id, img => ({ ...img, regions: mergeProcessedRegions(img, regionsMap) }));

        if (signal.aborted) return false;
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

                // Compress for AI payload — separate encodings when 重绘前翻译 is
                // on: translation gets a smaller (token-efficient) target, redraw
                // a larger one that preserves dims for the stitch/depad workflow.
                // With the switch off only the redraw encoding is built (the
                // translation API is never called from here). Both keep pixel
                // dimensions, so masking / depadding math is unaffected.
                const inlineTranslate = inlineTranslateDuringRedraw();
                let translationPayloadUrl = payloadUrl;
                let redrawPayloadUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    translationPayloadUrl = inlineTranslate
                        ? await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB })
                        : redrawPayloadUrl;
                    // compressImageToTargetSize returns its input when the source
                    // is already small enough / unencodable — never revoke that.
                    if (redrawPayloadUrl !== payloadUrl && translationPayloadUrl !== payloadUrl) {
                        releaseObjectURL(payloadUrl);
                    }
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
                // cached = the translation block written by the translate stage.
                // Decoupled by default: generation only CONSUMES that cache — a
                // missing translation is not an error, the image is simply redrawn
                // without that context (use 必须翻译 to make it wait instead).
                // With 重绘前翻译 on, a missing translation is filled inline first
                // and persisted back into image.customPrompt for reuse next run.
                const { userPart: imageUserPart, cached: imageCachedTranslation } = splitTranslationCache(imageSnapshot.customPrompt);
                if (config.enableTranslationMode) {
                    if (imageCachedTranslation) {
                        translationText = imageCachedTranslation;
                    } else if (inlineTranslate) {
                        setProcessingState(ProcessingStep.API_CALLING);
                        const translation = await generateTranslation(
                            await getTranslationBase64(), config, signal, undefined, glossaryRef.current
                        );
                        translationText = translation.text;
                        absorbTerms(translation.terms);

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

                // Record what actually leaves the machine (masked page / padded
                // square / re-encoded) — the canvas shows none of that.
                const payloadTransforms: PayloadTransform[] = ['full-page', config.useInvertedMasking ? 'inverted-mask' : 'mask'];
                if (useSquareFill) payloadTransforms.push('square-fill');
                if (config.enableAiPayloadCompression) payloadTransforms.push('compress');
                recordPayload({
                    config,
                    phase: 'redraw',
                    imageId: imageSnapshot.id,
                    imageName: imageSnapshot.file?.name,
                    regionIds: regionsToProcess.map(r => r.id),
                    transforms: payloadTransforms,
                    prompt: effectivePrompt,
                    sentUrl: redrawPayloadUrl,
                });

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
                    // One API call per image → all its regions share the attempt.
                    failRegions(regionsToProcess, err);
                }
            } finally {
                globalSemaphore.release();
            }
            return true; // the round did work (or charged an attempt)
        }

        // Pre-generate masked full image as context for the inline translation
        // (compressed, shared across all regions). Only 重绘前翻译 needs it —
        // the translate stage builds its own copy.
        const inlineTranslate = inlineTranslateDuringRedraw();
        let maskedContextUrl: string | undefined;
        if (config.enableTranslationMode && inlineTranslate && config.sendMaskedContextForTranslation) {
            try {
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, maskRegions);
                if (config.enableAiPayloadCompression) {
                    const compressed = await compressImageToTargetSize(fullMaskedUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                    if (compressed !== fullMaskedUrl) releaseObjectURL(fullMaskedUrl);
                    maskedContextUrl = compressed;
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

                // Compress for AI payload — separate encodings when 重绘前翻译 is
                // on (smaller target for translation, larger for redraw; the
                // translate stage is never called from here otherwise). Per-region
                // crops are often already under both targets, in which case the
                // WebP encoder short-circuits at the 0.92 probe.
                let translationActiveUrl = payloadUrl;
                let redrawActiveUrl = payloadUrl;
                if (config.enableAiPayloadCompression) {
                    redrawPayloadUrl = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadRedrawTargetKB });
                    redrawActiveUrl = redrawPayloadUrl;
                    if (inlineTranslate) {
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
                // cached = the translation block written by the translate stage.
                // 解耦：重绘阶段只消费译文缓存，绝不调用翻译接口；没有译文就按
                // 原样重绘（想强制等待译文请用「必须翻译」）。开启「重绘前翻译」
                // 后则回到旧版行为：缺译文时内联调用翻译接口补齐并缓存。
                const { userPart: userCustomPrompt, cached: cachedTranslation } = splitTranslationCache(region.customPrompt);
                if (config.enableTranslationMode) {
                    if (cachedTranslation) {
                        translationText = cachedTranslation;
                    } else if (inlineTranslate) {
                        setProcessingState(ProcessingStep.API_CALLING);
                        const contextBase64 = maskedContextUrl ? await urlToBase64(maskedContextUrl) : undefined;
                        const translation = await generateTranslation(
                            await getTranslationBase64(), config, signal, contextBase64, glossaryRef.current
                        );
                        translationText = translation.text;
                        absorbTerms(translation.terms);

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
                // Use ONLY the user-written portion here; the cached translation is
                // appended separately.
                let effectivePrompt = basePrompt;
                if (userCustomPrompt) {
                    effectivePrompt += ` ${userCustomPrompt}`;
                }
                if (translationText) {
                    effectivePrompt += `\n\n${TRANSLATION_CACHE_MARKER}\n${translationText}`;
                }

                const payloadTransforms: PayloadTransform[] = ['crop'];
                if (config.enableSquareFill) payloadTransforms.push('square-fill');
                if (redrawPayloadUrl) payloadTransforms.push('compress');
                recordPayload({
                    config,
                    phase: 'redraw',
                    imageId: imageSnapshot.id,
                    imageName: imageSnapshot.file?.name,
                    regionIds: [region.id],
                    transforms: payloadTransforms,
                    prompt: effectivePrompt,
                    sentUrl: redrawActiveUrl,
                });

                let apiResultBase64 = await generateRegionEdit(await getRedrawBase64(), effectivePrompt, config, signal);
                translationBase64 = null;
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

                // Bases the update on the latest regionsMap entry — a prior
                // attempt may have set retryCount.
                failRegions([region], err);
            } finally {
                globalSemaphore.release();
            }
        };
        await runWithConcurrency(regionsToProcess, config.concurrencyLimit, processRegionTask, signal, 0);

        // Release shared context URL after all regions are done
        if (maskedContextUrl) releaseObjectURL(maskedContextUrl);

        return true; // the round attempted (or charged an attempt to) its regions
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

        // Regions still waiting for a translation when the run ends (必须翻译):
        // counted from the synchronous mirror so a lagging React commit can't
        // hide them, and reported to the user as the reason they were skipped.
        const countAwaitingTranslation = (): number => {
            let waiting = 0;
            for (const img of pickTargets()) {
                if (img.isSkipped) continue;
                for (const r of img.regions) {
                    if (!paintable(r)) continue;
                    const local = localRegionState.get(r.id);
                    const status = local?.status ?? r.status;
                    if (status !== 'pending' && status !== 'failed') continue;
                    const missing = config.useFullImageMasking
                        ? !hasCachedTranslation(img.customPrompt)
                        : !hasCachedTranslation(r.customPrompt);
                    if (missing) waiting++;
                }
            }
            return waiting;
        };

        // Consecutive rounds where nothing could be attempted. Keeps the loop
        // from spinning on regions held back by 必须翻译 (they stay 'pending').
        let noProgressRounds = 0;

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

                let didWork = false;
                if (config.executionMode === 'concurrent') {
                    const roundResults = await runWithConcurrency<UploadedImage, boolean>(
                        roundTargets,
                        config.concurrencyLimit,
                        (img) => processSingleImage(img, controller.signal, globalSemaphore, localRegionState),
                        controller.signal, 0
                    );
                    didWork = roundResults.some(Boolean);
                } else {
                    for (const img of roundTargets) {
                        if (controller.signal.aborted) break;
                        if (await processSingleImage(img, controller.signal, globalSemaphore, localRegionState)) {
                            didWork = true;
                        }
                    }
                }

                // Stalled round guard. With 必须翻译 on, a round may legitimately
                // do nothing but skip untranslated regions — they stay 'pending'
                // on purpose, so without this the loop would re-pick them for
                // ever. ONE silent round is still retried, because that retry
                // pass is what picks a region up when its translation has been
                // filled in meanwhile; a second silent round ends the run and
                // the regions simply wait for the next generate click.
                if (didWork) {
                    noProgressRounds = 0;
                } else if (++noProgressRounds >= 2) {
                    break;
                }
            }
            if (controller.signal.aborted) {
                setErrorMsg(t(config.language, 'stopped_by_user'));
            } else if (requireTranslation()) {
                const waiting = countAwaitingTranslation();
                if (waiting > 0) {
                    setErrorMsg(t(config.language, 'requireTranslationSkipped', { count: waiting }));
                }
            }
            setProcessingState(ProcessingStep.DONE);
        } catch (e: any) {
            if (e.name !== 'AbortError') {
                 setErrorMsg(e.message || "Unknown error occurred");
            }
            setProcessingState(ProcessingStep.IDLE);
        } finally {
            // Generation translates in place only when 重绘前翻译 is on (so the
            // run may have grown the glossary); with the switch off it doesn't
            // translate at all, but the flush still guards an externally edited
            // glossary from being dropped mid-run.
            flushGlossary();
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

    /**
     * Translation stage — a task INDEPENDENT from generation.
     *
     * Walks every in-scope image and fills in the translation cache
     * (region.customPrompt / image.customPrompt, see TRANSLATION_CACHE_MARKER)
     * without ever calling the redraw API. Regions that already hold a
     * translation are skipped, so the stage is resumable, cheap to re-run and
     * safe to run before/after any generation pass.
     *
     * While translating, every image also reports the term pairs it used; those
     * are merged into the project glossary (glossaryRef), which is fed into
     * every later translation prompt — so the glossary grows page by page and
     * naming stays consistent (a page with nothing new changes nothing).
     */
    const handleTranslate = async (processAll: boolean) => {
        if (abortControllerRef.current) abortControllerRef.current.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        setProcessingState(ProcessingStep.CROPPING);
        setErrorMsg(null);

        const selectedId = selectedImage?.id;
        const pickTargets = (): UploadedImage[] => {
            const live = imagesRef.current;
            return processAll
                ? live.filter(img => !img.isSkipped)
                : (selectedId ? live.filter(img => img.id === selectedId) : []);
        };
        if (pickTargets().length === 0) {
            setProcessingState(ProcessingStep.IDLE);
            return;
        }

        const limit = config.executionMode === 'serial' ? 1 : config.concurrencyLimit;
        const semaphore = new AsyncSemaphore(Math.max(1, limit));
        let failures = 0;

        /** Stamp the translation into the region's cache. `status` is the
         *  status the box had before this stage started: translating must never
         *  complete/invalidate a box, so a 'completed' patch stays completed. */
        const commitRegionTranslation = (
            imageId: string,
            regionId: string,
            translation: string,
            userPart: string,
            status: Region['status']
        ) => {
            const newCustomPrompt = writeTranslationCache(userPart, translation);
            updateImage(imageId, img => ({
                ...img,
                regions: img.regions.map(r =>
                    r.id === regionId
                        ? { ...r, customPrompt: newCustomPrompt, status }
                        : r
                ),
            }));
        };

        const setRegionStatus = (imageId: string, regionIds: string[], status: Region['status'], failure?: unknown) => {
            updateImage(imageId, img => ({
                ...img,
                regions: img.regions.map(r => {
                    if (!regionIds.includes(r.id)) return r;
                    return {
                        ...r,
                        status,
                        errorHistory: failure !== undefined
                            ? [...(r.errorHistory ?? []), errToMsg(failure)].slice(-MAX_ERROR_HISTORY)
                            : r.errorHistory,
                    };
                }),
            }));
        };

        const translateImage = async (img: UploadedImage) => {
            if (controller.signal.aborted) return;
            const paintableRegions = img.regions.filter(paintable);

            // Full-image masking: one payload per image and one image-level
            // cache entry, so either the whole page is already translated or
            // every region waits for the same call.
            if (config.useFullImageMasking) {
                if (paintableRegions.length === 0 || hasCachedTranslation(img.customPrompt)) return;
                await semaphore.acquire();
                let payloadUrl: string | undefined;
                try {
                    const imgElement = await loadImage(baseImageUrl(img));
                    const maskImg = img.previewUrl && img.previewUrl !== img.originalUrl
                        ? await loadImage(img.previewUrl)
                        : imgElement;
                    payloadUrl = config.useInvertedMasking
                        ? await createInvertedMultiMaskedFullImage(maskImg, paintableRegions)
                        : await createMultiMaskedFullImage(maskImg, paintableRegions);
                    if (config.enableAiPayloadCompression) {
                        const compressed = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                        if (compressed !== payloadUrl) releaseObjectURL(payloadUrl);
                        payloadUrl = compressed;
                    }
                    if (controller.signal.aborted) return;
                    setProcessingState(ProcessingStep.API_CALLING);
                    const payloadTransforms: PayloadTransform[] = ['full-page', config.useInvertedMasking ? 'inverted-mask' : 'mask'];
                    if (config.enableAiPayloadCompression) payloadTransforms.push('compress');
                    recordPayload({
                        config,
                        phase: 'translate',
                        imageId: img.id,
                        imageName: img.file?.name,
                        regionIds: paintableRegions.map(r => r.id),
                        transforms: payloadTransforms,
                        prompt: config.translationPrompt,
                        sentUrl: payloadUrl,
                    });
                    const result = await generateTranslation(
                        await urlToBase64(payloadUrl), config, controller.signal, undefined, glossaryRef.current
                    );
                    if (result.text) {
                        const { userPart } = splitTranslationCache(img.customPrompt);
                        const newImagePrompt = writeTranslationCache(userPart, result.text);
                        updateImage(img.id, cur => ({ ...cur, customPrompt: newImagePrompt }));
                    } else {
                        failures++; // empty answer — kept untranslated for a retry
                    }
                    absorbTerms(result.terms);
                } catch (err: any) {
                    if (err?.name !== 'AbortError') {
                        failures++;
                        console.error('[translate] page failed:', img.file?.name, err);
                    }
                } finally {
                    if (payloadUrl) releaseObjectURL(payloadUrl);
                    semaphore.release();
                }
                return;
            }

            // Standard mode: one vision call per region, each cached on its own
            // customPrompt (this is the cache 必须翻译 tests during generation).
            const regionsToTranslate = paintableRegions.filter(r => !hasCachedTranslation(r.customPrompt));
            if (regionsToTranslate.length === 0) return;

            let imgElement: HTMLImageElement;
            try {
                imgElement = await loadImage(baseImageUrl(img));
            } catch (err: any) {
                if (err?.name !== 'AbortError') failures++;
                console.error('[translate] could not load image:', img.file?.name, err);
                return;
            }

            // Optional masked whole-page context, shared by every region of this
            // image and built at most once per run. Built from the preview (not
            // the full-resolution copy) for the same memory reason as
            // processSingleImage: a 6000x8000 mask canvas is ~190MB.
            let contextUrl: string | undefined;
            if (config.sendMaskedContextForTranslation) {
                try {
                    const maskImg = img.previewUrl && img.previewUrl !== img.originalUrl
                        ? await loadImage(img.previewUrl)
                        : imgElement;
                    const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, paintableRegions);
                    if (config.enableAiPayloadCompression) {
                        const compressed = await compressImageToTargetSize(fullMaskedUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                        if (compressed !== fullMaskedUrl) releaseObjectURL(fullMaskedUrl);
                        contextUrl = compressed;
                    } else {
                        contextUrl = fullMaskedUrl;
                    }
                } catch (e) {
                    console.warn('Failed to generate masked context image for translation:', e);
                }
            }

            let contextBase64: string | undefined;
            let pageTerms = '';

            // Statuses as they were before this stage: a box that is already
            // 'completed' keeps its patch (and its status), and a translated box
            // goes back to exactly what it was so generation sees the same work
            // queue it would have seen without the translate pass.
            const statusBefore = new Map(regionsToTranslate.map(r => [r.id, r.status]));
            const restoreStatus = (regionId: string): Region['status'] =>
                statusBefore.get(regionId) ?? 'pending';

            const translateRegion = async (region: Region) => {
                if (controller.signal.aborted) return;
                await semaphore.acquire();
                let payloadUrl: string | undefined;
                const settle = (failure?: unknown) => {
                    // Failed / empty translations leave the box retryable: a
                    // later translate run re-checks it.
                    if (failure !== undefined) failures++;
                    setRegionStatus(img.id, [region.id], restoreStatus(region.id), failure);
                };
                try {
                    payloadUrl = await cropRegion(imgElement, region);
                    if (config.enableAiPayloadCompression) {
                        const compressed = await compressImageToTargetSize(payloadUrl, { targetSizeKB: config.aiPayloadTranslationTargetKB });
                        if (compressed !== payloadUrl) {
                            releaseObjectURL(payloadUrl);
                            payloadUrl = compressed;
                        }
                    }
                    if (controller.signal.aborted) return;
                    if (contextUrl && contextBase64 === undefined) {
                        contextBase64 = await urlToBase64(contextUrl);
                    }
                    setProcessingState(ProcessingStep.API_CALLING);
                    const payloadTransforms: PayloadTransform[] = ['crop'];
                    if (config.enableAiPayloadCompression) payloadTransforms.push('compress');
                    if (contextUrl) payloadTransforms.push('context');
                    recordPayload({
                        config,
                        phase: 'translate',
                        imageId: img.id,
                        imageName: img.file?.name,
                        regionIds: [region.id],
                        transforms: payloadTransforms,
                        prompt: config.translationPrompt,
                        sentUrl: payloadUrl,
                        extra: contextUrl ? { url: contextUrl, label: t(config.language, 'payloadTrContext') } : null,
                    });
                    const result = await generateTranslation(
                        await urlToBase64(payloadUrl), config, controller.signal, contextBase64, glossaryRef.current
                    );
                    if (result.text) {
                        const { userPart } = splitTranslationCache(region.customPrompt);
                        commitRegionTranslation(img.id, region.id, result.text, userPart, restoreStatus(region.id));
                    } else {
                        // The model answered with nothing usable — count it so
                        // the user gets a summary instead of a silent no-op.
                        settle(new Error('模型未返回译文'));
                    }
                    if (result.terms) pageTerms = pageTerms ? `${pageTerms}\n${result.terms}` : result.terms;
                } catch (err: any) {
                    if (err?.name === 'AbortError') return;
                    console.error('[translate] region failed:', img.file?.name, region.id, err);
                    settle(err);
                } finally {
                    if (payloadUrl) releaseObjectURL(payloadUrl);
                    semaphore.release();
                }
            };

            // Mark the page as working up-front so the canvas reflects it.
            // 'completed' boxes are left alone — their status must never be
            // downgraded, not even by the abort sweep in the caller's finally.
            const toMarkWorking = regionsToTranslate.filter(r => r.status !== 'completed');
            if (toMarkWorking.length > 0) {
                setRegionStatus(img.id, toMarkWorking.map(r => r.id), 'processing');
            }
            await runWithConcurrency(regionsToTranslate, Math.max(1, limit), translateRegion, controller.signal, 0);

            // One glossary update per page ("每翻译一张图都要更新术语表") — the
            // terms of all its regions arrive in one merge. Nothing new = the
            // merge is a no-op and the glossary is left untouched.
            absorbTerms(pageTerms);

            if (contextUrl) releaseObjectURL(contextUrl);
        };

        try {
            await runWithConcurrency(
                pickTargets(),
                Math.max(1, limit),
                (img) => translateImage(img),
                controller.signal,
                0
            );
            if (!controller.signal.aborted && failures > 0) {
                setErrorMsg(t(config.language, 'translateStageFailed', { count: failures }));
            }
            setProcessingState(ProcessingStep.DONE);
        } catch (e: any) {
            if (e?.name !== 'AbortError') setErrorMsg(e?.message || 'Translation failed');
            setProcessingState(ProcessingStep.IDLE);
        } finally {
            // Persist the glossary the run grew, then make sure no region is
            // left in 'processing' (abort paths return early).
            flushGlossary();
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
        handleAutoDetect,
        /** Translation-only stage over the whole project (independent task). */
        handleTranslate
    };
}
