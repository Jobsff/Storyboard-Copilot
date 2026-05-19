import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ImageIcon } from 'lucide-react';
import { UiButton, UiInput } from '@/components/ui/primitives';
import { type SourceImage, ACCEPTED_FORMATS, canvasToDataUrl, exportImagesToDir } from './shared';

function splitImageLocal(
  img: HTMLImageElement,
  rows: number,
  cols: number,
  lineThickness: number
): { dataUrl: string; w: number; h: number }[] {
  const maxLine = cols > 1
    ? Math.floor((img.naturalWidth - cols) / (cols - 1))
    : Number.MAX_SAFE_INTEGER;
  const safeLine = Math.min(Math.max(0, lineThickness), maxLine);

  const usableW = img.naturalWidth - (cols - 1) * safeLine;
  const usableH = img.naturalHeight - (rows - 1) * safeLine;

  const colWidths = splitSegments(usableW, cols);
  const rowHeights = splitSegments(usableH, rows);

  const yOffsets: number[] = [];
  let yCursor = 0;
  for (let r = 0; r < rows; r++) {
    yOffsets.push(yCursor);
    yCursor += rowHeights[r];
    if (r < rows - 1) yCursor += safeLine;
  }

  const xOffsets: number[] = [];
  let xCursor = 0;
  for (let c = 0; c < cols; c++) {
    xOffsets.push(xCursor);
    xCursor += colWidths[c];
    if (c < cols - 1) xCursor += safeLine;
  }

  const results: { dataUrl: string; w: number; h: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tw = colWidths[c];
      const th = rowHeights[r];
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, xOffsets[c], yOffsets[r], tw, th, 0, 0, tw, th);
      results.push({ dataUrl: canvasToDataUrl(canvas), w: tw, h: th });
    }
  }
  return results;
}

function splitSegments(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const rem = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

export function ImageSplitTool() {
  const { t } = useTranslation();
  const [source, setSource] = useState<SourceImage | null>(null);
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [lineThickness, setLineThickness] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({ id: String(Date.now()), name: file.name, img });
      setExportSuccess(null);
    };
    img.src = url;
    e.target.value = '';
  }, []);

  const handleExport = useCallback(async () => {
    if (!source) return;
    setIsExporting(true);
    setExportSuccess(null);
    try {
      const pieces = splitImageLocal(source.img, rows, cols, lineThickness);
      const baseName = source.name.replace(/\.[^.]+$/, '');
      const images = pieces.map((p, i) => ({
        dataUrl: p.dataUrl,
        fileName: `${baseName}_${i + 1}.png`,
      }));
      const count = await exportImagesToDir(images);
      if (count > 0) {
        setExportSuccess(t('imageTool.exportSuccess', { count }));
        setTimeout(() => setExportSuccess(null), 4000);
      }
    } catch (err) {
      console.error('Split export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [source, rows, cols, lineThickness, t]);

  const totalPieces = rows * cols;
  const cellW = source ? Math.floor((source.img.naturalWidth - (cols - 1) * lineThickness) / cols) : 0;
  const cellH = source ? Math.floor((source.img.naturalHeight - (rows - 1) * lineThickness) / rows) : 0;

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
      <div className="p-5 border-b border-border-dark">
        <h2 className="text-lg font-semibold text-text-dark">{t('imageTool.splitTitle')}</h2>
        <p className="text-sm text-text-muted mt-1">{t('imageTool.splitDesc')}</p>
      </div>

      <div className="flex flex-col lg:flex-row">
        <div className="lg:w-1/2 p-5 border-b lg:border-b-0 lg:border-r border-border-dark">
          {source ? (
            <div className="space-y-3">
              <div className="relative rounded-lg overflow-hidden bg-bg-dark/60 border border-border-dark">
                <img src={source.img.src} alt="" className="w-full h-auto" />
                {/* Grid overlay */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none">
                  {Array.from({ length: cols - 1 }, (_, i) => {
                    const x = ((i + 1) / cols) * 100;
                    return <line key={`v${i}`} x1={`${x}%`} y1="0" x2={`${x}%`} y2="100%" stroke="rgba(255,255,0,0.7)" strokeWidth={Math.max(1, lineThickness / (source.img.naturalWidth / 400))} />;
                  })}
                  {Array.from({ length: rows - 1 }, (_, i) => {
                    const y = ((i + 1) / rows) * 100;
                    return <line key={`h${i}`} x1="0" y1={`${y}%`} x2="100%" y2={`${y}%`} stroke="rgba(255,255,0,0.7)" strokeWidth={Math.max(1, lineThickness / (source.img.naturalHeight / 400))} />;
                  })}
                </svg>
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
          <span className="text-sm font-medium text-text-dark mb-3">{t('imageTool.splitSettings')}</span>

          <div className="space-y-4 flex-1">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('imageTool.splitRows')}</label>
                <UiInput
                  type="number" min={1} max={8} value={rows}
                  onChange={(e) => setRows(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  className="w-full h-9 text-center text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-text-muted mb-1 block">{t('imageTool.splitCols')}</label>
                <UiInput
                  type="number" min={1} max={8} value={cols}
                  onChange={(e) => setCols(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
                  className="w-full h-9 text-center text-sm"
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-text-muted mb-1 block">{t('imageTool.lineThickness')}: {lineThickness}px</label>
              <input
                type="range" min={0} max={50} value={lineThickness}
                onChange={(e) => setLineThickness(Number(e.target.value))}
                className="w-full accent-accent"
              />
            </div>

            {source && (
              <div className="rounded-lg border border-border-dark bg-bg-dark/40 p-3 space-y-1 text-xs text-text-muted">
                <p>{t('imageTool.splitResult')}: {rows}×{cols} = {totalPieces} {t('imageTool.pieces')}</p>
                <p>{t('imageTool.cellSize')}: {cellW}×{cellH}px</p>
              </div>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-border-dark relative">
            {exportSuccess && (
              <div className="text-xs text-green-400 text-center mb-2">{exportSuccess}</div>
            )}
            <UiButton
              variant="primary"
              onClick={handleExport}
              disabled={!source || isExporting}
              className="w-full gap-1.5"
            >
              <Download className="w-4 h-4" />
              {isExporting ? t('imageTool.exporting') : t('imageTool.exportSplit')}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  );
}
