import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ImageIcon, Square, Circle, ArrowRight, Pen, Type, Undo2 } from 'lucide-react';
import { UiButton } from '@/components/ui/primitives';
import { type SourceImage, ACCEPTED_FORMATS, canvasToDataUrl, exportImage } from './shared';
import type { AnnotationItem } from '@/features/canvas/tools/annotation/types';
import { drawAnnotations } from '@/features/canvas/tools/annotation/draw';

type ToolType = 'rect' | 'ellipse' | 'arrow' | 'pen' | 'text';

export function ImageAnnotateTool() {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceImage | null>(null);
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([]);
  const [activeTool, setActiveTool] = useState<ToolType>('rect');
  const [strokeColor, setStrokeColor] = useState('#ff4d4f');
  const [lineWidth, setLineWidth] = useState(3);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawCurrent, setDrawCurrent] = useState({ x: 0, y: 0 });
  const [penPoints, setPenPoints] = useState<number[]>([]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  // Text input state — replaces window.prompt() which doesn't work in Tauri
  const [textInput, setTextInput] = useState<{ x: number; y: number; canvasX: number; canvasY: number } | null>(null);
  const [textValue, setTextValue] = useState('');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textInputRef = useRef<HTMLInputElement>(null);

  // Focus text input when it appears
  useEffect(() => {
    if (textInput && textInputRef.current) {
      textInputRef.current.focus();
    }
  }, [textInput]);

  // Redraw canvas whenever source, annotations, or in-progress drawing changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source.img, 0, 0);
    drawAnnotations(ctx, annotations);

    // Draw in-progress preview (non-text tools)
    if (isDrawing && activeTool !== 'text') {
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash([6, 4]);

      if (activeTool === 'rect') {
        const x = Math.min(drawStart.x, drawCurrent.x);
        const y = Math.min(drawStart.y, drawCurrent.y);
        const w = Math.abs(drawCurrent.x - drawStart.x);
        const h = Math.abs(drawCurrent.y - drawStart.y);
        ctx.strokeRect(x, y, w, h);
      } else if (activeTool === 'ellipse') {
        const x = Math.min(drawStart.x, drawCurrent.x);
        const y = Math.min(drawStart.y, drawCurrent.y);
        const w = Math.abs(drawCurrent.x - drawStart.x);
        const h = Math.abs(drawCurrent.y - drawStart.y);
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2);
        ctx.stroke();
      } else if (activeTool === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(drawStart.x, drawStart.y);
        ctx.lineTo(drawCurrent.x, drawCurrent.y);
        ctx.stroke();
      } else if (activeTool === 'pen' && penPoints.length >= 2) {
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(penPoints[0], penPoints[1]);
        for (let i = 2; i < penPoints.length; i += 2) {
          ctx.lineTo(penPoints[i], penPoints[i + 1]);
        }
        ctx.stroke();
      }

      ctx.restore();
    }
  }, [source, annotations, isDrawing, drawStart, drawCurrent, penPoints, activeTool, strokeColor, lineWidth]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({ id: String(Date.now()), name: file.name, img });
      setAnnotations([]);
      setExportSuccess(false);
    };
    img.src = url;
    e.target.value = '';
  }, []);

  const getCanvasPos = useCallback((e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || !source) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = source.img.naturalWidth / rect.width;
    const scaleY = source.img.naturalHeight / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, [source]);

  const commitText = useCallback(() => {
    if (!textInput || !textValue.trim()) {
      setTextInput(null);
      setTextValue('');
      return;
    }
    setAnnotations((prev) => [...prev, {
      id: String(Date.now()),
      type: 'text',
      x: textInput.canvasX,
      y: textInput.canvasY,
      text: textValue.trim(),
      color: strokeColor,
      fontSize: Math.max(20, Math.round((source?.img.naturalWidth ?? 800) * 0.03)),
    }]);
    setTextInput(null);
    setTextValue('');
  }, [textInput, textValue, strokeColor, source]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // If text input is open, commit it first
    if (textInput) {
      commitText();
      return;
    }

    const pos = getCanvasPos(e);

    if (activeTool === 'text') {
      // Show inline text input at click position
      const canvas = canvasRef.current;
      if (!canvas || !source) return;
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      setTextInput({ x: cssX, y: cssY, canvasX: pos.x, canvasY: pos.y });
      setTextValue('');
      return;
    }

    setIsDrawing(true);
    setDrawStart(pos);
    setDrawCurrent(pos);
    if (activeTool === 'pen') {
      setPenPoints([pos.x, pos.y]);
    }
  }, [activeTool, getCanvasPos, textInput, commitText, source]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDrawing) return;
    const pos = getCanvasPos(e);
    setDrawCurrent(pos);
    if (activeTool === 'pen') {
      setPenPoints((prev) => [...prev, pos.x, pos.y]);
    }
  }, [isDrawing, activeTool, getCanvasPos]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const id = String(Date.now());

    if (activeTool === 'rect' || activeTool === 'ellipse') {
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      if (w > 2 && h > 2) {
        setAnnotations((prev) => [...prev, { id, type: activeTool, x, y, width: w, height: h, stroke: strokeColor, lineWidth }]);
      }
    } else if (activeTool === 'arrow') {
      if (Math.abs(drawCurrent.x - drawStart.x) > 2 || Math.abs(drawCurrent.y - drawStart.y) > 2) {
        setAnnotations((prev) => [...prev, { id, type: 'arrow', points: [drawStart.x, drawStart.y, drawCurrent.x, drawCurrent.y], stroke: strokeColor, lineWidth }]);
      }
    } else if (activeTool === 'pen') {
      if (penPoints.length >= 4) {
        setAnnotations((prev) => [...prev, { id, type: 'pen', points: [...penPoints], stroke: strokeColor, lineWidth }]);
      }
      setPenPoints([]);
    }
  }, [isDrawing, activeTool, drawStart, drawCurrent, strokeColor, lineWidth, penPoints]);

  const undo = useCallback(() => setAnnotations((prev) => prev.slice(0, -1)), []);

  const handleExport = useCallback(async () => {
    if (!source) return;
    setIsExporting(true);
    try {
      const img = source.img;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      drawAnnotations(ctx, annotations);
      const dataUrl = canvasToDataUrl(canvas);
      const baseName = source.name.replace(/\.[^.]+$/, '');
      const ok = await exportImage(dataUrl, `${baseName}_annotated.png`);
      if (ok) {
        setExportSuccess(true);
        setTimeout(() => setExportSuccess(false), 3000);
      }
    } catch (err) {
      console.error('Annotate export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [source, annotations]);

  const tools: { type: ToolType; icon: React.ReactNode }[] = [
    { type: 'rect', icon: <Square className="w-4 h-4" /> },
    { type: 'ellipse', icon: <Circle className="w-4 h-4" /> },
    { type: 'arrow', icon: <ArrowRight className="w-4 h-4" /> },
    { type: 'pen', icon: <Pen className="w-4 h-4" /> },
    { type: 'text', icon: <Type className="w-4 h-4" /> },
  ];

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
      <div className="p-5 border-b border-border-dark">
        <h2 className="text-lg font-semibold text-text-dark">{t('imageTool.annotateTitle')}</h2>
        <p className="text-sm text-text-muted mt-1">{t('imageTool.annotateDesc')}</p>
      </div>

      {source ? (
        <div className="p-5 space-y-3">
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            {tools.map(({ type, icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => setActiveTool(type)}
                className={`p-2 rounded-lg border transition-colors ${
                  activeTool === type ? 'border-accent/60 bg-accent/15 text-accent' : 'border-border-dark bg-bg-dark/60 text-text-muted hover:text-text-dark'
                }`}
                title={t(`imageTool.tool_${type}`)}
              >
                {icon}
              </button>
            ))}
            <div className="w-px h-6 bg-border-dark mx-1" />
            <input
              type="color"
              value={strokeColor}
              onChange={(e) => setStrokeColor(e.target.value)}
              className="w-7 h-7 rounded cursor-pointer border border-border-dark bg-transparent"
            />
            <input
              type="range" min={1} max={20} value={lineWidth}
              onChange={(e) => setLineWidth(Number(e.target.value))}
              className="w-20 accent-accent"
              title={`Line: ${lineWidth}`}
            />
            <div className="flex-1" />
            <UiButton variant="muted" onClick={undo} disabled={annotations.length === 0} className="gap-1 text-xs h-7">
              <Undo2 className="w-3.5 h-3.5" /> {t('imageTool.undo')}
            </UiButton>
            <span className="text-xs text-text-muted">{source.name} ({source.img.naturalWidth}×{source.img.naturalHeight})</span>
          </div>

          {/* Canvas */}
          <div ref={containerRef} className="relative rounded-lg overflow-hidden bg-bg-dark/60 border border-border-dark">
            <canvas
              ref={canvasRef}
              width={source.img.naturalWidth}
              height={source.img.naturalHeight}
              className="w-full h-auto cursor-crosshair block"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => { setIsDrawing(false); }}
            />
            {/* Inline text input overlay */}
            {textInput && (
              <input
                ref={textInputRef}
                type="text"
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitText();
                  if (e.key === 'Escape') { setTextInput(null); setTextValue(''); }
                }}
                onBlur={commitText}
                placeholder={t('imageTool.enterText')}
                className="absolute bg-transparent border-none outline-none"
                style={{
                  left: textInput.x,
                  top: textInput.y,
                  color: strokeColor,
                  fontSize: `${Math.max(14, Math.round(24 * (canvasRef.current ? (canvasRef.current.getBoundingClientRect().width / source.img.naturalWidth) : 1)))}px`,
                  fontWeight: 600,
                  fontFamily: 'sans-serif',
                  caretColor: strokeColor,
                  minWidth: 100,
                  transform: 'translateY(-50%)',
                }}
              />
            )}
          </div>

          {/* Export */}
          <div className="flex items-center justify-between">
            <UiButton variant="muted" onClick={() => fileInputRef.current?.click()} className="text-xs h-7">
              {t('imageTool.changeImage')}
            </UiButton>
            <div className="flex items-center gap-3">
              {exportSuccess && <span className="text-xs text-green-400">{t('imageTool.exportDone')}</span>}
              <UiButton variant="primary" onClick={handleExport} disabled={isExporting} className="gap-1.5">
                <Download className="w-4 h-4" />
                {isExporting ? t('imageTool.exporting') : t('imageTool.exportOne')}
              </UiButton>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5">
          <div
            className="flex flex-col items-center justify-center min-h-[300px] rounded-lg border-2 border-dashed border-border-dark bg-bg-dark/40 cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImageIcon className="w-12 h-12 text-text-muted opacity-50 mb-3" />
            <p className="text-sm text-text-muted">{t('imageTool.dropOrClick')}</p>
          </div>
        </div>
      )}
      <input ref={fileInputRef} type="file" accept={ACCEPTED_FORMATS} onChange={handleFileChange} className="hidden" />
    </div>
  );
}
