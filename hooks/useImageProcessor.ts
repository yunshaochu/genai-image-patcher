
import React, { useState, useRef } from 'react';
import { AppConfig, ProcessingStep, UploadedImage, Region } from '../types';
import { loadImage, createMultiMaskedFullImage, createInvertedMultiMaskedFullImage, cropRegion, padImageToSquare, depadImageFromSquare, stitchImageInverted, extractCropFromFullImage, PaddingInfo } from '../services/imageUtils';
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
                    const stitchedUrl = await stitchImageInverted(imageSnapshot.previewUrl, apiResultBase64, regionsToProcess);
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
                
                if (config.enableSquareFill && paddingInfo) {
                    apiResultBase64 = await depadImageFromSquare(apiResultBase64, paddingInfo);
                }

                if (signal.aborted) return;
                const completedRegion = { ...region, processedImageBase64: apiResultBase64, status: 'completed' as const };
                regionsMap.set(region.id, completedRegion);
                
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
