
import React, { useState, useRef } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageByRatio, depadImageFromSquare, stitchImageInverted, extractCropFromFullImage, compressImage, PaddingInfo, urlToBase64, base64ToObjectURLAsync, releaseObjectURL } from '../services/imageUtils';
import { generateRegionEdit, generateTranslation } from '../services/aiService';
import { AsyncSemaphore, runWithConcurrency } from '../services/concurrencyUtils';
import { t } from '../services/translations';
import { detectBubbles } from '../services/detectionService';

export function useImageProcessor(
    images: UploadedImage[], 
    setImages: React.Dispatch<React.SetStateAction<UploadedImage[]>>,
    config: AppConfig,
    selectedImage: UploadedImage | undefined
) {
    const [processingState, setProcessingState] = useState<ProcessingStep>(ProcessingStep.IDLE);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const [isDetecting, setIsDetecting] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);

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

        const allActiveRegions = Array.from(regionsMap.values()).filter(r => r.status !== 'processing');
        const regionsToProcess = allActiveRegions.filter(r => (r.status === 'pending' || r.status === 'failed') && !r.contextOnly);
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
        setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));

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

                // Convert to base64 ONCE at the API boundary, reuse across translation + edit calls.
                let payloadBase64: string | null = null;
                const getPayloadBase64 = async () => {
                    if (payloadBase64 == null) payloadBase64 = await urlToBase64(payloadUrl);
                    return payloadBase64;
                };

                let translationText = '';
                if (config.enableTranslationMode) {
                   setProcessingState(ProcessingStep.API_CALLING);
                   translationText = await generateTranslation(await getPayloadBase64(), config, signal);
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
                let apiResultBase64 = await generateRegionEdit(await getPayloadBase64(), effectivePrompt, config, signal);
                payloadBase64 = null; // release reference; let the big string GC
                // apiResultBase64 is a data:image/... string from the API
                
                // Release the payload URL — we're done with it
                releaseObjectURL(payloadUrl);

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
                    const currentAllRegions = Array.from(regionsMap.values());

                    setImages(prev => prev.map(img => {
                        if (img.id !== imageSnapshot.id) return img;
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
                            regions: currentAllRegions, 
                            history: updatedHistory 
                        };
                    }));
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
                        const completedRegion = { ...region, processedImageBase64: finalRegionImageUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                        regionsMap.set(region.id, completedRegion);
                    }

                    const currentAllRegions = Array.from(regionsMap.values());
                    
                    setImages(prev => prev.map(img => {
                        if (img.id !== imageSnapshot.id) return img;
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

                        return { ...img, fullAiResultUrl: apiResultUrl, regions: currentAllRegions, history: updatedHistory };
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

        // Pre-generate masked full image as context for translation (compressed, shared across all regions)
        let maskedContextUrl: string | undefined;
        if (config.enableTranslationMode && config.sendMaskedContextForTranslation) {
            try {
                // Same mask-canvas size concern as the useFullImageMasking branch.
                const fullMaskedUrl = await createMultiMaskedFullImage(maskImg, allActiveRegions);
                maskedContextUrl = await compressImage(fullMaskedUrl, { maxWidth: 1024, maxHeight: 1024, quality: 0.7 });
                releaseObjectURL(fullMaskedUrl);
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

                // Convert to base64 ONCE at the API boundary, reuse across translation + edit calls.
                let payloadBase64: string | null = null;
                const getPayloadBase64 = async () => {
                    if (payloadBase64 == null) payloadBase64 = await urlToBase64(payloadUrl);
                    return payloadBase64;
                };

                let translationText = '';
                if (config.enableTranslationMode) {
                   setProcessingState(ProcessingStep.API_CALLING);
                   const contextBase64 = maskedContextUrl ? await urlToBase64(maskedContextUrl) : undefined;
                   translationText = await generateTranslation(await getPayloadBase64(), config, signal, contextBase64);
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
                let apiResultBase64 = await generateRegionEdit(await getPayloadBase64(), effectivePrompt, config, signal);
                payloadBase64 = null; // release reference; let the big string GC
                
                // Release payload URL — done with it
                releaseObjectURL(payloadUrl);
                if (paddedUrl) paddedUrl = undefined;
                if (croppedUrl) { releaseObjectURL(croppedUrl); croppedUrl = undefined; }

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
                if (oldRegion?.processedImageBase64) releaseObjectURL(oldRegion.processedImageBase64);

                const completedRegion = { ...region, processedImageBase64: apiResultUrl, status: 'completed' as const, anchorX: region.x, anchorY: region.y, anchorWidth: region.width, anchorHeight: region.height };
                regionsMap.set(region.id, completedRegion);
                apiResultUrl = undefined; // Ownership transferred to state
                
                const currentAllRegions = Array.from(regionsMap.values());
                
                setImages(prev => prev.map(img => {
                    if (img.id !== imageSnapshot.id) return img;
                    return { ...img, regions: currentAllRegions };
                }));
            } catch (err: any) {
                if (err.name === 'AbortError') return;
                // Clean up any URLs we created in this task
                if (apiResultUrl) releaseObjectURL(apiResultUrl);
                if (paddedUrl) releaseObjectURL(paddedUrl);
                if (croppedUrl) releaseObjectURL(croppedUrl);

                const failedRegion = { ...region, status: 'failed' as const };
                regionsMap.set(region.id, failedRegion);
                setImages(prev => prev.map(img => img.id !== imageSnapshot.id ? img : { ...img, regions: Array.from(regionsMap.values()) }));
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
