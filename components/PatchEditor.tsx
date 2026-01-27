

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { Language } from '../types';
import { t } from '../services/translations';
import { loadImage } from '../services/imageUtils';

export interface TextObject {
  id: string;
  x: number;
  y: number;
  width?: number; // Optional width constraint (pixels)
  height?: number; // Optional height constraint (pixels)
  text: string;
  fontSize: number;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  backgroundColor: string; // 'transparent' or hex
  isVertical: boolean;
  isBold: boolean;
  rotation: number;
}

interface PatchEditorProps {
  imageBase64: string; // The starting image (usually the cropped source or existing result)
  onSave: (newBase64: string) => void;
  onCancel: () => void;
  language: Language;
  initialTextObjects?: TextObject[]; // Optional initial text objects
  defaultVertical?: boolean; // Default text orientation from config
}

type Tool = 'brush' | 'text';

// History State Structure
interface HistoryState {
  imageData: ImageData | null;
  textObjects: TextObject[];
}

const PatchEditor: React.FC<PatchEditorProps> = ({ imageBase64, onSave, onCancel, language, initialTextObjects, defaultVertical = false }) => {
  const [activeTool, setActiveTool] = useState<Tool>('brush');
  
  // Canvas Refs
  const containerRef = useRef<HTMLDivElement>(null); // The inner scaling wrapper
  const viewportRef = useRef<HTMLDivElement>(null);  // The outer scrolling container
  const baseCanvasRef = useRef<HTMLCanvasElement>(null); // Holds the base image
  const drawingCanvasRef = useRef<HTMLCanvasElement>(null); // Holds brush strokes
  
  // Zoom State
  const [zoom, setZoom] = useState(1);
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
  
  // History State
  const [history, setHistory] = useState<HistoryState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const isHistoryProcessing = useRef(false); // Prevents recursive updates during undo/redo

  // Brush State
  const [brushSize, setBrushSize] = useState(15);
  const [brushColor, setBrushColor] = useState('#ffffff');
  const [isDrawing, setIsDrawing] = useState(false);
  
  // Text State
  const [textObjects, setTextObjects] = useState<TextObject[]>(initialTextObjects || []);
  const [selectedTextId, setSelectedTextId] = useState<string | null>(null);
  const [isDraggingText, setIsDraggingText] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const didTextMove = useRef(false);
  const isHoveringSelectedTextRef = useRef(false); // Track hover state for wheel conflict resolution

  // Mouse Wheel Zoom Reference
  const mousePosRef = useRef<{ relX: number; relY: number; clientX: number; clientY: number } | null>(null);

  // --- Zoom Logic ---
  const handleZoomIn = () => setZoom(z => Math.min(z * 1.2, 10.0));
  const handleZoomOut = () => setZoom(z => Math.max(z / 1.2, 0.1));
  const handleZoomReset = () => setZoom(1);

  // Calculate the scale needed to fit the image entirely within the viewport
  const calculateFitZoom = useCallback((w: number, h: number) => {
    if (!viewportRef.current) return 1;
    
    // Add some padding (e.g., 64px total)
    const availableW = viewportRef.current.clientWidth - 64;
    const availableH = viewportRef.current.clientHeight - 64;
    
    if (availableW <= 0 || availableH <= 0) return 1;

    const scaleW = availableW / w;
    const scaleH = availableH / h;
    
    // Use the smaller scale to ensure it fits both dimensions
    // Cap at 1.0 (don't upscale small images automatically)
    return Math.min(scaleW, scaleH, 1);
  }, []);

  const handleZoomFit = () => {
     if (imgDims.w && imgDims.h) {
         setZoom(calculateFitZoom(imgDims.w, imgDims.h));
     }
  };

  // --- Wheel Zoom Effect ---
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const onWheel = (e: WheelEvent) => {
      // PRIORITY 1: Font Resizing (Conflict Resolution)
      // If hovering over the SELECTED text box, wheel controls font size instead of zoom/pan
      if (isHoveringSelectedTextRef.current && selectedTextId) {
          e.preventDefault();
          e.stopPropagation();

          const delta = Math.sign(e.deltaY) * -2; // Scroll Up (neg) -> Grow (+), Scroll Down (pos) -> Shrink (-)
          
          setTextObjects(prev => prev.map(t => {
              if (t.id === selectedTextId) {
                  // Limit font size between 8 and 300
                  const newSize = Math.max(8, Math.min(300, t.fontSize + delta));
                  return { ...t, fontSize: newSize };
              }
              return t;
          }));
          return;
      }

      // PRIORITY 2: Canvas Zoom
      // Ctrl+Wheel (or Meta+Wheel) to Zoom
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        // Calculate cursor position relative to the unscaled image coordinates
        const relX = (e.clientX - rect.left) / zoom;
        const relY = (e.clientY - rect.top) / zoom;

        mousePosRef.current = { relX, relY, clientX: e.clientX, clientY: e.clientY };

        const delta = -e.deltaY;
        setZoom(prev => {
             // Use proportional zoom for smoother experience
             const factor = delta > 0 ? 1.1 : 0.9;
             return Math.min(Math.max(prev * factor, 0.1), 10.0);
        });
      }
    };

    // passive: false is required to preventDefault (browser zoom)
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoom, selectedTextId]); // Add selectedTextId to deps so logic works

  // Adjust scroll position after zoom to keep mouse focused
  useLayoutEffect(() => {
    if (mousePosRef.current && containerRef.current && viewportRef.current) {
        const { relX, relY, clientX, clientY } = mousePosRef.current;
        const rect = containerRef.current.getBoundingClientRect();
        
        // Calculate where the point (relX, relY) is currently rendered
        const currentX = rect.left + relX * zoom;
        const currentY = rect.top + relY * zoom;
        
        // Calculate how much it shifted away from the mouse pointer
        const deltaX = currentX - clientX;
        const deltaY = currentY - clientY;
        
        // Adjust scroll to compensate
        viewportRef.current.scrollLeft += deltaX;
        viewportRef.current.scrollTop += deltaY;
        
        mousePosRef.current = null;
    }
  }, [zoom]);

  // --- History Logic ---

  // Capture current state and push to history stack
  const recordHistory = useCallback((textObjectsOverride?: TextObject[]) => {
    if (!drawingCanvasRef.current) return;
    
    const ctx = drawingCanvasRef.current.getContext('2d');
    if (!ctx) return;

    const w = drawingCanvasRef.current.width;
    const h = drawingCanvasRef.current.height;
    
    if (w === 0 || h === 0) return;

    const currentImageData = ctx.getImageData(0, 0, w, h);
    const currentTextObjects = textObjectsOverride ? [...textObjectsOverride] : [...textObjects];

    setHistory(prev => {
      // If we are in the middle of history, discard future states
      const newHistory = prev.slice(0, historyIndex + 1);
      // Limit history size to 30 steps to prevent memory issues
      if (newHistory.length > 30) {
         newHistory.shift(); 
      }
      return [...newHistory, { imageData: currentImageData, textObjects: currentTextObjects }];
    });

    setHistoryIndex(prev => {
       const newLen = prev + 1 > 30 ? 30 : prev + 1; // Correct index logic if we shifted (approximate)
       return prev + 1; 
    });
  }, [textObjects, historyIndex]);

  const restoreState = useCallback((state: HistoryState) => {
    if (!drawingCanvasRef.current || !state.imageData) return;
    
    isHistoryProcessing.current = true;
    
    // Restore Canvas
    const ctx = drawingCanvasRef.current.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, drawingCanvasRef.current.width, drawingCanvasRef.current.height);
      ctx.putImageData(state.imageData, 0, 0);
    }

    // Restore Text
    setTextObjects(state.textObjects);
    
    // Reset Selection if the selected object no longer exists
    setSelectedTextId(prevId => {
        if (prevId && !state.textObjects.find(t => t.id === prevId)) {
            return null;
        }
        return prevId;
    });

    isHistoryProcessing.current = false;
  }, []);

  const handleUndo = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      restoreState(history[newIndex]);
    }
  }, [historyIndex, history, restoreState]);

  const handleRedo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      restoreState(history[newIndex]);
    }
  }, [historyIndex, history, restoreState]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Z
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Ctrl+Y or Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z' || e.key === 'Z'))) {
        e.preventDefault();
        handleRedo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo]);

  // Init
  useEffect(() => {
    const init = async () => {
      const img = await loadImage(imageBase64);
      if (baseCanvasRef.current && drawingCanvasRef.current) {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        setImgDims({ w, h });
        
        baseCanvasRef.current.width = w;
        baseCanvasRef.current.height = h;
        drawingCanvasRef.current.width = w;
        drawingCanvasRef.current.height = h;
        
        const ctx = baseCanvasRef.current.getContext('2d');
        ctx?.drawImage(img, 0, 0);
        
        // Record Initial State (Empty)
        const blankCtx = drawingCanvasRef.current.getContext('2d');
        if (blankCtx) {
           const initialData = blankCtx.getImageData(0, 0, w, h);
           // Initialize history with initialTextObjects passed from props
           setHistory([{ imageData: initialData, textObjects: initialTextObjects || [] }]);
           setHistoryIndex(0);
        }

        // Auto Fit on load
        const fitScale = calculateFitZoom(w, h);
        setZoom(fitScale);
      }
    };
    init();
  }, [imageBase64, calculateFitZoom, initialTextObjects]);

  // --- Brush Logic ---
  const getCoords = (e: React.MouseEvent | React.TouchEvent) => {
    if (!drawingCanvasRef.current) return { x: 0, y: 0 };
    const rect = drawingCanvasRef.current.getBoundingClientRect();
    
    // Calculate scale factor in case displayed size != actual size (handled by zoom automatically here)
    const scaleX = drawingCanvasRef.current.width / rect.width;
    const scaleY = drawingCanvasRef.current.height / rect.height;

    let clientX, clientY;
    if ('touches' in e) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = (e as React.MouseEvent).clientX;
      clientY = (e as React.MouseEvent).clientY;
    }

    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY
    };
  };

  const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
    if (activeTool !== 'brush') return;
    setIsDrawing(true);
    const ctx = drawingCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    
    const { x, y } = getCoords(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = brushColor;
    ctx.lineWidth = brushSize;
    ctx.lineTo(x, y); // Draw a dot immediately
    ctx.stroke();
  };

  const draw = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || activeTool !== 'brush') return;
    e.preventDefault();
    const ctx = drawingCanvasRef.current?.getContext('2d');
    if (!ctx) return;
    const { x, y } = getCoords(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };

  const stopDrawing = () => {
    if (isDrawing) {
        setIsDrawing(false);
        drawingCanvasRef.current?.getContext('2d')?.closePath();
        recordHistory(); // Record state after stroke
    }
  };

  // --- Fill Logic ---
  const handleFill = () => {
     if (!drawingCanvasRef.current) return;
     const ctx = drawingCanvasRef.current.getContext('2d');
     if (!ctx) return;

     const w = drawingCanvasRef.current.width;
     const h = drawingCanvasRef.current.height;

     // Fill the entire drawing canvas with the current brush color
     ctx.fillStyle = brushColor;
     ctx.fillRect(0, 0, w, h);
     
     recordHistory(); // Save to undo stack
  };

  // --- Text Logic ---
  const addText = () => {
     const newText: TextObject = {
       id: crypto.randomUUID(),
       x: imgDims.w / 2 - 100, // Center roughly
       y: imgDims.h / 2 - 50,
       // If vertical by default, use auto-width (undefined) to prevent large offset gap issues in vertical-rl
       // If horizontal, use fixed width to allow wrapping
       width: defaultVertical ? undefined : 200, 
       height: 100, // Default height
       text: 'New Text',
       fontSize: 24,
       color: '#000000',
       outlineColor: '#ffffff',
       outlineWidth: 4,
       backgroundColor: 'transparent',
       isVertical: defaultVertical, // Use default from config
       isBold: true,
       rotation: 0
     };
     const newList = [...textObjects, newText];
     setTextObjects(newList);
     setSelectedTextId(newText.id);
     setActiveTool('text');
     recordHistory(newList); // Record state
  };

  const updateSelectedText = (updates: Partial<TextObject>, saveToHistory: boolean = false) => {
    if (!selectedTextId) return;
    
    const newList = textObjects.map(t => t.id === selectedTextId ? { ...t, ...updates } : t);
    setTextObjects(newList);
    
    if (saveToHistory) {
        recordHistory(newList);
    }
  };

  const deleteSelectedText = () => {
    if (!selectedTextId) return;
    const newList = textObjects.filter(t => t.id !== selectedTextId);
    setTextObjects(newList);
    setSelectedTextId(null);
    recordHistory(newList); // Record state
  };

  const handleTextMouseDown = (e: React.MouseEvent, id: string) => {
    if (activeTool !== 'text') return;
    e.stopPropagation();
    setSelectedTextId(id);
    setIsDraggingText(true);
    didTextMove.current = false;
    
    const textObj = textObjects.find(t => t.id === id);
    if (!textObj || !containerRef.current) return;
    
    dragOffset.current = { x: e.clientX, y: e.clientY };
  };

  // Global Mouse Move for Text Dragging
  useEffect(() => {
    if (!isDraggingText) return;
    
    const handleMove = (e: MouseEvent) => {
       if (!selectedTextId || !drawingCanvasRef.current) return;
       
       const deltaX = e.clientX - dragOffset.current.x;
       const deltaY = e.clientY - dragOffset.current.y;

       if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
           didTextMove.current = true;
       }
       
       // Convert screen pixels to canvas pixels roughly
       const rect = drawingCanvasRef.current.getBoundingClientRect();
       const scaleX = drawingCanvasRef.current.width / rect.width;
       const scaleY = drawingCanvasRef.current.height / rect.height;
       
       setTextObjects(prev => prev.map(t => {
         if (t.id === selectedTextId) {
           return {
             ...t,
             x: t.x + (deltaX * scaleX),
             y: t.y + (deltaY * scaleY)
           };
         }
         return t;
       }));
       
       dragOffset.current = { x: e.clientX, y: e.clientY };
    };
    
    const handleUp = () => {
      setIsDraggingText(false);
      // Only record history if we actually moved the text
      if (didTextMove.current) {
          recordHistory();
          didTextMove.current = false;
      }
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [isDraggingText, selectedTextId, recordHistory]);

  // --- Compositing & Saving ---
  const handleSave = () => {
    if (!baseCanvasRef.current || !drawingCanvasRef.current) return;
    
    // 1. Create a composite canvas
    const canvas = document.createElement('canvas');
    canvas.width = baseCanvasRef.current.width;
    canvas.height = baseCanvasRef.current.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // 2. Draw Base
    ctx.drawImage(baseCanvasRef.current, 0, 0);
    
    // 3. Draw Brush Strokes
    ctx.drawImage(drawingCanvasRef.current, 0, 0);
    
    // 4. Draw Text (Rasterize)
    textObjects.forEach(obj => {
       ctx.save();
       // Position
       ctx.translate(obj.x, obj.y);
       ctx.rotate((obj.rotation * Math.PI) / 180);
       
       // Font Config
       const fontStyle = obj.isBold ? 'bold' : 'normal';
       ctx.font = `${fontStyle} ${obj.fontSize}px sans-serif`;
       ctx.textBaseline = 'top';
       
       // Handle Background
       if (obj.backgroundColor !== 'transparent') {
         const metrics = ctx.measureText(obj.text);
         const bgHeight = obj.isVertical ? metrics.width + obj.fontSize : obj.fontSize * 1.2;
         const bgWidth = obj.isVertical ? obj.fontSize * 1.2 : metrics.width;
         
         ctx.fillStyle = obj.backgroundColor;
         
         if (obj.width && obj.height) {
             ctx.fillRect(0, 0, obj.width, obj.height);
         } else {
             if (obj.isVertical) {
                ctx.fillRect(-obj.fontSize*0.1, -obj.fontSize*0.1, bgWidth, bgHeight + obj.text.length * obj.fontSize);
             } else {
                ctx.fillRect(-2, -2, bgWidth + 4, bgHeight + 4);
             }
         }
       }
       
       // Render Text
       ctx.fillStyle = obj.color;
       ctx.strokeStyle = obj.outlineColor;
       ctx.lineWidth = obj.outlineWidth;
       ctx.lineJoin = 'round';
       ctx.miterLimit = 2;
       
       if (obj.width && !obj.isVertical) {
           // Horizontal Wrapping Logic
           const words = obj.text.split(''); 
           let line = '';
           let testLine = '';
           let y = 0;
           
           for(let n = 0; n < words.length; n++) {
              testLine = line + words[n];
              const metrics = ctx.measureText(testLine);
              if (metrics.width > obj.width && n > 0) {
                  if (obj.outlineWidth > 0) ctx.strokeText(line, 0, y);
                  ctx.fillText(line, 0, y);
                  line = words[n];
                  y += obj.fontSize;
              } else {
                  line = testLine;
              }
           }
           if (obj.outlineWidth > 0) ctx.strokeText(line, 0, y);
           ctx.fillText(line, 0, y);

       } else if (obj.isVertical) {
          // Vertical Rendering Logic (Multi-column Right-to-Left)
          // Matches CSS `writing-mode: vertical-rl` behavior
          
          const lines = obj.text.split('\n');
          const lineHeight = obj.fontSize; // Matches DOM style lineHeight: 1
          const padding = 4; // Matches DOM p-1 (4px)

          lines.forEach((line, lineIndex) => {
              // Calculate Column X Position relative to obj.x
              let colX = 0;
              
              if (obj.width) {
                  // Fixed Width: Content aligns to the Right edge of the padding box
                  // Start = Width - Padding - (LineIndex + 1) * LineHeight
                  colX = obj.width - padding - ((lineIndex + 1) * lineHeight);
              } else {
                  // Auto Width: Box wraps content
                  // Start = Padding + (TotalLines - 1 - LineIndex) * LineHeight
                  colX = padding + (lines.length - 1 - lineIndex) * lineHeight;
              }

              let cursorY = padding; // Start with top padding
              
              for (let i = 0; i < line.length; i++) {
                 const char = line[i];
                 const charMetrics = ctx.measureText(char);
                 
                 // Center char horizontally within the column strip
                 const charX = colX + (lineHeight - charMetrics.width) / 2;
                 
                 if (obj.outlineWidth > 0) ctx.strokeText(char, charX, cursorY);
                 ctx.fillText(char, charX, cursorY);
                 
                 cursorY += lineHeight;
              }
          });
       } else {
          // Horizontal No-Wrap (Fallback)
          if (obj.outlineWidth > 0) ctx.strokeText(obj.text, 0, 0);
          ctx.fillText(obj.text, 0, 0);
       }
       
       ctx.restore();
    });
    
    const finalBase64 = canvas.toDataURL('image/png');
    onSave(finalBase64);
  };

  return (
    <div className="fixed inset-0 z-50 bg-skin-fill flex flex-col animate-in fade-in zoom-in-95 duration-200">
       {/* Header */}
       <div className="h-14 border-b border-skin-border flex items-center justify-between px-4 bg-skin-surface shadow-sm z-10">
          <div className="flex items-center gap-4">
            <h3 className="font-bold text-skin-text flex items-center gap-2">
                <svg className="w-5 h-5 text-skin-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                {t(language, 'editor_title')}
            </h3>
            
            {/* UNDO / REDO BUTTONS */}
            <div className="flex gap-1 ml-4 border-l border-skin-border pl-4">
                <button 
                    onClick={handleUndo}
                    disabled={historyIndex <= 0}
                    className="p-1.5 rounded hover:bg-skin-fill disabled:opacity-30 disabled:hover:bg-transparent text-skin-text transition-colors"
                    title={`${t(language, 'editor_btn_undo')} (Ctrl+Z)`}
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"></path></svg>
                </button>
                <button 
                    onClick={handleRedo}
                    disabled={historyIndex >= history.length - 1}
                    className="p-1.5 rounded hover:bg-skin-fill disabled:opacity-30 disabled:hover:bg-transparent text-skin-text transition-colors"
                    title={`${t(language, 'editor_btn_redo')} (Ctrl+Y)`}
                >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"></path></svg>
                </button>
            </div>
          </div>

          <div className="flex gap-2">
             <button onClick={onCancel} className="px-4 py-1.5 text-xs font-medium text-skin-muted hover:text-skin-text border border-transparent hover:border-skin-border rounded-md transition-all">
                {t(language, 'editor_btn_cancel')}
             </button>
             <button onClick={handleSave} className="px-4 py-1.5 text-xs font-bold bg-skin-primary text-skin-primary-fg rounded-md shadow hover:bg-opacity-90 transition-all">
                {t(language, 'editor_btn_save')}
             </button>
          </div>
       </div>

       <div className="flex-1 flex overflow-hidden">
          {/* Toolbar */}
          <div className="w-64 bg-skin-surface border-r border-skin-border flex flex-col p-4 gap-6 overflow-y-auto z-20 shadow-md">
             
             {/* Tools */}
             <div className="flex bg-skin-fill p-1 rounded-lg border border-skin-border">
                <button 
                   onClick={() => setActiveTool('brush')}
                   className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all ${activeTool === 'brush' ? 'bg-skin-surface text-skin-primary shadow-sm ring-1 ring-skin-border' : 'text-skin-muted hover:text-skin-text'}`}
                >
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path></svg>
                   {t(language, 'editor_tool_brush')}
                </button>
                <button 
                   onClick={() => setActiveTool('text')}
                   className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-md text-xs font-bold transition-all ${activeTool === 'text' ? 'bg-skin-surface text-skin-primary shadow-sm ring-1 ring-skin-border' : 'text-skin-muted hover:text-skin-text'}`}
                >
                   <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12"></path></svg>
                   {t(language, 'editor_tool_text')}
                </button>
             </div>

             {/* Brush Properties */}
             {activeTool === 'brush' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-left-4">
                   <div>
                      <label className="text-[10px] uppercase font-bold text-skin-muted mb-2 block">{t(language, 'editor_brush_size')}</label>
                      <div className="flex items-center gap-2 mb-2">
                          <input 
                             type="range" min="1" max="100" 
                             value={brushSize} 
                             onChange={(e) => setBrushSize(Number(e.target.value))} 
                             className="flex-1 accent-skin-primary" 
                          />
                          <input 
                             type="number" min="1" max="300"
                             value={brushSize}
                             onChange={(e) => setBrushSize(Math.max(1, Number(e.target.value)))}
                             className="w-14 p-1 text-xs text-center border border-skin-border rounded bg-skin-fill"
                          />
                      </div>
                      <div className="flex justify-between text-[10px] text-skin-muted"><span>1px</span><span>100px</span></div>
                   </div>
                   
                   <div>
                      <label className="text-[10px] uppercase font-bold text-skin-muted mb-2 block">{t(language, 'editor_brush_color')}</label>
                      <div className="flex gap-2 flex-wrap">
                         {['#ffffff', '#000000', '#f8fafc', '#1e293b'].map(c => (
                            <button 
                               key={c}
                               onClick={() => setBrushColor(c)}
                               className={`w-8 h-8 rounded-full border border-skin-border shadow-sm ${brushColor === c ? 'ring-2 ring-skin-primary ring-offset-2' : ''}`}
                               style={{ backgroundColor: c }}
                            />
                         ))}
                         <input type="color" value={brushColor} onChange={(e) => setBrushColor(e.target.value)} className="w-8 h-8 p-0 border-0 rounded-full overflow-hidden" />
                      </div>
                   </div>
                   
                   <div className="pt-2 border-t border-skin-border">
                       <button
                           onClick={handleFill}
                           className="w-full py-2 bg-skin-fill text-skin-text border border-skin-border rounded-lg text-xs font-bold hover:bg-skin-primary hover:text-white hover:border-skin-primary transition-all flex items-center justify-center gap-2"
                           title="Fills the entire canvas with the current brush color"
                       >
                           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
                           {t(language, 'editor_brush_fill')}
                       </button>
                   </div>
                </div>
             )}

             {/* Text Properties */}
             {activeTool === 'text' && (
                <div className="space-y-4 animate-in fade-in slide-in-from-left-4">
                   <button 
                      onClick={addText}
                      className="w-full py-2 bg-skin-primary-light text-skin-primary rounded-lg font-bold text-xs border border-skin-primary/20 hover:bg-skin-primary hover:text-skin-primary-fg transition-colors"
                   >
                      + Add New Text Box
                   </button>
                   
                   {selectedTextId ? (
                      <>
                        <div className="pt-4 border-t border-skin-border">
                           <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(language, 'editor_text_content')}</label>
                           <textarea 
                              className="w-full p-2 text-xs border border-skin-border rounded-md bg-skin-fill text-skin-text"
                              rows={3}
                              value={textObjects.find(t => t.id === selectedTextId)?.text || ''}
                              onChange={(e) => updateSelectedText({ text: e.target.value })}
                              onBlur={() => recordHistory()} // Save history on blur
                           />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                           <div>
                              <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(language, 'editor_text_size')}</label>
                              <input 
                                type="number" min="8" max="200" 
                                value={textObjects.find(t => t.id === selectedTextId)?.fontSize} 
                                onChange={(e) => updateSelectedText({ fontSize: Number(e.target.value) })}
                                onBlur={() => recordHistory()} // Save history on finish
                                className="w-full p-1 text-xs border border-skin-border rounded bg-skin-fill" 
                              />
                           </div>
                           <div>
                              <label className="text-[10px] uppercase font-bold text-skin-muted mb-1 block">{t(language, 'editor_text_outline_width')}</label>
                              <input 
                                type="number" min="0" max="20" 
                                value={textObjects.find(t => t.id === selectedTextId)?.outlineWidth} 
                                onChange={(e) => updateSelectedText({ outlineWidth: Number(e.target.value) })}
                                onBlur={() => recordHistory()} // Save history on finish
                                className="w-full p-1 text-xs border border-skin-border rounded bg-skin-fill" 
                              />
                           </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2">
                             <div>
                                <label className="text-[9px] text-skin-muted block">{t(language, 'editor_text_color')}</label>
                                <input 
                                    type="color" className="w-full h-6" 
                                    value={textObjects.find(t => t.id === selectedTextId)?.color} 
                                    onChange={(e) => updateSelectedText({ color: e.target.value })}
                                    onBlur={() => recordHistory()} // Save on close
                                />
                             </div>
                             <div>
                                <label className="text-[9px] text-skin-muted block">{t(language, 'editor_text_outline')}</label>
                                <input 
                                    type="color" className="w-full h-6" 
                                    value={textObjects.find(t => t.id === selectedTextId)?.outlineColor} 
                                    onChange={(e) => updateSelectedText({ outlineColor: e.target.value })}
                                    onBlur={() => recordHistory()} // Save on close
                                />
                             </div>
                             <div>
                                <label className="text-[9px] text-skin-muted block">{t(language, 'editor_text_bg')}</label>
                                <div className="flex items-center gap-1">
                                   <input 
                                     type="checkbox" 
                                     checked={textObjects.find(t => t.id === selectedTextId)?.backgroundColor !== 'transparent'} 
                                     onChange={(e) => updateSelectedText({ backgroundColor: e.target.checked ? '#ffffff' : 'transparent' }, true)} // Save immediately
                                   />
                                   {textObjects.find(t => t.id === selectedTextId)?.backgroundColor !== 'transparent' && (
                                       <input 
                                         type="color" className="w-6 h-6" 
                                         value={textObjects.find(t => t.id === selectedTextId)?.backgroundColor} 
                                         onChange={(e) => updateSelectedText({ backgroundColor: e.target.value })} 
                                         onBlur={() => recordHistory()} // Save on close
                                       />
                                   )}
                                </div>
                             </div>
                        </div>

                        <div className="flex gap-2">
                           <label className="flex items-center gap-2 text-xs cursor-pointer border border-skin-border px-2 py-1 rounded bg-skin-fill hover:bg-skin-surface">
                              <input 
                                type="checkbox" 
                                checked={textObjects.find(t => t.id === selectedTextId)?.isVertical} 
                                onChange={(e) => updateSelectedText({ isVertical: e.target.checked }, true)} // Save immediately
                              />
                              {t(language, 'editor_text_vertical')}
                           </label>
                           <label className="flex items-center gap-2 text-xs cursor-pointer border border-skin-border px-2 py-1 rounded bg-skin-fill hover:bg-skin-surface">
                              <input 
                                type="checkbox" 
                                checked={textObjects.find(t => t.id === selectedTextId)?.isBold} 
                                onChange={(e) => updateSelectedText({ isBold: e.target.checked }, true)} // Save immediately
                              />
                              {t(language, 'editor_text_bold')}
                           </label>
                        </div>

                        <button onClick={deleteSelectedText} className="w-full py-1 text-xs text-rose-500 hover:bg-rose-50 rounded border border-rose-200">
                           Delete Text
                        </button>
                      </>
                   ) : (
                      <p className="text-xs text-skin-muted italic text-center py-4">Select a text box to edit properties</p>
                   )}
                </div>
             )}

             {/* ZOOM CONTROLS - RELOCATED TO SIDEBAR BOTTOM */}
             <div className="mt-auto border-t border-skin-border pt-4">
                <label className="text-[10px] uppercase font-bold text-skin-muted mb-2 block">Zoom & View</label>
                
                <div className="flex items-center gap-2 mb-2">
                    <button 
                       onClick={handleZoomOut}
                       className="w-8 h-8 flex items-center justify-center rounded bg-skin-fill border border-skin-border hover:bg-skin-surface text-skin-text transition-colors"
                       title={t(language, 'editor_zoom_out')}
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4"/></svg>
                    </button>
                    
                    <span className="flex-1 text-center text-xs font-mono py-1 bg-skin-fill rounded border border-skin-border text-skin-muted select-none">
                        {Math.round(zoom * 100)}%
                    </span>
                    
                    <button 
                       onClick={handleZoomIn}
                       className="w-8 h-8 flex items-center justify-center rounded bg-skin-fill border border-skin-border hover:bg-skin-surface text-skin-text transition-colors"
                       title={t(language, 'editor_zoom_in')}
                    >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4"/></svg>
                    </button>
                </div>
                
                <div className="grid grid-cols-2 gap-2">
                    <button 
                       onClick={handleZoomFit}
                       className="py-1.5 text-xs text-skin-text bg-skin-fill border border-skin-border rounded hover:bg-skin-surface transition-colors"
                       title="Fit to Screen"
                    >
                        Fit
                    </button>
                    <button 
                       onClick={handleZoomReset}
                       className="py-1.5 text-xs text-skin-text bg-skin-fill border border-skin-border rounded hover:bg-skin-surface transition-colors"
                       title={t(language, 'editor_zoom_reset')}
                    >
                        1:1
                    </button>
                </div>
             </div>
          </div>

          {/* Canvas Area */}
          <div 
             ref={viewportRef}
             className="flex-1 bg-checkerboard overflow-auto relative"
          > 
             {/* Scrollable container with margin:auto centering for overflow support */}
             <div className="min-w-full min-h-full flex p-10">
                 {/* Layout placeholder that enforces scroll dimensions */}
                 <div 
                    className="m-auto relative shadow-2xl bg-white select-none"
                    style={{ 
                        width: imgDims.w * zoom, 
                        height: imgDims.h * zoom, 
                        transformOrigin: 'top left',
                        cursor: activeTool === 'brush' ? 'crosshair' : 'default' 
                    }}
                 >
                     <div 
                       ref={containerRef}
                       className="absolute top-0 left-0 w-full h-full"
                       style={{ 
                           transform: `scale(${zoom})`,
                           transformOrigin: 'top left',
                           width: imgDims.w,
                           height: imgDims.h,
                       }}
                     >
                        {/* Base Layer */}
                        <canvas ref={baseCanvasRef} className="block pointer-events-none w-full h-full" />
                        
                        {/* Brush Layer */}
                        <canvas 
                           ref={drawingCanvasRef} 
                           className="absolute inset-0 w-full h-full" 
                           onMouseDown={startDrawing}
                           onMouseMove={draw}
                           onMouseUp={stopDrawing}
                           onMouseLeave={stopDrawing}
                           onTouchStart={startDrawing}
                           onTouchMove={draw}
                           onTouchEnd={stopDrawing}
                        />

                        {/* Text DOM Overlay Layer (For Interaction) */}
                        <div className="absolute inset-0 overflow-hidden pointer-events-none w-full h-full">
                           {textObjects.map(obj => (
                              <div
                                 key={obj.id}
                                 onMouseDown={(e) => handleTextMouseDown(e, obj.id)}
                                 onMouseEnter={() => {
                                     // Only enable font resizing via wheel if we hover the currently selected text
                                     if (selectedTextId === obj.id) {
                                         isHoveringSelectedTextRef.current = true;
                                     }
                                 }}
                                 onMouseLeave={() => {
                                     isHoveringSelectedTextRef.current = false;
                                 }}
                                 className={`absolute cursor-move pointer-events-auto select-none p-1 ${selectedTextId === obj.id ? 'ring-1 ring-skin-primary ring-dashed' : ''} group hover:ring-1 hover:ring-skin-border`}
                                 style={{
                                    left: obj.x,
                                    top: obj.y,
                                    width: obj.width ? `${obj.width}px` : 'auto',
                                    height: obj.height ? `${obj.height}px` : 'auto',
                                    fontSize: `${obj.fontSize}px`,
                                    color: obj.color,
                                    fontWeight: obj.isBold ? 'bold' : 'normal',
                                    fontFamily: 'sans-serif',
                                    lineHeight: '1',
                                    transform: `rotate(${obj.rotation}deg)`,
                                    transformOrigin: 'top left',
                                    writingMode: obj.isVertical ? 'vertical-rl' : 'horizontal-tb',
                                    textOrientation: 'upright', // Ensures characters stand up in vertical mode
                                    whiteSpace: obj.isVertical ? 'pre' : 'pre-wrap', // Wrap in horizontal, standard flow in vertical
                                    wordBreak: 'break-word',
                                    backgroundColor: obj.backgroundColor,
                                    // Use text-shadow to simulate stroke in DOM preview
                                    textShadow: obj.outlineWidth > 0 
                                       ? `
                                        -${obj.outlineWidth}px -${obj.outlineWidth}px 0 ${obj.outlineColor},  
                                         ${obj.outlineWidth}px -${obj.outlineWidth}px 0 ${obj.outlineColor},
                                        -${obj.outlineWidth}px  ${obj.outlineWidth}px 0 ${obj.outlineColor},
                                         ${obj.outlineWidth}px  ${obj.outlineWidth}px 0 ${obj.outlineColor},
                                        -${obj.outlineWidth}px  0 0 ${obj.outlineColor},
                                         ${obj.outlineWidth}px  0 0 ${obj.outlineColor},
                                         0 -${obj.outlineWidth}px 0 ${obj.outlineColor},
                                         0  ${obj.outlineWidth}px 0 ${obj.outlineColor}
                                       ` 
                                       : 'none',
                                 }}
                              >
                                 {obj.text}
                              </div>
                           ))}
                        </div>
                     </div>
                 </div>
             </div>
          </div>
       </div>
    </div>
  );
};

export default PatchEditor;