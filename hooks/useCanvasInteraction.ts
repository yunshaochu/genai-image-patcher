
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Region } from '../types';

export type InteractionType = 'idle' | 'drawing' | 'moving' | 'resizing';

export interface InteractionState {
  type: InteractionType;
  regionId?: string;
  handle?: string;
  startPos: { x: number; y: number };
  initialRegion?: Region;
  currentRect?: Partial<Region>;
}

export function useCanvasInteraction(
    containerRef: React.RefObject<HTMLDivElement | null>,
    image: { id: string, regions: Region[] },
    onUpdateRegions: (imageId: string, regions: Region[]) => void,
    onSelectRegion: (id: string | null) => void,
    onInteractionStart?: () => void,
    viewMode: 'original' | 'result' = 'original',
    disabled: boolean = false
) {
    const [interaction, setInteraction] = useState<InteractionState>({ type: 'idle', startPos: { x: 0, y: 0 } });
    
    // Refs to avoid stale closures in event listeners
    const interactionRef = useRef(interaction);
    const imageRef = useRef(image);
    
    useEffect(() => { interactionRef.current = interaction; }, [interaction]);
    useEffect(() => { imageRef.current = image; }, [image]);

    const getRelativeCoords = (clientX: number, clientY: number) => {
        if (!containerRef.current) return { x: 0, y: 0 };
        const rect = containerRef.current.getBoundingClientRect();
        const x = ((clientX - rect.left) / rect.width) * 100;
        const y = ((clientY - rect.top) / rect.height) * 100;
        return { x, y };
    };

    const handleBackgroundMouseDown = (e: React.MouseEvent) => {
        if (disabled || viewMode === 'result') return;
        if (e.button !== 0) return;
        
        if (onInteractionStart) onInteractionStart();

        const coords = getRelativeCoords(e.clientX, e.clientY);
        onSelectRegion(null);
        const initialRect = { x: coords.x, y: coords.y, width: 0, height: 0 };
        setInteraction({
            type: 'drawing',
            startPos: coords,
            currentRect: initialRect
        });
    };

    const handleRegionMouseDown = (e: React.MouseEvent, region: Region) => {
        if (disabled || region.status === 'processing' || viewMode === 'result') return;
        e.stopPropagation();
        
        if (onInteractionStart) onInteractionStart();

        onSelectRegion(region.id);
        
        const coords = getRelativeCoords(e.clientX, e.clientY);
        setInteraction({
            type: 'moving',
            regionId: region.id,
            startPos: coords,
            initialRegion: { ...region },
            currentRect: { ...region }
        });
    };

    const handleResizeMouseDown = (e: React.MouseEvent, region: Region, handle: string) => {
        if (disabled || viewMode === 'result') return;
        e.stopPropagation();
        
        if (onInteractionStart) onInteractionStart();

        const coords = getRelativeCoords(e.clientX, e.clientY);
        setInteraction({
            type: 'resizing',
            regionId: region.id,
            handle,
            startPos: coords,
            initialRegion: { ...region },
            currentRect: { ...region }
        });
    };

    useEffect(() => {
        const handleWindowMouseMove = (e: MouseEvent) => {
            const state = interactionRef.current;
            if (state.type === 'idle') return;
            if (disabled) return;
            const coords = getRelativeCoords(e.clientX, e.clientY);
            const dx = coords.x - state.startPos.x;
            const dy = coords.y - state.startPos.y;

            if (state.type === 'drawing') {
                const x = Math.min(coords.x, state.startPos.x);
                const y = Math.min(coords.y, state.startPos.y);
                const width = Math.abs(coords.x - state.startPos.x);
                const height = Math.abs(coords.y - state.startPos.y);
                setInteraction(prev => ({
                    ...prev,
                    currentRect: { 
                        x: Math.max(0, Math.min(100, x)), 
                        y: Math.max(0, Math.min(100, y)), 
                        width: Math.min(100 - x, width), 
                        height: Math.min(100 - y, height) 
                    }
                }));
            } else if (state.type === 'moving' && state.initialRegion && state.regionId) {
                let newX = state.initialRegion.x + dx;
                let newY = state.initialRegion.y + dy;
                newX = Math.max(0, Math.min(100 - state.initialRegion.width, newX));
                newY = Math.max(0, Math.min(100 - state.initialRegion.height, newY));
                setInteraction(prev => ({
                    ...prev,
                    currentRect: { ...prev.currentRect, x: newX, y: newY }
                }));
            } else if (state.type === 'resizing' && state.initialRegion && state.regionId && state.handle) {
                const r = state.initialRegion;
                let { x, y, width, height } = r;
                if (state.handle.includes('e')) width += dx;
                if (state.handle.includes('w')) { x += dx; width -= dx; }
                if (state.handle.includes('s')) height += dy;
                if (state.handle.includes('n')) { y += dy; height -= dy; }
                
                if (width < 0.5) {
                    if (state.handle.includes('w')) x = r.x + r.width - 0.5;
                    width = 0.5;
                }
                if (height < 0.5) {
                    if (state.handle.includes('n')) y = r.y + r.height - 0.5;
                    height = 0.5;
                }
                
                if (x < 0) { width += x; x = 0; }
                if (y < 0) { height += y; y = 0; }
                if (x + width > 100) width = 100 - x;
                if (y + height > 100) height = 100 - y;

                setInteraction(prev => ({
                    ...prev,
                    currentRect: { x, y, width, height }
                }));
            }
        };

        const handleWindowMouseUp = () => {
            const state = interactionRef.current;
            if (state.type === 'idle') return;

            if (state.type === 'drawing' && state.currentRect) {
                const { x, y, width, height } = state.currentRect;
                if (width && height && width > 0.5 && height > 0.5) {
                    const newRegion: Region = {
                        id: crypto.randomUUID(),
                        x: x || 0,
                        y: y || 0,
                        width: width || 0,
                        height: height || 0,
                        type: 'rect',
                        status: 'pending',
                        source: 'manual',
                        customPrompt: ''
                    };
                    onUpdateRegions(imageRef.current.id, [...imageRef.current.regions, newRegion]);
                    onSelectRegion(newRegion.id); 
                }
            } else if ((state.type === 'moving' || state.type === 'resizing') && state.currentRect && state.regionId) {
                const updatedRegions = imageRef.current.regions.map(r => 
                    r.id === state.regionId 
                        ? { ...r, ...state.currentRect } as Region
                        : r
                );
                onUpdateRegions(imageRef.current.id, updatedRegions);
            }
            setInteraction({ type: 'idle', startPos: { x: 0, y: 0 } });
        };

        window.addEventListener('mousemove', handleWindowMouseMove);
        window.addEventListener('mouseup', handleWindowMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleWindowMouseMove);
            window.removeEventListener('mouseup', handleWindowMouseUp);
        };
    }, [disabled, onUpdateRegions, onSelectRegion]);

    return {
        interaction,
        handleBackgroundMouseDown,
        handleRegionMouseDown,
        handleResizeMouseDown
    };
}
