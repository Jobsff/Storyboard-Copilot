import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Download, ImageIcon, Lock, Unlock, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { UiButton, UiInput, UiSelect } from '@/components/ui/primitives';
import { ImageUploadDropZone } from './ImageUploadDropZone';

interface SizeOption {
  id: string;
  mode: 'pixel' | 'scale';
  width: number;
  height: number;
  scale: number;
  enabled: boolean;
  fitMode: 'pad' | 'blur' | 'crop';
  bgColor: string;
}

interface SourceImage {
  id: string;
  name: string;
  img: HTMLImageElement;
}

const ACCEPTED_FORMATS = '.jpg,.jpeg,.png,.gif,.webp,.avif,.ico,.bmp,.svg';
const MAX_SIZE_OPTIONS = 10;

const PRESET_PIXELS = [
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '1080×1080', w: 1080, h: 1080 },
  { label: '1280×720', w: 1280, h: 720 },
  { label: '800×600', w: 800, h: 600 },
  { label: '512×512', w: 512, h: 512 },
  { label: '256×256', w: 256, h: 256 },
];

const PRESET_SCALES = [50, 75, 100, 150, 200, 300];

let nextId = 1;
function createSizeOption(): SizeOption {
  return { id: String(nextId++), mode: 'pixel', width: 800, height: 600, scale: 100, enabled: true, fitMode: 'pad', bgColor: '#000000' };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function renderToCanvas(
  img: HTMLImageElement,
  targetW: number,
  targetH: number,
  fitMode: 'pad' | 'blur' | 'crop',
  bgColor: string
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;

  if (fitMode === 'crop') {
    const scale = Math.max(targetW / srcW, targetH / srcH);
    ctx.drawImage(img, (targetW - srcW * scale) / 2, (targetH - srcH * scale) / 2, srcW * scale, srcH * scale);
  } else if (fitMode === 'blur') {
    const bgScale = Math.max(targetW / srcW, targetH / srcH) * 1.1;
    ctx.filter = 'blur(20px) brightness(0.7)';
    ctx.drawImage(img, (targetW - srcW * bgScale) / 2, (targetH - srcH * bgScale) / 2, srcW * bgScale, srcH * bgScale);
    ctx.filter = 'none';
    const fitScale = Math.min(targetW / srcW, targetH / srcH);
    ctx.drawImage(img, (targetW - srcW * fitScale) / 2, (targetH - srcH * fitScale) / 2, srcW * fitScale, srcH * fitScale);
  } else {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, targetW, targetH);
    const fitScale = Math.min(targetW / srcW, targetH / srcH);
    ctx.drawImage(img, (targetW - srcW * fitScale) / 2, (targetH - srcH * fitScale) / 2, srcW * fitScale, srcH * fitScale);
  }

  return canvas;
}

function resolveTargetSize(opt: SizeOption, img: HTMLImageElement): { w: number; h: number } {
  if (opt.mode === 'scale') {
    const factor = opt.scale / 100;
    return { w: Math.max(1, Math.round(img.naturalWidth * factor)), h: Math.max(1, Math.round(img.naturalHeight * factor)) };
  }
  return { w: opt.width, h: opt.height };
}

export function ImageResizeTool() {
  const { t } = useTranslation();
  const [sourceImages, setSourceImages] = useState<SourceImage[]>([]);
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([createSizeOption()]);
  const [isExporting, setIsExporting] = useState(false);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [lockAspect, setLockAspect] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith('image/') && !file.name.endsWith('.svg')) return;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        setSourceImages((prev) => [...prev, { id: String(nextId++), name: file.name, img }]);
      };
      img.src = url;
    });
  }, []);

  const removeImage = useCallback((id: string) => {
    setSourceImages((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(e.target.files);
    e.target.value = '';
  }, [addFiles]);

  const handleDropFiles = useCallback((files: File[]) => {
    addFiles(files);
  }, [addFiles]);

  const updateOption = useCallback((id: string, patch: Partial<SizeOption>) => {
    setSizeOptions((prev) =>
      prev.map((opt) => {
        if (opt.id !== id) return opt;
        const next = { ...opt, ...patch };
        if (next.mode === 'pixel' && lockAspect && sourceImages.length > 0 && ('width' in patch || 'height' in patch)) {
          const refImg = sourceImages[0].img;
          const ratio = refImg.naturalWidth / refImg.naturalHeight;
          if ('width' in patch) {
            next.height = Math.round(next.width / ratio);
          } else {
            next.width = Math.round(next.height * ratio);
          }
        }
        return next;
      })
    );
  }, [lockAspect, sourceImages]);

  const removeOption = useCallback((id: string) => {
    setSizeOptions((prev) => prev.filter((opt) => opt.id !== id));
  }, []);

  const addOption = useCallback((mode: 'pixel' | 'scale' = 'pixel') => {
    setSizeOptions((prev) => {
      if (prev.length >= MAX_SIZE_OPTIONS) return prev;
      const opt = createSizeOption();
      opt.mode = mode;
      return [...prev, opt];
    });
  }, []);

  const addPresetPixel = useCallback((w: number, h: number) => {
    setSizeOptions((prev) => {
      if (prev.length >= MAX_SIZE_OPTIONS) return prev;
      return [...prev, { id: String(nextId++), mode: 'pixel' as const, width: w, height: h, scale: 100, enabled: true, fitMode: 'pad' as const, bgColor: '#000000' }];
    });
  }, []);

  const addPresetScale = useCallback((s: number) => {
    setSizeOptions((prev) => {
      if (prev.length >= MAX_SIZE_OPTIONS) return prev;
      return [...prev, { id: String(nextId++), mode: 'scale' as const, width: 800, height: 600, scale: s, enabled: true, fitMode: 'pad' as const, bgColor: '#000000' }];
    });
  }, []);

  const handleExport = useCallback(async () => {
    if (sourceImages.length === 0) return;
    const enabledOptions = sizeOptions.filter((opt) => opt.enabled);
    if (enabledOptions.length === 0) return;

    const selectedDir = await open({ directory: true, multiple: false });
    if (!selectedDir || typeof selectedDir !== 'string') return;

    setIsExporting(true);
    setExportSuccess(null);
    let exportCount = 0;
    try {
      for (const src of sourceImages) {
        const baseName = src.name.replace(/\.[^.]+$/, '');
        for (const opt of enabledOptions) {
          const { w, h } = resolveTargetSize(opt, src.img);
          const canvas = renderToCanvas(src.img, w, h, opt.fitMode, opt.bgColor);
          const blob = await new Promise<Blob>((resolve) => {
            canvas.toBlob((b) => resolve(b!), 'image/png');
          });
          const dataUrl = await blobToDataUrl(blob);
          const sizeTag = opt.mode === 'scale' ? `${opt.scale}%` : `${w}x${h}`;
          const fileName = `${baseName}_${sizeTag}.png`;
          const targetPath = `${selectedDir}/${fileName}`;
          await invoke('save_image_source_to_path', { source: dataUrl, targetPath });
          exportCount++;
        }
      }
      setExportSuccess(t('imageTool.exportSuccess', { count: exportCount }));
      setTimeout(() => setExportSuccess(null), 4000);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setIsExporting(false);
    }
  }, [sourceImages, sizeOptions, t]);

  const hasImages = sourceImages.length > 0;
  const enabledCount = sizeOptions.filter((o) => o.enabled).length;
  const totalExports = sourceImages.length * enabledCount;

  return (
    <div className="bg-surface-dark border border-border-dark rounded-xl overflow-hidden">
      <div className="p-5 border-b border-border-dark">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-text-dark">{t('imageTool.resizeTitle')}</h2>
            <p className="text-sm text-text-muted mt-1">{t('imageTool.resizeDesc')}</p>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-muted cursor-pointer select-none">
            {lockAspect ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
            <span>{t('imageTool.lockAspect')}</span>
            <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} className="sr-only" />
          </label>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row">
        {/* Left: Image list */}
        <div className="lg:w-1/2 p-5 border-b lg:border-b-0 lg:border-r border-border-dark">
          <ImageUploadDropZone
            className="relative flex min-h-[300px] flex-col rounded-lg border-2 border-dashed border-border-dark bg-bg-dark/40 transition-colors"
            activeClassName="!border-accent !bg-accent/5"
            onFiles={handleDropFiles}
          >
            {hasImages ? (
              <div className="flex-1 p-3 space-y-2 overflow-auto ui-scrollbar">
                {sourceImages.map((src) => (
                  <div key={src.id} className="flex items-center gap-3 p-2 rounded-lg bg-bg-dark/60 border border-border-dark group">
                    <img src={src.img.src} alt={src.name} className="w-12 h-12 object-cover rounded flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-text-dark truncate">{src.name}</div>
                      <div className="text-xs text-text-muted">{src.img.naturalWidth}×{src.img.naturalHeight}px</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeImage(src.id)}
                      className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-bg-dark text-text-muted hover:text-red-500 transition-all flex-shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="flex-1 flex flex-col items-center justify-center gap-3 p-8 cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon className="w-12 h-12 text-text-muted opacity-50" />
                <p className="text-sm text-text-muted">{t('imageTool.dropOrClick')}</p>
                <p className="text-xs text-text-muted opacity-70">{t('imageTool.supportedFormats')}</p>
              </div>
            )}

            {hasImages && (
              <div className="p-2 border-t border-border-dark flex items-center justify-between">
                <span className="text-xs text-text-muted">{t('imageTool.imageCount', { count: sourceImages.length })}</span>
                <UiButton variant="muted" onClick={() => fileInputRef.current?.click()} className="text-xs h-7 gap-1">
                  <Plus className="w-3.5 h-3.5" />
                  {t('imageTool.addMore')}
                </UiButton>
              </div>
            )}
            <input ref={fileInputRef} type="file" accept={ACCEPTED_FORMATS} multiple onChange={handleFileChange} className="hidden" />
          </ImageUploadDropZone>
        </div>

        {/* Right: Size options */}
        <div className="lg:w-1/2 p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-text-dark">{t('imageTool.sizeOptions')}</span>
            <span className="text-xs text-text-muted">{sizeOptions.length}/{MAX_SIZE_OPTIONS}</span>
          </div>

          {/* Presets */}
          <div className="flex flex-wrap gap-1.5 mb-4">
            {PRESET_PIXELS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => addPresetPixel(p.w, p.h)}
                disabled={sizeOptions.length >= MAX_SIZE_OPTIONS}
                className="px-2 py-1 text-xs rounded border border-border-dark bg-bg-dark/60 text-text-muted hover:text-text-dark hover:border-accent/40 transition-colors disabled:opacity-40"
              >
                {p.label}
              </button>
            ))}
            <span className="w-px h-5 bg-border-dark self-center mx-0.5" />
            {PRESET_SCALES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => addPresetScale(s)}
                disabled={sizeOptions.length >= MAX_SIZE_OPTIONS}
                className="px-2 py-1 text-xs rounded border border-border-dark bg-bg-dark/60 text-text-muted hover:text-text-dark hover:border-accent/40 transition-colors disabled:opacity-40"
              >
                {s}%
              </button>
            ))}
          </div>

          {/* Size list */}
          <div className="flex-1 space-y-2 overflow-auto max-h-[400px] ui-scrollbar">
            {sizeOptions.map((opt) => (
              <div
                key={opt.id}
                className={`flex items-center gap-2 p-2.5 rounded-lg border transition-colors ${
                  opt.enabled ? 'border-border-dark bg-bg-dark/40' : 'border-border-dark/50 bg-bg-dark/20 opacity-50'
                }`}
              >
                <button
                  type="button"
                  onClick={() => updateOption(opt.id, { enabled: !opt.enabled })}
                  className={`w-4 h-4 rounded border transition-colors flex-shrink-0 ${
                    opt.enabled ? 'bg-accent/20 border-accent/60' : 'bg-transparent border-[rgba(255,255,255,0.2)]'
                  }`}
                />

                {/* Mode toggle */}
                <div className="flex rounded-md border border-border-dark overflow-hidden flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => updateOption(opt.id, { mode: 'pixel' })}
                    disabled={!opt.enabled}
                    className={`px-2 py-1 text-[10px] transition-colors ${
                      opt.mode === 'pixel' ? 'bg-accent/20 text-accent' : 'bg-bg-dark text-text-muted hover:text-text-dark'
                    }`}
                  >
                    px
                  </button>
                  <button
                    type="button"
                    onClick={() => updateOption(opt.id, { mode: 'scale' })}
                    disabled={!opt.enabled}
                    className={`px-2 py-1 text-[10px] transition-colors ${
                      opt.mode === 'scale' ? 'bg-accent/20 text-accent' : 'bg-bg-dark text-text-muted hover:text-text-dark'
                    }`}
                  >
                    %
                  </button>
                </div>

                {opt.mode === 'pixel' ? (
                  <>
                    <UiInput
                      type="number"
                      min={1}
                      placeholder="W"
                      value={opt.width}
                      onChange={(e) => updateOption(opt.id, { width: Number(e.target.value) || 1 })}
                      className="w-[72px] h-8 text-center text-sm"
                      disabled={!opt.enabled}
                    />
                    <span className="text-xs text-text-muted">×</span>
                    <UiInput
                      type="number"
                      min={1}
                      placeholder="H"
                      value={opt.height}
                      onChange={(e) => updateOption(opt.id, { height: Number(e.target.value) || 1 })}
                      className="w-[72px] h-8 text-center text-sm"
                      disabled={!opt.enabled}
                    />
                  </>
                ) : (
                  <div className="flex items-center gap-1">
                    <UiInput
                      type="number"
                      min={1}
                      max={1000}
                      value={opt.scale}
                      onChange={(e) => updateOption(opt.id, { scale: Number(e.target.value) || 100 })}
                      className="w-[72px] h-8 text-center text-sm"
                      disabled={!opt.enabled}
                    />
                    <span className="text-xs text-text-muted">%</span>
                  </div>
                )}

                <UiSelect
                  value={opt.fitMode}
                  onChange={(e) => updateOption(opt.id, { fitMode: e.target.value as SizeOption['fitMode'] })}
                  className="h-8 text-xs w-[80px]"
                  disabled={!opt.enabled}
                >
                  <option value="pad">{t('imageTool.fitPad')}</option>
                  <option value="blur">{t('imageTool.fitBlur')}</option>
                  <option value="crop">{t('imageTool.fitCrop')}</option>
                </UiSelect>

                {opt.fitMode === 'pad' && (
                  <input
                    type="color"
                    value={opt.bgColor}
                    onChange={(e) => updateOption(opt.id, { bgColor: e.target.value })}
                    className="w-6 h-6 rounded cursor-pointer border border-border-dark bg-transparent flex-shrink-0"
                    disabled={!opt.enabled}
                  />
                )}

                <button
                  type="button"
                  onClick={() => removeOption(opt.id)}
                  className="p-1 hover:bg-bg-dark rounded text-text-muted hover:text-red-500 transition-colors flex-shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* Add + Export */}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-border-dark relative">
            {exportSuccess && (
              <div className="absolute -top-8 left-0 right-0 text-center text-xs text-green-400 animate-pulse">
                {exportSuccess}
              </div>
            )}
            <div className="flex items-center gap-2">
              <UiButton
                variant="muted"
                onClick={() => addOption('pixel')}
                disabled={sizeOptions.length >= MAX_SIZE_OPTIONS}
                className="gap-1.5 text-xs h-8"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('imageTool.addPixel')}
              </UiButton>
              <UiButton
                variant="muted"
                onClick={() => addOption('scale')}
                disabled={sizeOptions.length >= MAX_SIZE_OPTIONS}
                className="gap-1.5 text-xs h-8"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('imageTool.addScale')}
              </UiButton>
            </div>

            <UiButton
              variant="primary"
              onClick={handleExport}
              disabled={!hasImages || enabledCount === 0 || isExporting}
              className="gap-1.5"
            >
              <Download className="w-4 h-4" />
              {isExporting ? t('imageTool.exporting') : t('imageTool.exportAll')}
              {!isExporting && totalExports > 0 && (
                <span className="text-xs opacity-70">({totalExports})</span>
              )}
            </UiButton>
          </div>
        </div>
      </div>
    </div>
  );
}
