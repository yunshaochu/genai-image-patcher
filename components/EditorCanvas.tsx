
import React, { useRef, useEffect, useState, useCallback } from 'react';
import { UploadedImage, Region, Language, RestoreBox } from '../types';
import { t } from '../services/translations';
import { useCanvasInteraction } from '../hooks/useCanvasInteraction';
import { renderRegionWithRestore } from '../services/imageUtils';

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
  viewMode?: 'original' | 'result';
  restoreMode?: boolean;
  onUpdateRestoreBoxes?: (regionId: string, boxes: RestoreBox[]) => void;
}

const EditorCanvas: React.FC<EditorCanvasProps> = ({ 
    image, 
    onUpdateRegions, 
    disabled = false, 
    language, 
    onOpenEditor,
    selectedRegionId,
    onSelectRegion,
    onOcrRegion,
    showOcrButton = false,
    showEditorButton = false,
    onAdjustRegionSize,
    onInteractionStart,
    viewMode = 'original',
    restoreMode = false,
    onUpdateRestoreBoxes,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedRegionRef = useRef<HTMLDivElement>(null);
  
  const { 
      interaction, 
      handleBackgroundMouseDown, 
      handleRegionMouseDown, 
      handleResizeMouseDown 
  } = useCanvasInteraction(
      containerRef,
      image,
      onUpdateRegions,
      onSelectRegion,
      onInteractionStart,
      viewMode as 'original' | 'result',
      disabled
  );

  // --- Restore mode state ---
  const [selectedRestoreRegionId, setSelectedRestoreRegionId] = useState<string | null>(null);
  const [restoreBoxDrawing, setRestoreBoxDrawing] = useState(false);
  const [restoreBoxStart, setRestoreBoxStart] = useState<{ x: number; y: number } | null>(null);
  const [restoreBoxCurrent, setRestoreBoxCurrent] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [restoreCompositedCache, setRestoreCompositedCache] = useState<Record<string, string>>({});
  const [isInverseMode, setIsInverseMode] = useState(false);

  // Update composited cache when restore boxes change
  useEffect(() => {
    const updateCache = async () => {
      const newCache: Record<string, string> = {};
      for (const region of image.regions) {
        if (region.status === 'completed' && region.processedImageBase64 && region.restoreBoxes && region.restoreBoxes.length > 0) {
          try {
            newCache[region.id] = await renderRegionWithRestore(region.processedImageBase64, region.restoreBoxes);
          } catch (e) {
            console.error('Failed to render restore for region', region.id, e);
          }
        }
      }
      setRestoreCompositedCache(newCache);
    };
    updateCache();
  }, [image.regions]);

  const getRelativeCoords = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    return { x, y };
  }, []);

  const getRegionRelativeCoords = useCallback((clientX: number, clientY: number, region: Region) => {
    const container = getRelativeCoords(clientX, clientY);
    const rx = ((container.x - region.x) / region.width) * 100;
    const ry = ((container.y - region.y) / region.height) * 100;
    return { x: Math.max(0, Math.min(100, rx)), y: Math.max(0, Math.min(100, ry)) };
  }, [getRelativeCoords]);

  // Non-passive wheel listener for the selected completed region to prevent browser zoom
  useEffect(() => {
      const el = containerRef.current;
      if (restoreMode) return; // Don't handle wheel in restore mode
      const region = image.regions.find(r => r.id === selectedRegionId);
      const isCompleted = region?.status === 'completed';
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
  }, [selectedRegionId, onAdjustRegionSize, image.regions, onInteractionStart, viewMode, restoreMode]);

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
        return { ...r, status: 'pending', processedImageBase64: undefined, restoreBoxes: undefined } as Region;
      }
      return r;
    });
    onUpdateRegions(image.id, newRegions);
  };

  // --- Restore box mouse handlers ---
  const handleRestoreContainerMouseDown = (e: React.MouseEvent) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (e.button !== 0) return;
    
    const target = e.target as HTMLElement;
    if (target.closest('[data-restore-handle]')) return;

    // Click on background deselects restore region
    if (!target.closest('[data-region-id]')) {
      setSelectedRestoreRegionId(null);
      return;
    }
  };

  const handleRestoreRegionClick = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;
    if (region.status !== 'completed') return;
    e.stopPropagation();
    setSelectedRestoreRegionId(region.id === selectedRestoreRegionId ? null : region.id);
  };

  const handleRestoreBoxMouseDown = (e: React.MouseEvent, region: Region) => {
    if (!restoreMode || !onUpdateRestoreBoxes || region.id !== selectedRestoreRegionId) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    
    const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
    setRestoreBoxDrawing(true);
    setRestoreBoxStart(coords);
    setRestoreBoxCurrent({ x: coords.x, y: coords.y, width: 0, height: 0 });
  };

  // Window-level mouse handlers for restore box drawing
  useEffect(() => {
    if (!restoreMode || !onUpdateRestoreBoxes) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (!restoreBoxDrawing || !restoreBoxStart || !selectedRestoreRegionId) return;
      const region = image.regions.find(r => r.id === selectedRestoreRegionId);
      if (!region) return;
      
      const coords = getRegionRelativeCoords(e.clientX, e.clientY, region);
      const x = Math.min(restoreBoxStart.x, coords.x);
      const y = Math.min(restoreBoxStart.y, coords.y);
      const width = Math.abs(coords.x - restoreBoxStart.x);
      const height = Math.abs(coords.y - restoreBoxStart.y);
      
      setRestoreBoxCurrent({ x, y, width, height });
    };

    const handleWindowMouseUp = () => {
      if (!restoreBoxDrawing || !restoreBoxStart || !restoreBoxCurrent || !selectedRestoreRegionId) {
        setRestoreBoxDrawing(false);
        setRestoreBoxStart(null);
        setRestoreBoxCurrent(null);
        return;
      }

      const { width, height } = restoreBoxCurrent;
      if (width > 0.5 && height > 0.5) {
        const region = image.regions.find(r => r.id === selectedRestoreRegionId);
        if (region && onUpdateRestoreBoxes) {
          const newBox: RestoreBox = {
            id: crypto.randomUUID(),
            x: restoreBoxCurrent.x,
            y: restoreBoxCurrent.y,
            width: restoreBoxCurrent.width,
            height: restoreBoxCurrent.height,
            inverse: isInverseMode,
          };
          onUpdateRestoreBoxes(selectedRestoreRegionId, [...(region.restoreBoxes || []), newBox]);
        }
      }

      setRestoreBoxDrawing(false);
      setRestoreBoxStart(null);
      setRestoreBoxCurrent(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [restoreMode, restoreBoxDrawing, restoreBoxStart, restoreBoxCurrent, selectedRestoreRegionId, image.regions, onUpdateRestoreBoxes, getRegionRelativeCoords, isInverseMode]);

  const handleClearRestoreBoxes = () => {
    if (!selectedRestoreRegionId || !onUpdateRestoreBoxes) return;
    onUpdateRestoreBoxes(selectedRestoreRegionId, []);
    setSelectedRestoreRegionId(null);
  };

  const handleDeleteRestoreBox = (regionId: string, boxId: string) => {
    if (!onUpdateRestoreBoxes) return;
    const region = image.regions.find(r => r.id === regionId);
    if (!region) return;
    onUpdateRestoreBoxes(regionId, (region.restoreBoxes || []).filter(b => b.id !== boxId));
  };

  const isOriginalMode = viewMode === 'original';
  const isRestoreActive = restoreMode && viewMode === 'result';

  return (
    <div className="relative w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
      <div 
        ref={containerRef}
        className={`relative shadow-xl transition-all ${isOriginalMode && !restoreMode ? '' : 'cursor-default'}`}
        onMouseDown={isRestoreActive ? handleRestoreContainerMouseDown : handleBackgroundMouseDown}
        style={{ cursor: isRestoreActive ? 'crosshair' : (isOriginalMode && interaction.type === 'drawing' ? 'crosshair' : 'default') }}
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
              if (isRestoreActive) {
                  const isRestoreSelected = region.id === selectedRestoreRegionId;
                  styleClasses = isRestoreSelected 
                    ? 'border-2 border-amber-400 bg-amber-400/10 shadow-[0_0_0_2px_rgba(251,191,36,0.5)] z-30 cursor-crosshair' 
                    : 'border border-white/30 bg-transparent z-10 cursor-pointer hover:border-amber-400/50';
              } else {
                  styleClasses = 'z-10 border-0'; 
              }
          } else {
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
                  if (isSelected) {
                      styleClasses = 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-20 cursor-move';
                  } else {
                      styleClasses = 'border-2 border-skin-primary hover:border-skin-primary bg-skin-primary/5 z-10 cursor-pointer';
                  }
              }
          }

          const cursorStyle = isRestoreActive ? (region.id === selectedRestoreRegionId ? 'crosshair' : 'pointer') : (isEditable ? (interaction.type === 'moving' ? 'grabbing' : 'move') : 'default');
          const handleBaseStyle = "absolute w-3.5 h-3.5 bg-white border border-skin-primary rounded-full z-30 hover:scale-125 transition-transform shadow-sm";
          const centerTransform = { transform: 'translate(-50%, -50%)' };

          return (
            <div
              key={region.id}
              ref={isSelected ? selectedRegionRef : null}
              data-region-id={region.id}
              onMouseDown={(e) => {
                if (isRestoreActive) {
                  if (region.status === 'completed') {
                    handleRestoreRegionClick(e, region);
                  }
                } else {
                  handleRegionMouseDown(e, region);
                }
              }}
              className={`absolute transition-all duration-75 group ${styleClasses}`}
              style={{
                left: `${x}%`,
                top: `${y}%`,
                width: `${width}%`,
                height: `${height}%`,
                transition: isManipulating ? 'none' : undefined,
                cursor: isOriginalMode || isRestoreActive ? cursorStyle : 'default',
                overflow: isRestoreActive ? 'hidden' : 'visible'
              }}
            >
              {/* RESULT MODE: Show Patched Image (with restore compositing if applicable) */}
              {!isOriginalMode && region.status === 'completed' && region.processedImageBase64 && (
                region.restoreBoxes && region.restoreBoxes.length > 0 ? (
                  <img 
                    src={restoreCompositedCache[region.id] || region.processedImageBase64} 
                    className="w-full h-full object-fill pointer-events-none select-none block"
                    alt="" 
                  />
                ) : (
                  <img 
                    src={region.processedImageBase64} 
                    className="w-full h-full object-fill pointer-events-none select-none block"
                    alt="" 
                  />
                )
              )}

              {/* RESTORE MODE: Box drawing overlay (only on selected region) */}
              {isRestoreActive && region.id === selectedRestoreRegionId && (
                <div
                  className="absolute inset-0 z-40 cursor-crosshair"
                  onMouseDown={(e) => handleRestoreBoxMouseDown(e, region)}
                >
                  {/* Existing restore boxes */}
                  {(region.restoreBoxes || []).map(box => (
                    <div
                      key={box.id}
                      className={`absolute border-2 pointer-events-none ${box.inverse ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                      style={{
                        left: `${box.x}%`,
                        top: `${box.y}%`,
                        width: `${box.width}%`,
                        height: `${box.height}%`,
                      }}
                    >
                      {/* Delete button */}
                      <button
                        data-restore-handle
                        className="absolute -top-2 -right-2 w-4 h-4 bg-rose-500 text-white rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto hover:bg-rose-600 z-50"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteRestoreBox(region.id, box.id);
                        }}
                        title="Delete restore box"
                      >
                        ✕
                      </button>
                      {/* Inverse toggle */}
                      <button
                        data-restore-handle
                        className={`absolute -bottom-2 -right-2 w-4 h-4 rounded-full flex items-center justify-center text-[8px] leading-none pointer-events-auto z-50 ${box.inverse ? 'bg-blue-500 text-white hover:bg-blue-600' : 'bg-rose-500 text-white hover:bg-rose-600'}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!onUpdateRestoreBoxes) return;
                          const updated = (region.restoreBoxes || []).map(b =>
                            b.id === box.id ? { ...b, inverse: !b.inverse } : b
                          );
                          onUpdateRestoreBoxes(region.id, updated);
                        }}
                        title={box.inverse ? 'Inverse (keep AI)' : 'Normal (restore original)'}
                      >
                        {box.inverse ? '⊡' : '⊞'}
                      </button>
                    </div>
                  ))}
                  {/* Drawing preview */}
                  {restoreBoxDrawing && restoreBoxCurrent && restoreBoxCurrent.width > 0 && restoreBoxCurrent.height > 0 && (
                    <div
                      className={`absolute border-2 border-dashed pointer-events-none ${isInverseMode ? 'border-blue-400 bg-blue-400/10' : 'border-rose-400 bg-rose-400/10'}`}
                      style={{
                        left: `${restoreBoxCurrent.x}%`,
                        top: `${restoreBoxCurrent.y}%`,
                        width: `${restoreBoxCurrent.width}%`,
                        height: `${restoreBoxCurrent.height}%`,
                      }}
                    />
                  )}
                </div>
              )}

              {/* RESTORE MODE: Restore box indicators on non-selected regions */}
              {isRestoreActive && region.id !== selectedRestoreRegionId && region.status === 'completed' && region.restoreBoxes && region.restoreBoxes.length > 0 && (
                <>
                  {(region.restoreBoxes || []).map(box => (
                    <div
                      key={box.id}
                      className={`absolute border pointer-events-none ${box.inverse ? 'border-blue-400/50' : 'border-rose-400/50'}`}
                      style={{
                        left: `${box.x}%`,
                        top: `${box.y}%`,
                        width: `${box.width}%`,
                        height: `${box.height}%`,
                      }}
                    />
                  ))}
                </>
              )}

              {/* ORIGINAL MODE: Resize Handles */}
              {isSelected && isEditable && !region.isRecalculating && !restoreMode && (
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
              {isSelected && !isManipulating && !region.isRecalculating && !restoreMode && (
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

        {isOriginalMode && interaction.type === 'drawing' && interaction.currentRect && !restoreMode && (
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
