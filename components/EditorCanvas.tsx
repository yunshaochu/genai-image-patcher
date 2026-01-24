import React, { useRef, useState, useEffect, MouseEvent } from 'react';
import { UploadedImage, Region } from '../types';

interface EditorCanvasProps {
  image: UploadedImage;
  onUpdateRegions: (imageId: string, regions: Region[]) => void;
  disabled?: boolean;
}

const EditorCanvas: React.FC<EditorCanvasProps> = ({ image, onUpdateRegions, disabled }) => {
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

    if (currentRect && currentRect.width && currentRect.width > 1 && currentRect.height && currentRect.height > 1) {
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
    <div className="relative w-full h-full flex items-center justify-center bg-slate-900 overflow-hidden select-none">
      <div 
        ref={containerRef}
        className="relative cursor-crosshair shadow-2xl"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => isDrawing && setIsDrawing(false)}
      >
        <img
          src={image.previewUrl}
          alt="Workarea"
          className="max-h-[80vh] max-w-full block object-contain pointer-events-none"
          draggable={false}
        />

        {/* Existing Regions */}
        {image.regions.map((region) => (
          <div
            key={region.id}
            className={`absolute border-2 transition-colors duration-200 group ${
              region.status === 'completed' 
                ? 'border-green-500 bg-green-500/10' 
                : region.status === 'processing' 
                  ? 'border-yellow-500 bg-yellow-500/10 animate-pulse' 
                  : region.status === 'failed'
                    ? 'border-red-500 bg-red-500/10'
                    : 'border-blue-400 bg-blue-400/20 hover:bg-blue-400/30'
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
                className="absolute -top-3 -right-3 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity shadow-sm hover:scale-110 z-10"
              >
                ✕
              </button>
            )}
            
            {/* Status Badge */}
            {region.status !== 'pending' && (
              <div className="absolute top-1 left-1 text-[10px] px-1 py-0.5 rounded bg-black/70 text-white backdrop-blur-sm">
                {region.status}
              </div>
            )}
          </div>
        ))}

        {/* Currently Drawing Rect */}
        {isDrawing && currentRect && (
          <div
            className="absolute border-2 border-dashed border-white bg-white/10 pointer-events-none"
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