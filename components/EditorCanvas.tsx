
import React, { useRef, useState, useEffect } from 'react';
import { UploadedImage, Region, Language } from '../types';
import { t } from '../services/translations';

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
  language: Language;
}

const EditorCanvas: React.FC<EditorCanvasProps> = ({ image, onUpdateRegions, disabled, language }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [currentRect, setCurrentRect] = useState<Partial<Region> | null>(null);
  
  // Use a ref to track the current rectangle during the window event lifecycle
  // to avoid re-binding event listeners on every mouse move (performance optimization).
  const currentRectRef = useRef<Partial<Region> | null>(null);

  // Calculate relative coordinates (0-100%) from clientX/clientY
  const getRelativeCoords = (clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 100;
    const y = ((clientY - rect.top) / rect.height) * 100;
    // Clamp values between 0 and 100 to ensure selection stays within image
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault(); // Prevent default drag behavior
    e.stopPropagation();

    setIsDrawing(true);
    const coords = getRelativeCoords(e.clientX, e.clientY);
    setStartPos(coords);
    
    const initialRect = {
      x: coords.x,
      y: coords.y,
      width: 0,
      height: 0,
    };
    setCurrentRect(initialRect);
    currentRectRef.current = initialRect;
  };

  // Global event listeners for smooth dragging outside bounds
  useEffect(() => {
    if (!isDrawing) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (disabled) return;
      
      const coords = getRelativeCoords(e.clientX, e.clientY);
      
      const x = Math.min(coords.x, startPos.x);
      const y = Math.min(coords.y, startPos.y);
      const width = Math.abs(coords.x - startPos.x);
      const height = Math.abs(coords.y - startPos.y);

      const newRect = { x, y, width, height };
      setCurrentRect(newRect);
      currentRectRef.current = newRect;
    };

    const handleWindowMouseUp = () => {
      setIsDrawing(false);
      
      const rect = currentRectRef.current;

      if (rect && rect.width && rect.width > 0.5 && rect.height && rect.height > 0.5) {
        const newRegion: Region = {
          id: crypto.randomUUID(),
          x: rect.x || 0,
          y: rect.y || 0,
          width: rect.width || 0,
          height: rect.height || 0,
          type: 'rect',
          status: 'pending',
        };
        onUpdateRegions(image.id, [...image.regions, newRegion]);
      }
      
      setCurrentRect(null);
      currentRectRef.current = null;
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDrawing, startPos, disabled, image.id, image.regions, onUpdateRegions]);

  const removeRegion = (regionId: string) => {
    if (disabled) return;
    onUpdateRegions(
      image.id,
      image.regions.filter((r) => r.id !== regionId)
    );
  };

  const resetRegion = (regionId: string) => {
    if (disabled) return;
    const newRegions = image.regions.map((r) => {
      if (r.id === regionId) {
        // Reset to pending and clear processed data
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
        className="relative cursor-crosshair shadow-xl"
        onMouseDown={handleMouseDown}
      >
        <img
          src={image.previewUrl}
          alt="Workarea"
          className="max-h-[85vh] max-w-full block object-contain pointer-events-none rounded bg-skin-surface shadow-sm ring-1 ring-skin-border"
          draggable={false}
        />

        {/* Existing Regions */}
        {image.regions.map((region) => (
          <div
            key={region.id}
            className={`absolute transition-all duration-200 group ${
              region.status === 'completed' 
                ? 'border-2 border-emerald-500 bg-emerald-500/10 shadow-[0_0_10px_rgba(16,185,129,0.3)]' 
                : region.status === 'processing' 
                  ? 'border-2 border-amber-500 bg-amber-500/10 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.3)]' 
                  : region.status === 'failed'
                    ? 'border-2 border-rose-500 bg-rose-500/10'
                    : 'border-2 border-skin-primary bg-skin-primary/10 shadow-[0_0_15px_rgba(99,102,241,0.2)]'
            }`}
            style={{
              left: `${region.x}%`,
              top: `${region.y}%`,
              width: `${region.width}%`,
              height: `${region.height}%`,
            }}
          >
            {/* Remove Button (Top Right) */}
            {!disabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeRegion(region.id);
                }}
                className="absolute -top-3 -right-3 w-6 h-6 bg-skin-surface text-rose-500 border border-skin-border rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-all shadow-md hover:scale-110 hover:bg-rose-50 z-20"
                title="Delete Region"
              >
                ✕
              </button>
            )}

            {/* Reset/Redo Button (Top Left) - Only for Completed/Failed */}
            {!disabled && (region.status === 'completed' || region.status === 'failed') && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  resetRegion(region.id);
                }}
                className="absolute -top-3 -left-3 w-6 h-6 bg-skin-surface text-skin-primary border border-skin-border rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-all shadow-md hover:scale-110 hover:bg-skin-fill z-20"
                title="Reset / Redo"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
              </button>
            )}
            
            {/* Status Badge */}
            {region.status !== 'pending' && (
              <div className={`absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded backdrop-blur-md shadow-sm border pointer-events-none ${
                 region.status === 'completed' ? 'bg-emerald-100/90 text-emerald-700 border-emerald-200' :
                 region.status === 'processing' ? 'bg-amber-100/90 text-amber-700 border-amber-200' :
                 'bg-rose-100/90 text-rose-700 border-rose-200'
              }`}>
                {t(language, `status_${region.status}` as any)}
              </div>
            )}
          </div>
        ))}

        {/* Currently Drawing Rect */}
        {isDrawing && currentRect && (
          <div
            className="absolute border-2 border-skin-primary bg-skin-primary/20 pointer-events-none shadow-[0_0_15px_rgba(99,102,241,0.2)]"
            style={{
              left: `${currentRect.x}%`,
              top: `${currentRect.y}%`,
              width: `${currentRect.width}%`,
              height: `${currentRect.height}%`,
            }}
          />
        )}
      </div>
    </div>
  );
};

export default EditorCanvas;
