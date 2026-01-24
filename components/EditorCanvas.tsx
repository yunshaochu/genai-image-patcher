import React, { useRef, useState, useEffect, MouseEvent } from 'react';
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

  // Calculate relative coordinates (0-100%) from mouse event
  const getRelativeCoords = (e: MouseEvent) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  const handleMouseDown = (e: MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    setIsDrawing(true);
    const coords = getRelativeCoords(e);
    setStartPos(coords);
    setCurrentRect({
      x: coords.x,
      y: coords.y,
      width: 0,
      height: 0,
    });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isDrawing || disabled) return;
    const coords = getRelativeCoords(e);
    
    const x = Math.min(coords.x, startPos.x);
    const y = Math.min(coords.y, startPos.y);
    const width = Math.abs(coords.x - startPos.x);
    const height = Math.abs(coords.y - startPos.y);

    setCurrentRect({ x, y, width, height });
  };

  const handleMouseUp = () => {
    if (!isDrawing || disabled) return;
    setIsDrawing(false);

    if (currentRect && currentRect.width && currentRect.width > 0.5 && currentRect.height && currentRect.height > 0.5) {
      const newRegion: Region = {
        id: crypto.randomUUID(),
        x: currentRect.x || 0,
        y: currentRect.y || 0,
        width: currentRect.width || 0,
        height: currentRect.height || 0,
        type: 'rect',
        status: 'pending',
      };
      onUpdateRegions(image.id, [...image.regions, newRegion]);
    }
    setCurrentRect(null);
  };

  const removeRegion = (regionId: string) => {
    if (disabled) return;
    onUpdateRegions(
      image.id,
      image.regions.filter((r) => r.id !== regionId)
    );
  };

  return (
    <div className="relative w-full h-full flex items-center justify-center p-8 overflow-hidden select-none">
      <div 
        ref={containerRef}
        className="relative cursor-crosshair shadow-xl"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => isDrawing && setIsDrawing(false)}
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
            {/* Remove Button */}
            {!disabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeRegion(region.id);
                }}
                className="absolute -top-3 -right-3 w-6 h-6 bg-skin-surface text-rose-500 border border-skin-border rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-all shadow-md hover:scale-110 hover:bg-rose-50 z-10"
              >
                ✕
              </button>
            )}
            
            {/* Status Badge - refined */}
            {region.status !== 'pending' && (
              <div className={`absolute top-1 left-1 text-[9px] font-bold px-1.5 py-0.5 rounded backdrop-blur-md shadow-sm border ${
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