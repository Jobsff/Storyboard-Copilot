import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pipette, Wand2, X } from 'lucide-react';
import { Group, Image as KonvaImage, Layer, Rect, Stage } from 'react-konva';
import type Konva from 'konva';

import type { ToolOptions } from '@/features/canvas/tools';
import {
  estimateKeyColor,
  matteSolidBackground,
  readMattingKeyColorsFromOptions,
  writeMattingKeyColorsToOptions,
  MAX_KEY_COLORS,
  sampleBorderKeyColors,
  type RgbTuple,
} from '@/features/canvas/application/matting';
import { loadImageElement } from '@/features/canvas/application/imageData';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 16;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;
/** 点击预览跑在 ≤1024px 缩放版上；应用时 processor 走全分辨率。 */
const PREVIEW_MAX_DIMENSION = 1024;
const CHECKER_CELL_PX = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatCssColor(color: RgbTuple): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function sameColor(a: RgbTuple, b: RgbTuple): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** 棋盘格底（模拟透明背景），用小 canvas 作 Konva fillPatternImage。 */
function createCheckerPatternCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CHECKER_CELL_PX * 2;
  canvas.height = CHECKER_CELL_PX * 2;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#c4c4c4';
  context.fillRect(0, 0, CHECKER_CELL_PX, CHECKER_CELL_PX);
  context.fillRect(CHECKER_CELL_PX, CHECKER_CELL_PX, CHECKER_CELL_PX, CHECKER_CELL_PX);
  return canvas;
}

/** 读原图像素（离屏 canvas），供点击取色 / 自动取色使用。 */
function readSourceImageData(image: HTMLImageElement): ImageData | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, image.naturalWidth);
    canvas.height = Math.max(1, image.naturalHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return null;
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  } catch (error) {
    console.warn('[MattingToolEditor] read source pixels failed', error);
    return null;
  }
}

export function MattingToolEditor({ options, onOptionsChange, sourceImageUrl }: VisualToolEditorProps) {
  const { t } = useTranslation();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [keyColors, setKeyColors] = useState<RgbTuple[]>(() =>
    readMattingKeyColorsFromOptions(options) ?? []
  );
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentGroupRef = useRef<Konva.Group | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sourceImageDataRef = useRef<ImageData | null>(null);

  const checkerPattern = useMemo(() => createCheckerPatternCanvas(), []);

  /** 点击即预览：对 ≤1024px 缩放版跑 matteSolidBackground，画到预览 KonvaImage。 */
  const computePreview = useCallback((source: HTMLImageElement, colors: RgbTuple[]) => {
    if (colors.length === 0) {
      setPreviewImage(null);
      return;
    }
    const longest = Math.max(source.naturalWidth, source.naturalHeight);
    const ratio = Math.min(1, PREVIEW_MAX_DIMENSION / Math.max(1, longest));
    const targetWidth = Math.max(1, Math.round(source.naturalWidth * ratio));
    const targetHeight = Math.max(1, Math.round(source.naturalHeight * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, targetWidth, targetHeight);

    try {
      const scaled = context.getImageData(0, 0, targetWidth, targetHeight);
      const result = matteSolidBackground(scaled.data, targetWidth, targetHeight, colors);
      context.putImageData(new ImageData(result.data, targetWidth, targetHeight), 0, 0);
    } catch (error) {
      console.warn('[MattingToolEditor] preview matte failed', error);
      return;
    }

    const preview = new window.Image();
    preview.onload = () => setPreviewImage(preview);
    preview.src = canvas.toDataURL('image/png');
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const img = await loadImageElement(sourceImageUrl);
        if (cancelled) {
          return;
        }
        setImage(img);
        sourceImageDataRef.current = readSourceImageData(img);
        setPreviewImage(null);
      } catch {
        if (!cancelled) {
          setImage(null);
          sourceImageDataRef.current = null;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceImageUrl]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    if (!image) {
      return { stageWidth: 820, stageHeight: 480, scale: 1 };
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    return {
      stageWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
      stageHeight: Math.max(1, Math.round(image.naturalHeight * ratio)),
      scale: ratio,
    };
  }, [image, viewportSize.height, viewportSize.width]);

  const applyKeyColors = useCallback(
    (colors: RgbTuple[]) => {
      setKeyColors(colors);
      onOptionsChange(writeMattingKeyColorsToOptions(options, colors) as ToolOptions);
      if (image) {
        computePreview(image, colors);
      }
    },
    [computePreview, image, onOptionsChange, options]
  );

  /** 先例 AnnotateToolEditor.getImagePoint：点击 → 原图坐标。 */
  const getImagePoint = useCallback(() => {
    const stage = stageRef.current;
    const group = contentGroupRef.current;
    if (!stage || !group || !image) {
      return null;
    }

    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return null;
    }

    const transform = group.getAbsoluteTransform().copy();
    transform.invert();
    const imagePoint = transform.point(pointer);
    return {
      x: clamp(imagePoint.x, 0, image.naturalWidth),
      y: clamp(imagePoint.y, 0, image.naturalHeight),
    };
  }, [image]);

  /** 点击累加键色（去重；满 4 个时淘汰最早的），任一变更自动重抠预览。 */
  const handleStageMouseDown = useCallback(() => {
    const sourceData = sourceImageDataRef.current;
    const point = getImagePoint();
    if (!sourceData || !point) {
      return;
    }

    const x = clamp(Math.floor(point.x), 0, sourceData.width - 1);
    const y = clamp(Math.floor(point.y), 0, sourceData.height - 1);
    const picked = estimateKeyColor(sourceData.data, sourceData.width, sourceData.height, x, y);
    const next = keyColors.filter((color) => !sameColor(color, picked));
    if (next.length === keyColors.length) {
      // 新颜色：累加（超出上限时淘汰最早）
      next.push(picked);
      if (next.length > MAX_KEY_COLORS) {
        next.splice(0, next.length - MAX_KEY_COLORS);
      }
    }
    applyKeyColors(next);
  }, [applyKeyColors, getImagePoint, keyColors]);

  const handleRemoveKeyColor = useCallback(
    (color: RgbTuple) => {
      applyKeyColors(keyColors.filter((item) => !sameColor(item, color)));
    },
    [applyKeyColors, keyColors]
  );

  /** 自动取色：边框主色聚类（1~4 键，纯色 1 键 / 墙+地面多键）。 */
  const handleAutoPick = useCallback(() => {
    const sourceData = sourceImageDataRef.current;
    if (!sourceData) {
      return;
    }
    const colors = sampleBorderKeyColors(sourceData.data, sourceData.width, sourceData.height);
    if (colors.length === 0) {
      return;
    }
    applyKeyColors(colors);
  }, [applyKeyColors]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs text-text-muted">
          <Pipette className="h-3.5 w-3.5" />
          {t('matting.hint')}
        </span>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:bg-bg-dark"
          onClick={handleAutoPick}
        >
          <Wand2 className="h-3.5 w-3.5" />
          {t('matting.autoPick')}
        </button>
        {keyColors.map((color) => (
          <button
            key={color.join(',')}
            type="button"
            className="group inline-flex items-center gap-1 rounded-lg border border-[rgba(255,255,255,0.14)] px-2 py-1 text-xs text-text-muted transition-colors hover:bg-bg-dark"
            title={t('matting.removeKey')}
            onClick={() => handleRemoveKeyColor(color)}
          >
            <span
              className="h-3.5 w-3.5 rounded border border-[rgba(255,255,255,0.28)]"
              style={{ backgroundColor: formatCssColor(color) }}
            />
            {color.join(', ')}
            <X className="h-3 w-3 opacity-50 transition-opacity group-hover:opacity-100" />
          </button>
        ))}
      </div>

      <div
        ref={viewportRef}
        className="relative h-[min(62vh,640px)] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-bg-dark/85"
      >
        <div className="relative flex h-full w-full items-center justify-center p-2 outline-none">
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            onMouseDown={handleStageMouseDown}
            onTouchStart={handleStageMouseDown}
            className="cursor-crosshair"
          >
            <Layer>
              <Group
                ref={contentGroupRef}
                x={0}
                y={0}
                scaleX={scale}
                scaleY={scale}
              >
                {image && (
                  <KonvaImage
                    image={image}
                    x={0}
                    y={0}
                    width={image.naturalWidth}
                    height={image.naturalHeight}
                  />
                )}
                {previewImage && image && (
                  <>
                    <Rect
                      x={0}
                      y={0}
                      width={image.naturalWidth}
                      height={image.naturalHeight}
                      // Konva 运行时支持 canvas 作 fillPatternImage，但类型只标了 HTMLImageElement
                      fillPatternImage={checkerPattern as unknown as HTMLImageElement}
                      listening={false}
                    />
                    <KonvaImage
                      image={previewImage}
                      x={0}
                      y={0}
                      width={image.naturalWidth}
                      height={image.naturalHeight}
                      listening={false}
                    />
                  </>
                )}
              </Group>
            </Layer>
          </Stage>
        </div>
      </div>
    </div>
  );
}
