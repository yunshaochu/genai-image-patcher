

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
  showEditorButton?: boolean; // New Prop
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
    showEditorButton = false
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Interaction State
  const [interaction, setInteraction] = useState<InteractionState>({ type: 'idle', startPos: { x: 0, y: 0 } });
  
  // Use Refs for event listeners to avoid stale closures without constant re-binding
  const interactionRef = useRef(interaction);
  const imageRef = useRef(image);
  
  useEffect(() => { interactionRef.current = interaction; }, [interaction]);
  useEffect(() => { imageRef.current = image; }, [image]);

  // Helper: Get mouse coordinates as percentage (0-100) of the container
  const getRelativeCoords = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    // We allow dragging slightly outside to snap to edges (clamping happens in logic)
    return { x, y };
  };

  // --- Event Handlers ---

  // 1. Start Drawing (Click on empty space)
  const handleBackgroundMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    if (e.button !== 0) return; // Only left click

    const coords = getRelativeCoords(e.clientX, e.clientY);
    
    // Deselect if clicking background
    onSelectRegion(null);

    const initialRect = { x: coords.x, y: coords.y, width: 0, height: 0 };
    
    setInteraction({
      type: 'drawing',
      startPos: coords,
      currentRect: initialRect
    });
  };

  // 2. Start Moving (Click on a region)
  const handleRegionMouseDown = (e: React.MouseEvent, region: Region) => {
    if (disabled || region.status === 'processing') return;
    e.stopPropagation(); // Prevent background click
    
    // Select this region
    onSelectRegion(region.id);

    if (region.status === 'completed') return; // Cannot edit active/done regions easily without reset

    const coords = getRelativeCoords(e.clientX, e.clientY);
    
    // Initialize currentRect with existing region values so it renders immediately
    setInteraction({
      type: 'moving',
      regionId: region.id,
      startPos: coords,
      initialRegion: { ...region },
      currentRect: { ...region } 
    });
  };

  // 3. Start Resizing (Click on a handle)
  const handleResizeMouseDown = (e: React.MouseEvent, region: Region, handle: string) => {
    if (disabled) return;
    e.stopPropagation();
    
    const coords = getRelativeCoords(e.clientX, e.clientY);
    
    // Initialize currentRect with existing region values
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
             width: Math.min(100 - x, width), // Clamp width to fit
             height: Math.min(100 - y, height) // Clamp height to fit
          }
        }));
      } 
      else if (state.type === 'moving' && state.initialRegion && state.regionId) {
        // Calculate new position locally
        let newX = state.initialRegion.x + dx;
        let newY = state.initialRegion.y + dy;

        // Clamp to bounds
        newX = Math.max(0, Math.min(100 - state.initialRegion.width, newX));
        newY = Math.max(0, Math.min(100 - state.initialRegion.height, newY));

        // Update local state ONLY (fast)
        setInteraction(prev => ({
          ...prev,
          currentRect: { ...prev.currentRect, x: newX, y: newY }
        }));
      } 
      else if (state.type === 'resizing' && state.initialRegion && state.regionId && state.handle) {
        const r = state.initialRegion;
        let { x, y, width, height } = r;

        // Apply delta based on handle
        if (state.handle.includes('e')) width += dx;
        if (state.handle.includes('w')) { x += dx; width -= dx; }
        if (state.handle.includes('s')) height += dy;
        if (state.handle.includes('n')) { y += dy; height -= dy; }

        // Enforce minimum size (e.g., 0.5%)
        if (width < 0.5) {
           if (state.handle.includes('w')) x = r.x + r.width - 0.5;
           width = 0.5;
        }
        if (height < 0.5) {
           if (state.handle.includes('n')) y = r.y + r.height - 0.5;
           height = 0.5;
        }

        // Clamp to boundaries
        if (x < 0) { width += x; x = 0; }
        if (y < 0) { height += y; y = 0; }
        if (x + width > 100) width = 100 - x;
        if (y + height > 100) height = 100 - y;

        // Update local state ONLY (fast)
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
         // Commit changes to parent state on mouse up
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

  return (
    <div className="relative w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
      <div 
        ref={containerRef}
        className="relative shadow-xl"
        onMouseDown={handleBackgroundMouseDown}
        style={{ cursor: interaction.type === 'drawing' ? 'crosshair' : 'default' }}
      >
        <img
          src={image.previewUrl}
          alt="Workarea"
          className="max-h-[85vh] max-w-full block object-contain pointer-events-none rounded bg-skin-surface shadow-sm ring-1 ring-skin-border"
          draggable={false}
        />

        {/* Existing Regions */}
        {image.regions.map((region) => {
          const isSelected = selectedRegionId === region.id;
          const isEditable = !disabled && (region.status === 'pending' || region.status === 'failed');
          
          // Determine values for rendering: Use local state if currently manipulating this region
          const isManipulating = (interaction.type === 'moving' || interaction.type === 'resizing') && interaction.regionId === region.id;
          
          const x = isManipulating && interaction.currentRect?.x !== undefined ? interaction.currentRect.x : region.x;
          const y = isManipulating && interaction.currentRect?.y !== undefined ? interaction.currentRect.y : region.y;
          const width = isManipulating && interaction.currentRect?.width !== undefined ? interaction.currentRect.width : region.width;
          const height = isManipulating && interaction.currentRect?.height !== undefined ? interaction.currentRect.height : region.height;

          return (
            <div
              key={region.id}
              onMouseDown={(e) => handleRegionMouseDown(e, region)}
              className={`absolute transition-all duration-75 group ${
                isSelected 
                  ? 'z-20 border-2 border-skin-primary shadow-[0_0_0_1px_rgba(255,255,255,0.5)]' 
                  : 'z-10 border border-skin-primary/70 hover:border-skin-primary'
              } ${
                region.status === 'completed' 
                  ? 'border-emerald-500 bg-emerald-500/10' 
                  : region.status === 'processing' 
                    ? 'border-amber-500 bg-amber-500/10 animate-pulse' 
                    : region.status === 'failed'
                      ? 'border-rose-500 bg-rose-500/10'
                      : 'bg-skin-primary/10'
              }`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${width}%`,
                height: `${height}%`,
                // Remove transition during manipulation to prevent "floaty" feel
                transition: isManipulating ? 'none' : undefined,
                cursor: isEditable ? (interaction.type === 'moving' ? 'grabbing' : 'move') : 'default'
              }}
            >
              {/* Resize Handles (Only when selected and editable) */}
              {isSelected && isEditable && (
                <>
                  {/* Corners */}
                  <div className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-skin-primary rounded-full cursor-nw-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'nw')} />
                  <div className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-skin-primary rounded-full cursor-ne-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'ne')} />
                  <div className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-skin-primary rounded-full cursor-sw-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'sw')} />
                  <div className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-skin-primary rounded-full cursor-se-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'se')} />
                  
                  {/* Edges (Optional, but good for UX) */}
                  <div className="absolute top-1/2 -left-1.5 w-3 h-3 -mt-1.5 bg-white border border-skin-primary rounded-full cursor-w-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'w')} />
                  <div className="absolute top-1/2 -right-1.5 w-3 h-3 -mt-1.5 bg-white border border-skin-primary rounded-full cursor-e-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'e')} />
                  <div className="absolute -top-1.5 left-1/2 w-3 h-3 -ml-1.5 bg-white border border-skin-primary rounded-full cursor-n-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 'n')} />
                  <div className="absolute -bottom-1.5 left-1/2 w-3 h-3 -ml-1.5 bg-white border border-skin-primary rounded-full cursor-s-resize z-30" onMouseDown={(e) => handleResizeMouseDown(e, region, 's')} />
                </>
              )}

              {/* ACTION BUTTONS */}
              {/* Only show when selected and not dragging/resizing */}
              {isSelected && !isManipulating && (
                 <div 
                    className="absolute -top-8 left-1/2 -translate-x-1/2 flex gap-1 z-50"
                    onMouseDown={(e) => e.stopPropagation()} // CRITICAL: Prevent dragging start
                 >
                    
                    {/* OCR (Conditioned on Prop) */}
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

                    {/* EDIT (Conditioned on Prop) */}
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

                    {/* RESET (Only for Completed/Failed) */}
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

                    {/* DELETE */}
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
              
              {/* Status Badge */}
              {region.status !== 'pending' && !isManipulating && (
                <div className={`absolute top-0.5 left-0.5 text-[8px] font-bold px-1 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none select-none z-10 ${
                   region.status === 'completed' ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200' :
                   region.status === 'processing' ? 'bg-amber-100/90 text-amber-700 border-amber-200' :
                   'bg-rose-100/90 text-rose-700 border-rose-200'
                }`}>
                  {t(language, `status_${region.status}` as any)}
                </div>
              )}
            </div>
          );
        })}

        {/* Currently Drawing Rect (New Region) */}
        {interaction.type === 'drawing' && interaction.currentRect && (
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