
import React, { useRef, useState, useEffect } from 'react';
import { UploadedImage, Region, Language } from '../types';
import { t } from '../services/translations';

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
  language: Language;
  onOpenEditor: (regionId: string) => void;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string | null) => void;
  onOcrRegion?: (regionId: string) => void;
  showOcrButton?: boolean;
  showEditorButton?: boolean;
  onAdjustRegionSize?: (regionId: string, isExpand: boolean) => void;
  onInteractionStart?: () => void; 
  viewMode?: 'original' | 'result'; // Controlled by parent
}

type InteractionType = 'idle' | 'drawing' | 'moving' | 'resizing';

interface InteractionState {
  type: InteractionType;
  regionId?: string; // For moving/resizing
  handle?: string; // For resizing (n, s, e, w, ne, nw, se, sw)
  startPos: { x: number; y: number }; // Mouse start position (percentage)
  initialRegion?: Region; // Snapshot of region before mod
  currentRect?: Partial<Region>; // Visual temporary rect for drawing/moving/resizing
}

const EditorCanvas: React.FC<EditorCanvasProps> = ({ 
    image, 
    onUpdateRegions, 
    disabled, 
    language, 
    onOpenEditor,
    selectedRegionId,
    onSelectRegion,
    onOcrRegion,
    showOcrButton = false,
    showEditorButton = false,
    onAdjustRegionSize,
    onInteractionStart,
    viewMode = 'original'
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRegionRef = useRef<HTMLDivElement>(null);
  
  // Interaction State
  const [interaction, setInteraction] = useState<InteractionState>({ type: 'idle', startPos: { x: 0, y: 0 } });
  
  // Use Refs for event listeners to avoid stale closures without constant re-binding
  const interactionRef = useRef(interaction);
  const imageRef = useRef(image);
  
  useEffect(() => { interactionRef.current = interaction; }, [interaction]);
  useEffect(() => { imageRef.current = image; }, [image]);

  // Non-passive wheel listener for the selected completed region to prevent browser zoom
  useEffect(() => {
      const el = selectedRegionRef.current;
      // Only attach if we have a selected region that is completed (editable result)
      const region = image.regions.find(r => r.id === selectedRegionId);
      const isCompleted = region?.status === 'completed';

      // Only allow adjustment in ORIGINAL mode
      if (!el || !onAdjustRegionSize || !selectedRegionId || !isCompleted || viewMode !== 'original') return;

      const handleWheel = (e: WheelEvent) => {
          if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              e.stopPropagation();
              if (onInteractionStart) onInteractionStart();
              
              const isExpand = e.deltaY < 0; 
              onAdjustRegionSize(selectedRegionId, isExpand);
          }
      };

      el.addEventListener('wheel', handleWheel, { passive: false });
      return () => {
          el.removeEventListener('wheel', handleWheel);
      };
  }, [selectedRegionId, onAdjustRegionSize, image.regions, onInteractionStart, viewMode]);

  // Helper: Get mouse coordinates as percentage (0-100) of the container
  const getRelativeCoords = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x, y };
  };

  const handleBackgroundMouseDown = (e: React.MouseEvent) => {
    if (disabled || viewMode === 'result') return; // No drawing in result mode
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
    if (disabled || region.status === 'processing' || viewMode === 'result') return; // No moving in result mode
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

  // Global Mouse Move & Up
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
      } 
      else if (state.type === 'moving' && state.initialRegion && state.regionId) {
        let newX = state.initialRegion.x + dx;
        let newY = state.initialRegion.y + dy;
        newX = Math.max(0, Math.min(100 - state.initialRegion.width, newX));
        newY = Math.max(0, Math.min(100 - state.initialRegion.height, newY));
        setInteraction(prev => ({
          ...prev,
          currentRect: { ...prev.currentRect, x: newX, y: newY }
        }));
      } 
      else if (state.type === 'resizing' && state.initialRegion && state.regionId && state.handle) {
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
      }
      else if ((state.type === 'moving' || state.type === 'resizing') && state.currentRect && state.regionId) {
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

  const removeRegion = (regionId: string) => {
    if (disabled) return;
    onUpdateRegions(
      image.id,
      image.regions.filter((r) => r.id !== regionId)
    );
    if (selectedRegionId === regionId) onSelectRegion(null);
  };

  const resetRegion = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map((r) => {
      if (r.id === regionId) {
        return { ...r, status: 'pending', processedImageBase64: undefined } as Region;
      }
      return r;
    });
    onUpdateRegions(image.id, newRegions);
  };

  const isOriginalMode = viewMode === 'original';

  return (
    <div className="relative w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
      <div 
        ref={containerRef}
        className={`relative shadow-xl transition-all ${isOriginalMode ? '' : 'cursor-default'}`}
        onMouseDown={handleBackgroundMouseDown}
        style={{ cursor: isOriginalMode && interaction.type === 'drawing' ? 'crosshair' : 'default' }}
      >
        {/* Base Image (Always Visible) */}
        <img
          src={image.previewUrl}
          alt="Workarea"
          className="max-h-[85vh] max-w-full block object-contain pointer-events-none rounded bg-skin-surface shadow-sm ring-1 ring-skin-border"
          draggable={false}
        />

        {/* Regions */}
        {image.regions.map((region) => {
          const isSelected = selectedRegionId === region.id && isOriginalMode;
          const isEditable = isOriginalMode && !disabled && region.status !== 'processing';
          
          const isManipulating = (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === region.id;
          
          const x = isManipulating && interaction.currentRect?.x !== undefined ? interaction.currentRect.x : region.x;
          const y = isManipulating && interaction.currentRect?.y !== undefined ? interaction.currentRect.y : region.y;
          const width = isManipulating && interaction.currentRect?.width !== undefined ? interaction.currentRect.width : region.width;
          const height = isManipulating && interaction.currentRect?.height !== undefined ? interaction.currentRect.height : region.height;

          // STYLE GENERATION
          let styleClasses = '';
          
          if (!isOriginalMode) {
              // RESULT MODE: 
              // Invisible container mostly, but needs to be positioned for the img inside.
              // No borders.
              styleClasses = 'z-10 border-0'; 
          } else {
              // ORIGINAL MODE: Show borders/status
              if (region.status === 'processing') {
                  styleClasses = 'border-2 border-amber-500 bg-amber-500/10 animate-pulse z-20';
              } else if (region.status === 'failed') {
                  styleClasses = 'border-2 border-rose-500 bg-rose-500/10 z-10';
              } else if (region.status === 'completed') {
                  if (region.isRecalculating) {
                      styleClasses = 'border-2 border-yellow-500 bg-yellow-500/20 animate-pulse z-30';
                  } else if (isSelected) {
                      styleClasses = 'border-2 border-emerald-500 bg-emerald-500/20 shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_4px_#10b981] z-30 cursor-move';
                  } else {
                      styleClasses = 'border-2 border-emerald-500 bg-emerald-500/10 z-10 cursor-pointer';
                  }
              } else {
                  // PENDING
                  if (isSelected) {
                      styleClasses = 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-20 cursor-move';
                  } else {
                      styleClasses = 'border-2 border-skin-primary hover:border-skin-primary bg-skin-primary/5 z-10 cursor-pointer';
                  }
              }
          }

          // Force cursor for manipulation
          const cursorStyle = isEditable ? (interaction.type === 'moving' ? 'grabbing' : 'move') : 'default';

          // Handle Style
          const handleBaseStyle = "absolute w-3.5 h-3.5 bg-white border border-skin-primary rounded-full z-30 hover:scale-125 transition-transform shadow-sm";
          const centerTransform = { transform: 'translate(-50%, -50%)' };

          return (
            <div
              key={region.id}
              ref={isSelected ? selectedRegionRef : null}
              onMouseDown={(e) => handleRegionMouseDown(e, region)}
              className={`absolute transition-all duration-75 group ${styleClasses}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${width}%`,
                height: `${height}%`,
                transition: isManipulating ? 'none' : undefined,
                cursor: isOriginalMode ? cursorStyle : 'default'
              }}
            >
              {/* RESULT MODE: Show Patched Image Floating */}
              {!isOriginalMode && region.status === 'completed' && region.processedImageBase64 && (
                  <img 
                    src={region.processedImageBase64} 
                    className="w-full h-full object-fill pointer-events-none select-none block"
                    alt="" 
                  />
              )}

              {/* ORIGINAL MODE: Resize Handles */}
              {isSelected && isEditable && !region.isRecalculating && (
                <>
                  <div className={`${handleBaseStyle} cursor-nw-resize`} style={{ left: '0%', top: '0%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'nw')} />
                  <div className={`${handleBaseStyle} cursor-ne-resize`} style={{ left: '100%', top: '0%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'ne')} />
                  <div className={`${handleBaseStyle} cursor-sw-resize`} style={{ left: '0%', top: '100%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'sw')} />
                  <div className={`${handleBaseStyle} cursor-se-resize`} style={{ left: '100%', top: '100%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'se')} />
                  
                  <div className={`${handleBaseStyle} cursor-n-resize`} style={{ left: '50%', top: '0%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'n')} />
                  <div className={`${handleBaseStyle} cursor-s-resize`} style={{ left: '50%', top: '100%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 's')} />
                  <div className={`${handleBaseStyle} cursor-w-resize`} style={{ left: '0%', top: '50%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'w')} />
                  <div className={`${handleBaseStyle} cursor-e-resize`} style={{ left: '100%', top: '50%', ...centerTransform }} onMouseDown={(e) => handleResizeMouseDown(e, region, 'e')} />
                </>
              )}

              {/* ORIGINAL MODE: Action Buttons */}
              {isSelected && !isManipulating && !region.isRecalculating && (
                 <div 
                    className="absolute -top-9 left-1/2 -translate-x-1/2 flex gap-1 z-50"
                    onMouseDown={(e) => e.stopPropagation()} 
                 >
                    {!disabled && onOcrRegion && showOcrButton && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOcrRegion(region.id);
                          }}
                          className={`w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:scale-110 hover:shadow-lg transition-all ${region.isOcrLoading ? 'opacity-70 cursor-wait' : ''}`}
                          title={t(language, 'ocrBtn')}
                          disabled={region.isOcrLoading}
                        >
                          {region.isOcrLoading ? (
                             <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>
                          ) : (
                             <span className="text-[9px] font-bold tracking-tighter">OCR</span>
                          )}
                        </button>
                    )}
                    {!disabled && showEditorButton && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenEditor(region.id);
                          }}
                          className="w-6 h-6 bg-skin-primary text-skin-primary-fg border border-transparent rounded-full flex items-center justify-center shadow-md hover:scale-110 hover:shadow-lg transition-all"
                          title="Edit Patch (Brush/Text)"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                        </button>
                    )}
                    {!disabled && (region.status === 'completed' || region.status === 'failed') && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            resetRegion(region.id);
                          }}
                          className="w-6 h-6 bg-skin-surface text-skin-text border border-skin-border rounded-full flex items-center justify-center shadow-md hover:scale-110 hover:bg-skin-fill transition-all"
                          title="Reset / Redo"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                        </button>
                    )}
                    {!disabled && region.status !== 'processing' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeRegion(region.id);
                          }}
                          className="w-6 h-6 bg-skin-surface text-rose-500 border border-skin-border rounded-full flex items-center justify-center shadow-md hover:scale-110 hover:bg-rose-50 transition-all"
                          title="Delete Region"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                        </button>
                    )}
                 </div>
              )}
              
              {/* ORIGINAL MODE: Status Badge */}
              {isOriginalMode && (region.status !== 'pending' || region.isRecalculating) && !isManipulating && (
                <div className={`absolute top-0.5 left-0.5 text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${
                   region.isRecalculating ? 'bg-yellow-100/90 text-yellow-700 border-yellow-200' :
                   region.status === 'completed' ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200' :
                   region.status === 'processing' ? 'bg-amber-100/90 text-amber-700 border-amber-200' :
                   'bg-rose-100/90 text-rose-700 border-rose-200'
                }`}>
                  {region.isRecalculating ? 'REFINE' : t(language, `status_${region.status}` as any)}
                </div>
              )}

              {/* ORIGINAL MODE: Refinement Tip */}
              {isOriginalMode && isSelected && region.status === 'completed' && image.fullAiResultUrl && !region.isRecalculating && (
                  <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[9px] text-emerald-600 font-bold whitespace-nowrap bg-skin-surface px-2 py-0.5 rounded shadow-sm border border-emerald-200 animate-bounce pointer-events-none">
                    Ctrl + Scroll to adjust
                  </div>
              )}
            </div>
          );
        })}

        {isOriginalMode && interaction.type === 'drawing' && interaction.currentRect && (
          <div
            className="absolute border-2 border-dashed border-skin-primary bg-skin-primary/20 pointer-events-none z-50"
            style={{
              left: `${interaction.currentRect.x}%`,
              top: `${interaction.currentRect.y}%`,
              width: `${interaction.currentRect.width}%`,
              height: `${interaction.currentRect.height}%`,
            }}
          />
        )}
      </div>
    </div>
  );
};

export default EditorCanvas;
