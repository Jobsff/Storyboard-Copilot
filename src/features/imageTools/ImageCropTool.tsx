import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ImageIcon } from 'lucide-react';
import { UiButton, UiSelect } from '@/components/ui/primitives';
import { cropImageSource } from '@/commands/image';
import { type SourceImage, ACCEPTED_FORMATS, canvasToDataUrl, exportImage } from './shared';

const ASPECT_RATIOS = [
  { value: 'free', label: '自由' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
];

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLE_CURSORS: Record<Handle, string> = {
  n: 'cursor-n-resize', s: 'cursor-s-resize',
  e: 'cursor-e-resize', w: 'cursor-w-resize',
  ne: 'cursor-ne-resize', nw: 'cursor-nw-resize',
  se: 'cursor-se-resize', sw: 'cursor-sw-resize',
};

function parseRatio(v: string): number | null {
  if (v === 'free') return null;
  const [a, b] = v.split(':').map(Number);
  return a / b;
}

const MIN_SIZE = 5;

export function ImageCropTool() {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceImage | null>(null);
  const [aspectRatio, setAspectRatio] = useState('free');
  const [cropRect, setCropRect] = useState({ x: 10, y: 10, w: 80, h: 80 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [dragMode, setDragMode] = useState<false | 'move' | Handle>(false);
  const [dragStart, setDragStart] = useState({ mx: 0, my: 0, cx: 0, cy: 0, cw: 0, ch: 0 });
  const previewRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toPercent = useCallback((e: React.MouseEvent) => {
    if (!previewRef.current) return { px: 0, py: 0 };
    const rect = previewRef.current.getBoundingClientRect();
    return {
      px: ((e.clientX - rect.left) / rect.width) * 100,
      py: ((e.clientY - rect.top) / rect.height) * 100,
    };
  }, []);

  const clampRect = useCallback((r: { x: number; y: number; w: number; h: number }) => ({
    x: Math.max(0, Math.min(100 - r.w, r.x)),
    y: Math.max(0, Math.min(100 - r.h, r.y)),
    w: Math.max(MIN_SIZE, Math.min(100 - r.x, r.w)),
    h: Math.max(MIN_SIZE, Math.min(100 - r.y, r.h)),
  }), []);

  const handleMouseDown = useCallback((e: React.MouseEvent, mode: 'move' | Handle) => {
    e.stopPropagation();
    const { px, py } = toPercent(e);
    setDragMode(mode);
    setDragStart({ mx: px, my: py, cx: cropRect.x, cy: cropRect.y, cw: cropRect.w, ch: cropRect.h });
  }, [cropRect, toPercent]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragMode || !previewRef.current) return;
    const { px, py } = toPercent(e);
    const dx = px - dragStart.mx;
    const dy = py - dragStart.my;
    const ratio = parseRatio(aspectRatio);

    setCropRect(clampRect(((): { x: number; y: number; w: number; h: number } => {
      if (dragMode === 'move') {
        return { x: dragStart.cx + dx, y: dragStart.cy + dy, w: dragStart.cw, h: dragStart.ch };
      }

      let nx = dragStart.cx, ny = dragStart.cy, nw = dragStart.cw, nh = dragStart.ch;

      // Horizontal
      if (dragMode.includes('e')) nw = dragStart.cw + dx;
      if (dragMode.includes('w')) { nx = dragStart.cx + dx; nw = dragStart.cw - dx; }
      // Vertical
      if (dragMode.includes('s')) nh = dragStart.ch + dy;
      if (dragMode.includes('n')) { ny = dragStart.cy + dy; nh = dragStart.ch - dy; }

      // Enforce aspect ratio
      if (ratio) {
        const anchorX = dragMode.includes('w') ? dragStart.cx + dragStart.cw : dragStart.cx;
        const anchorY = dragMode.includes('n') ? dragStart.cy + dragStart.ch : dragStart.cy;
        if (dragMode === 'n' || dragMode === 's') {
          nw = nh * ratio;
          if (dragMode === 's') nx = anchorX; else nx = anchorX - nw;
        } else {
          nh = nw / ratio;
          if (dragMode.includes('e')) ny = anchorY; else ny = anchorY - nh;
        }
      }

      // Prevent flipping
      if (nw < MIN_SIZE) {
        if (dragMode.includes('w')) { nx = dragStart.cx + dragStart.cw - MIN_SIZE; }
        nw = Math.max(MIN_SIZE, nw);
      }
      if (nh < MIN_SIZE) {
        if (dragMode.includes('n')) { ny = dragStart.cy + dragStart.ch - MIN_SIZE; }
        nh = Math.max(MIN_SIZE, nh);
      }

      return { x: nx, y: ny, w: nw, h: nh };
    })()));
  }, [dragMode, dragStart, toPercent, clampRect, aspectRatio]);

  const handleMouseUp = useCallback(() => setDragMode(false), []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({ id: String(Date.now()), name: file.name, img });
      setCropRect({ x: 10, y: 10, w: 80, h: 80 });
      setExportSuccess(false);
    };
    img.src = url;
    e.target.value = '';
  }, []);

  const handleExport = useCallback(async () => {
    if (!source) return;
    setIsExporting(true);
    try {
      const img = source.img;
      const cx = Math.round((cropRect.x / 100) * img.naturalWidth);
      const cy = Math.round((cropRect.y / 100) * img.naturalHeight);
      const cw = Math.round((cropRect.w / 100) * img.naturalWidth);
      const ch = Math.round((cropRect.h / 100) * img.naturalHeight);

      let dataUrl: string;
      try {
        dataUrl = await cropImageSource({
          source: img.src,
          aspectRatio,
          cropX: cx,
          cropY: cy,
          cropWidth: cw,
          cropHeight: ch,
        });
      } catch {
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);
        dataUrl = canvasToDataUrl(canvas);
      }

      const baseName = source.name.replace(/\.[^.]+$/, '');
      const ok = await exportImage(dataUrl, `${baseName}_cropped.png`);
      if (ok) {
        setExportSuccess(true);
        setTimeout(() => setExportSuccess(false), 3000);
      }
    } catch (err) {
      console.error('Crop export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [source, cropRect, aspectRatio]);

  const handles: { id: Handle; style: React.CSSProperties }[] = [
    { id: 'n', style: { top: -4, left: '50%', transform: 'translateX(-50%)', width: 20, height: 8 } },
    { id: 's', style: { bottom: -4, left: '50%', transform: 'translateX(-50%)', width: 20, height: 8 } },
    { id: 'w', style: { left: -4, top: '50%', transform: 'translateY(-50%)', width: 8, height: 20 } },
    { id: 'e', style: { right: -4, top: '50%', transform: 'translateY(-50%)', width: 8, height: 20 } },
    { id: 'nw', style: { top: -4, left: -4, width: 10, height: 10 } },
    { id: 'ne', style: { top: -4, right: -4, width: 10, height: 10 } },
    { id: 'sw', style: { bottom: -4, left: -4, width: 10, height: 10 } },
    { id: 'se', style: { bottom: -4, right: -4, width: 10, height: 10 } },
  ];

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
      <div className="p-5 border-b border-border-dark">
        <h2 className="text-lg font-semibold text-text-dark">{t('imageTool.cropTitle')}</h2>
        <p className="text-sm text-text-muted mt-1">{t('imageTool.cropDesc')}</p>
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-1/2 p-5 border-b lg:border-b-0 lg:border-r border-border-dark">
          {source ? (
            <div className="space-y-3">
              <div
                ref={previewRef}
                className="relative rounded-lg overflow-hidden bg-bg-dark/60 select-none"
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <img src={source.img.src} alt="" className="w-full h-auto pointer-events-none" draggable={false} />
                <div className="absolute inset-0 bg-black/40" />
                <div
                  className="absolute border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.4)] cursor-move"
                  style={{
                    left: `${cropRect.x}%`,
                    top: `${cropRect.y}%`,
                    width: `${cropRect.w}%`,
                    height: `${cropRect.h}%`,
                  }}
                  onMouseDown={(e) => handleMouseDown(e, 'move')}
                >
                  {/* Grid lines for visual reference */}
                  <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute top-1/3 left-0 right-0 border-t border-white/30" />
                    <div className="absolute top-2/3 left-0 right-0 border-t border-white/30" />
                    <div className="absolute left-1/3 top-0 bottom-0 border-l border-white/30" />
                    <div className="absolute left-2/3 top-0 bottom-0 border-l border-white/30" />
                  </div>
                  {/* Resize handles */}
                  {handles.map(({ id, style }) => (
                    <div
                      key={id}
                      className={`absolute ${HANDLE_CURSORS[id]} z-10`}
                      style={{ ...style, background: 'rgba(255,255,255,0.85)', borderRadius: id.length === 2 ? 2 : 0 }}
                      onMouseDown={(e) => handleMouseDown(e, id)}
                    />
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{source.img.naturalWidth}×{source.img.naturalHeight}px</span>
                <UiButton variant="muted" onClick={() => fileInputRef.current?.click()} className="text-xs h-7">
                  {t('imageTool.changeImage')}
                </UiButton>
              </div>
            </div>
          ) : (
            <div
              className="flex flex-col items-center justify-center min-h-[300px] rounded-lg border-2 border-dashed border-border-dark bg-bg-dark/40 cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="w-12 h-12 text-text-muted opacity-50 mb-3" />
              <p className="text-sm text-text-muted">{t('imageTool.dropOrClick')}</p>
            </div>
          )}
          <input ref={fileInputRef} type="file" accept={ACCEPTED_FORMATS} onChange={handleFileChange} className="hidden" />
        </div>

        <div className="lg:w-1/2 p-5 flex flex-col">
          <span className="text-sm font-medium text-text-dark mb-3">{t('imageTool.cropSettings')}</span>

          <div className="space-y-3 flex-1">
            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('imageTool.aspectRatio')}</label>
              <UiSelect value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)} className="w-full h-9 text-sm">
                {ASPECT_RATIOS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </UiSelect>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-text-muted mb-1 block">X %</label>
                <input
                  type="range" min={0} max={90} value={Math.round(cropRect.x)}
                  onChange={(e) => setCropRect((p) => ({ ...p, x: Number(e.target.value) }))}
                  className="w-full accent-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">Y %</label>
                <input
                  type="range" min={0} max={90} value={Math.round(cropRect.y)}
                  onChange={(e) => setCropRect((p) => ({ ...p, y: Number(e.target.value) }))}
                  className="w-full accent-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('imageTool.cropWidth')} %</label>
                <input
                  type="range" min={5} max={100} value={Math.round(cropRect.w)}
                  onChange={(e) => setCropRect((p) => ({ ...p, w: Number(e.target.value) }))}
                  className="w-full accent-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('imageTool.cropHeight')} %</label>
                <input
                  type="range" min={5} max={100} value={Math.round(cropRect.h)}
                  onChange={(e) => setCropRect((p) => ({ ...p, h: Number(e.target.value) }))}
                  className="w-full accent-accent"
                />
              </div>
            </div>
            <div className="text-xs text-text-muted">
              {t('imageTool.cropOutput')}：{Math.round(cropRect.w / 100 * (source?.img.naturalWidth ?? 0))} × {Math.round(cropRect.h / 100 * (source?.img.naturalHeight ?? 0))} px
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-border-dark relative">
            {exportSuccess && (
              <div className="text-xs text-green-400 text-center mb-2">{t('imageTool.exportDone')}</div>
            )}
            <UiButton
              variant="primary"
              onClick={handleExport}
              disabled={!source || isExporting}
              className="w-full gap-1.5"
            >
              <Download className="w-4 h-4" />
              {isExporting ? t('imageTool.exporting') : t('imageTool.exportOne')}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  );
}
