import {
  NODE_TOOL_TYPES,
  type NodeToolType,
  type StoryboardFrameItem,
} from '../domain/canvasNodes';
import {
  canvasToDataUrl,
  detectAspectRatio,
  loadImageElement,
  parseAspectRatio,
  persistImageLocally,
} from './imageData';
import { cropImageSource, readStoryboardImageMetadata } from '@/commands/image';
import { drawAnnotations, parseAnnotationItems } from '../tools/annotation';
import type {
  IdGenerator,
  ImageSplitGateway,
  ToolProcessor,
  ToolProcessorResult,
} from './ports';

export class CanvasToolProcessor implements ToolProcessor {
  constructor(
    private readonly splitGateway: ImageSplitGateway,
    private readonly idGenerator: IdGenerator
  ) {}

  async process(
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ): Promise<ToolProcessorResult> {
    if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
      const metadata = await this.readStoryboardMetadata(sourceImageUrl);
      const transparentBackgroundMode = String(
        options.transparentBackgroundMode ??
        (options.removeLightBackground ? 'remove' : 'auto')
      );
      return await this.splitStoryboard(
        sourceImageUrl,
        Number(options.rows ?? metadata?.gridRows ?? 3),
        Number(options.cols ?? metadata?.gridCols ?? 3),
        Number(options.lineThicknessPercent),
        Number(options.lineThickness ?? 0),
        metadata?.frameNotes,
        Boolean(options.normalizeSequenceFrames),
        transparentBackgroundMode,
        String(options.selectedFrameIndices ?? '')
      );
    }

    switch (toolType) {
      case NODE_TOOL_TYPES.crop:
        return {
          outputImageUrl: await this.cropImage(sourceImageUrl, options),
        };
      case NODE_TOOL_TYPES.annotate:
        // Keep annotate on frontend for now because it supports free-form vector annotations.
        // Prefer local source first to avoid CORS taint and repeated remote fetches.
        return {
          outputImageUrl: await this.annotateImage(
            await persistImageLocally(sourceImageUrl),
            options
          ),
        };
      case NODE_TOOL_TYPES.scale:
        return {
          outputImageUrl: await this.scaleImage(
            await persistImageLocally(sourceImageUrl),
            options
          ),
        };
      default:
        throw new Error('不支持的工具类型');
    }
  }

  private async cropImage(sourceImage: string, options: Record<string, unknown>): Promise<string> {
    try {
      return await cropImageSource({
        source: sourceImage,
        aspectRatio: String(options.aspectRatio ?? '1:1'),
        cropX: Number(options.cropX),
        cropY: Number(options.cropY),
        cropWidth: Number(options.cropWidth),
        cropHeight: Number(options.cropHeight),
      });
    } catch {
      // Fallback to local canvas implementation when backend command is unavailable.
    }

    const aspectRatio = String(options.aspectRatio ?? '1:1');
    const targetRatio = parseAspectRatio(aspectRatio);
    const image = await loadImageElement(sourceImage);

    const cropX = Number(options.cropX);
    const cropY = Number(options.cropY);
    const cropWidthOption = Number(options.cropWidth);
    const cropHeightOption = Number(options.cropHeight);

    const hasManualCropArea =
      Number.isFinite(cropX) &&
      Number.isFinite(cropY) &&
      Number.isFinite(cropWidthOption) &&
      Number.isFinite(cropHeightOption) &&
      cropWidthOption > 0 &&
      cropHeightOption > 0;

    let cropWidth = image.naturalWidth;
    let cropHeight = image.naturalHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (hasManualCropArea) {
      offsetX = Math.min(image.naturalWidth - 1, Math.max(0, Math.floor(cropX)));
      offsetY = Math.min(image.naturalHeight - 1, Math.max(0, Math.floor(cropY)));
      cropWidth = Math.max(1, Math.min(Math.floor(cropWidthOption), image.naturalWidth - offsetX));
      cropHeight = Math.max(1, Math.min(Math.floor(cropHeightOption), image.naturalHeight - offsetY));
    } else if (aspectRatio === 'free') {
      offsetX = 0;
      offsetY = 0;
      cropWidth = image.naturalWidth;
      cropHeight = image.naturalHeight;
    } else {
      const sourceRatio = image.naturalWidth / image.naturalHeight;
      if (sourceRatio > targetRatio) {
        cropWidth = image.naturalHeight * targetRatio;
      } else {
        cropHeight = image.naturalWidth / targetRatio;
      }

      offsetX = (image.naturalWidth - cropWidth) / 2;
      offsetY = (image.naturalHeight - cropHeight) / 2;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(cropWidth));
    canvas.height = Math.max(1, Math.floor(cropHeight));

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(
      image,
      offsetX,
      offsetY,
      cropWidth,
      cropHeight,
      0,
      0,
      canvas.width,
      canvas.height
    );

    return canvasToDataUrl(canvas);
  }

  private async scaleImage(sourceImage: string, options: Record<string, unknown>): Promise<string> {
    const scalePercent = Number(options.scalePercent ?? 100);
    const rawScale = scalePercent / 100;
    const scale = Number.isFinite(rawScale) ? Math.min(4, Math.max(0.1, rawScale)) : 1;

    const image = await loadImageElement(sourceImage);
    const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
    const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    return canvasToDataUrl(canvas);
  }

  private async annotateImage(
    sourceImage: string,
    options: Record<string, unknown>
  ): Promise<string> {
    const image = await loadImageElement(sourceImage);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('无法初始化画布');
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const annotations = parseAnnotationItems(options.annotations);

    if (annotations.length > 0) {
      drawAnnotations(context, annotations);
    } else {
      const text = String(options.text ?? '').trim();
      const position = String(options.position ?? 'bottom');
      const color = String(options.color ?? '#FFFFFF');

      if (!text) {
        return canvasToDataUrl(canvas);
      }

      const fontSize = Math.max(24, Math.round(canvas.width * 0.04));
      context.font = `600 ${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';

      const textWidth = context.measureText(text).width;
      const paddingX = Math.round(fontSize * 0.8);
      const paddingY = Math.round(fontSize * 0.6);
      const boxWidth = textWidth + paddingX * 2;
      const boxHeight = fontSize + paddingY * 2;

      const x = canvas.width / 2;
      const y = this.resolveAnnotateY(position, canvas.height, boxHeight);

      context.fillStyle = 'rgba(0, 0, 0, 0.45)';
      context.fillRect(x - boxWidth / 2, y - boxHeight / 2, boxWidth, boxHeight);
      context.fillStyle = color;
      context.fillText(text, x, y);
    }

    return canvasToDataUrl(canvas);
  }

  private resolveAnnotateY(position: string, canvasHeight: number, boxHeight: number): number {
    if (position === 'top') {
      return boxHeight / 2 + 24;
    }

    if (position === 'center') {
      return canvasHeight / 2;
    }

    return canvasHeight - boxHeight / 2 - 24;
  }

  private async splitStoryboard(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThicknessPercent: number,
    lineThicknessPxFallback: number,
    frameNotes?: string[],
    normalizeSequenceFrames = false,
    transparentBackgroundMode = 'auto',
    selectedFrameIndices = ''
  ): Promise<ToolProcessorResult> {
    const normalizedRows = Number.isFinite(rows) ? rows : 3;
    const normalizedCols = Number.isFinite(cols) ? cols : 3;
    const normalizedLineThicknessPercent = Number.isFinite(lineThicknessPercent)
      ? lineThicknessPercent
      : NaN;
    const normalizedLineThicknessPxFallback = Number.isFinite(lineThicknessPxFallback)
      ? lineThicknessPxFallback
      : 0;

    const safeRows = Math.max(1, Math.floor(normalizedRows));
    const safeCols = Math.max(1, Math.floor(normalizedCols));
    const safeLineThickness = await this.resolveSplitLineThicknessPx(
      sourceImage,
      safeRows,
      safeCols,
      normalizedLineThicknessPercent,
      normalizedLineThicknessPxFallback
    );

    if (safeRows <= 0 || safeCols <= 0) {
      throw new Error('分镜行列必须大于 0');
    }

    let outputs: string[];
    try {
      outputs = await this.splitGateway.split(
        sourceImage,
        safeRows,
        safeCols,
        safeLineThickness
      );
    } catch {
      // Fallback when Tauri command is unavailable or fails.
      outputs = await this.localSplit(sourceImage, safeRows, safeCols, safeLineThickness);
    }

    const selectedIndexes = this.resolveSelectedFrameIndexes(
      selectedFrameIndices,
      outputs.length
    );
    const selectedOutputs = selectedIndexes.map((index) => outputs[index]).filter(Boolean);
    const selectedFrameNotes = selectedIndexes.map((index) =>
      typeof frameNotes?.[index] === 'string' ? frameNotes[index].trim() : ''
    );
    const shouldProcessFrames =
      normalizeSequenceFrames || transparentBackgroundMode === 'auto' || transparentBackgroundMode === 'remove';
    const processedOutputs = shouldProcessFrames
      ? await this.normalizeSequenceFrameImages(outputs, {
        normalizePosition: normalizeSequenceFrames,
        transparentBackgroundMode,
        selectedIndexes,
      })
      : selectedOutputs;

    const persistedFrameImages = await Promise.all(
      processedOutputs.map(async (imageUrl) => await persistImageLocally(imageUrl))
    );

    let frameAspectRatio: string | undefined;
    const firstFrameImage = persistedFrameImages[0];
    if (firstFrameImage) {
      try {
        frameAspectRatio = await detectAspectRatio(firstFrameImage);
      } catch {
        frameAspectRatio = undefined;
      }
    }

    const resolvedFrameAspectRatio = frameAspectRatio ?? `${safeCols}:${safeRows}`;
    const frames: StoryboardFrameItem[] = persistedFrameImages.map((imageUrl, index) => ({
      id: this.idGenerator.next(),
      imageUrl,
      previewImageUrl: imageUrl,
      aspectRatio: resolvedFrameAspectRatio,
      note: selectedFrameNotes[index] ?? '',
      order: index,
    }));
    const displayCols = Math.max(1, Math.min(safeCols, frames.length || 1));
    const displayRows = Math.max(1, Math.ceil((frames.length || 1) / displayCols));

    return {
      storyboardFrames: frames,
      rows: displayRows,
      cols: displayCols,
      frameAspectRatio: resolvedFrameAspectRatio,
    };
  }

  private async normalizeSequenceFrameImages(
    imageUrls: string[],
    options: {
      normalizePosition: boolean;
      transparentBackgroundMode: string;
      selectedIndexes: number[];
    }
  ): Promise<string[]> {
    const selectedImageUrls = options.selectedIndexes
      .map((index) => imageUrls[index])
      .filter(Boolean);
    const preparedFrames = await Promise.all(
      selectedImageUrls.map(async (imageUrl) => {
        const image = await loadImageElement(imageUrl);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.naturalWidth || image.width);
        canvas.height = Math.max(1, image.naturalHeight || image.height);
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('无法初始化序列帧画布');
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const shouldRemoveBackground = this.shouldRemoveBackground(
          imageData,
          options.transparentBackgroundMode
        );
        if (shouldRemoveBackground) {
          this.removeGeneratedBackgroundPixels(imageData);
          this.clearSequenceFrameEdgePixels(imageData);
          context.putImageData(imageData, 0, 0);
        }
        return {
          canvas,
          bounds: this.findOpaqueBounds(imageData),
        };
      })
    );

    if (!options.normalizePosition) {
      return preparedFrames.map((frame) => canvasToDataUrl(frame.canvas));
    }

    return preparedFrames.map((frame) => {
      const bounds = frame.bounds;
      if (!bounds) {
        return canvasToDataUrl(frame.canvas);
      }

      const output = document.createElement('canvas');
      output.width = frame.canvas.width;
      output.height = frame.canvas.height;
      const context = output.getContext('2d');
      if (!context) {
        throw new Error('无法初始化序列帧校准画布');
      }

      const sourceWidth = bounds.maxX - bounds.minX + 1;
      const sourceHeight = bounds.maxY - bounds.minY + 1;
      const targetX = Math.round((output.width - sourceWidth) / 2);
      const targetBaseline = Math.round(output.height * 0.88);
      const targetY = Math.max(0, Math.min(output.height - sourceHeight, targetBaseline - sourceHeight));

      context.drawImage(
        frame.canvas,
        bounds.minX,
        bounds.minY,
        sourceWidth,
        sourceHeight,
        targetX,
        targetY,
        sourceWidth,
        sourceHeight
      );

      return canvasToDataUrl(output);
    });
  }

  private resolveSelectedFrameIndexes(selectedFrameIndices: string, frameCount: number): number[] {
    const allIndexes = Array.from({ length: frameCount }, (_value, index) => index);
    const trimmed = selectedFrameIndices.trim();
    if (!trimmed) {
      return allIndexes;
    }

    const selected = trimmed
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < frameCount);
    const unique = Array.from(new Set(selected));
    return unique.length > 0 ? unique : allIndexes;
  }

  private shouldRemoveBackground(imageData: ImageData, transparentBackgroundMode: string): boolean {
    if (transparentBackgroundMode === 'none') {
      return false;
    }
    if (transparentBackgroundMode === 'remove') {
      return true;
    }
    if (!this.hasRealAlpha(imageData)) {
      return true;
    }
    return Boolean(this.resolveChromaBackgroundColor(imageData));
  }

  private hasRealAlpha(imageData: ImageData): boolean {
    const { data } = imageData;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] < 248) {
        return true;
      }
    }
    return false;
  }

  private removeGeneratedBackgroundPixels(imageData: ImageData): void {
    const backgroundColor = this.resolveChromaBackgroundColor(imageData);
    if (backgroundColor) {
      this.removeChromaKeyBackgroundPixels(imageData, backgroundColor);
      return;
    }
    this.removeLightBackgroundPixels(imageData);
  }

  private resolveChromaBackgroundColor(
    imageData: ImageData
  ): { red: number; green: number; blue: number } | null {
    const borderColor = this.estimateDominantBorderBackgroundColor(imageData);
    if (borderColor && this.isChromaKeyColor(borderColor)) {
      return borderColor;
    }

    const dominantChromaColor = this.estimateDominantChromaBackgroundColor(imageData);
    if (dominantChromaColor && this.isChromaKeyColor(dominantChromaColor)) {
      return dominantChromaColor;
    }

    return null;
  }

  private estimateDominantBorderBackgroundColor(
    imageData: ImageData
  ): { red: number; green: number; blue: number } | null {
    const { width, height, data } = imageData;
    const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
    const sample = (x: number, y: number): void => {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) {
        return;
      }
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
      bucket.count += 1;
      bucket.red += red;
      bucket.green += green;
      bucket.blue += blue;
      buckets.set(key, bucket);
    };

    for (let x = 0; x < width; x += 1) {
      sample(x, 0);
      sample(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      sample(0, y);
      sample(width - 1, y);
    }

    let best: { count: number; red: number; green: number; blue: number } | null = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.count > best.count) {
        best = bucket;
      }
    }
    if (!best || best.count < Math.max(8, Math.floor((width + height) / 32))) {
      return null;
    }

    return {
      red: Math.round(best.red / best.count),
      green: Math.round(best.green / best.count),
      blue: Math.round(best.blue / best.count),
    };
  }

  private estimateDominantChromaBackgroundColor(
    imageData: ImageData
  ): { red: number; green: number; blue: number } | null {
    const { width, height, data } = imageData;
    const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
    const stride = Math.max(1, Math.floor(Math.min(width, height) / 180));

    for (let y = 0; y < height; y += stride) {
      for (let x = 0; x < width; x += stride) {
        const index = (y * width + x) * 4;
        if (data[index + 3] === 0) {
          continue;
        }
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const maxChannel = Math.max(red, green, blue);
        const minChannel = Math.min(red, green, blue);
        const brightness = red * 0.299 + green * 0.587 + blue * 0.114;
        const saturation = maxChannel - minChannel;
        if (maxChannel < 150 || saturation < 96 || brightness < 58) {
          continue;
        }

        const isLikelyMagenta = red > 145 && blue > 145 && green < 130 && red + blue > green * 3.2;
        const isLikelyGreen = green > 145 && red < 150 && blue < 150 && green > Math.max(red, blue) * 1.35;
        const isLikelyBlue = blue > 145 && red < 150 && green < 170 && blue > Math.max(red, green) * 1.25;
        if (!isLikelyMagenta && !isLikelyGreen && !isLikelyBlue) {
          continue;
        }

        const key = `${red >> 4},${green >> 4},${blue >> 4}`;
        const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
        bucket.count += 1;
        bucket.red += red;
        bucket.green += green;
        bucket.blue += blue;
        buckets.set(key, bucket);
      }
    }

    let best: { count: number; red: number; green: number; blue: number } | null = null;
    for (const bucket of buckets.values()) {
      if (!best || bucket.count > best.count) {
        best = bucket;
      }
    }
    const sampledPixels = Math.ceil(width / stride) * Math.ceil(height / stride);
    if (!best || best.count < Math.max(12, Math.floor(sampledPixels * 0.035))) {
      return null;
    }

    return {
      red: Math.round(best.red / best.count),
      green: Math.round(best.green / best.count),
      blue: Math.round(best.blue / best.count),
    };
  }

  private isChromaKeyColor(color: { red: number; green: number; blue: number }): boolean {
    const maxChannel = Math.max(color.red, color.green, color.blue);
    const minChannel = Math.min(color.red, color.green, color.blue);
    const saturation = maxChannel - minChannel;
    const brightness = color.red * 0.299 + color.green * 0.587 + color.blue * 0.114;
    return maxChannel >= 160 && saturation >= 90 && brightness >= 70;
  }

  private removeChromaKeyBackgroundPixels(
    imageData: ImageData,
    backgroundColor: { red: number; green: number; blue: number }
  ): void {
    const { width, height, data } = imageData;
    const pixelCount = width * height;
    const backgroundMask = new Uint8Array(pixelCount);
    const keyYcc = this.rgbToYcc(backgroundColor.red, backgroundColor.green, backgroundColor.blue);
    const keyVectorCb = keyYcc.cb - 128;
    const keyVectorCr = keyYcc.cr - 128;
    const keyVectorLength = Math.hypot(keyVectorCb, keyVectorCr);
    const nearDistance = 24;
    const farDistance = 86;

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      const dataIndex = pixelIndex * 4;
      const alpha = data[dataIndex + 3];
      if (alpha === 0) {
        backgroundMask[pixelIndex] = 1;
        continue;
      }
      const { cb, cr } = this.rgbToYcc(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2]);
      const distance = Math.hypot(cb - keyYcc.cb, cr - keyYcc.cr);
      const dominance = this.resolveChromaDominance(data, dataIndex, backgroundColor);
      const matteAlpha = this.smoothstep(nearDistance, farDistance, distance);
      if (matteAlpha <= 0.02 || dominance >= 0.74) {
        data[dataIndex + 3] = 0;
        backgroundMask[pixelIndex] = 1;
        continue;
      }
      if (distance < 112 || dominance >= 0.18) {
        const nextAlpha = Math.round(alpha * Math.max(0, Math.min(1, matteAlpha)));
        data[dataIndex + 3] = nextAlpha;
        if (nextAlpha <= 10) {
          backgroundMask[pixelIndex] = 1;
        }
      }
    }

    // Feather and de-spill edge pixels to avoid green/magenta/blue halos.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const dataIndex = pixelIndex * 4;
        const alpha = data[dataIndex + 3];
        if (alpha === 0) {
          continue;
        }

        const ycc = this.rgbToYcc(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2]);
        const distance = Math.hypot(ycc.cb - keyYcc.cb, ycc.cr - keyYcc.cr);
        const touchesBackground = this.hasBackgroundNeighbor(backgroundMask, width, height, x, y, 1);
        const chromaDominance = this.resolveChromaDominance(data, dataIndex, backgroundColor);
        if (!touchesBackground && distance > 122 && chromaDominance < 0.14) {
          continue;
        }

        const distanceAlpha = this.smoothstep(nearDistance, 122, distance);
        const edgeAlpha = touchesBackground ? 0.82 : 0.94;
        const dominanceAlpha = chromaDominance >= 0.16
          ? Math.max(0.18, 1 - chromaDominance * 1.35)
          : 1;
        const nextAlpha = Math.round(alpha * Math.max(0.08, Math.min(edgeAlpha, distanceAlpha, dominanceAlpha)));
        if (nextAlpha < alpha) {
          data[dataIndex + 3] = nextAlpha;
        }
        this.removeChromaProjectionSpill(
          data,
          dataIndex,
          keyVectorCb,
          keyVectorCr,
          keyVectorLength,
          distance
        );
        this.removeChromaSpill(data, dataIndex, backgroundColor, touchesBackground || chromaDominance >= 0.1);
      }
    }

    this.removeChromaRimPixels(imageData, backgroundMask, backgroundColor);
    this.removeTinyAlphaSpeckles(imageData, 12);
  }

  private clearSequenceFrameEdgePixels(imageData: ImageData): void {
    const { width, height, data } = imageData;
    const border = Math.max(1, Math.min(10, Math.round(Math.min(width, height) * 0.012)));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x >= border && y >= border && x < width - border && y < height - border) {
          continue;
        }
        data[(y * width + x) * 4 + 3] = 0;
      }
    }
  }

  private smoothstep(edge0: number, edge1: number, value: number): number {
    if (edge1 <= edge0) {
      return 0;
    }
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  }

  private rgbToYcc(red: number, green: number, blue: number): { y: number; cb: number; cr: number } {
    const y = 0.299 * red + 0.587 * green + 0.114 * blue;
    return {
      y,
      cb: (blue - y) * 0.564 + 128,
      cr: (red - y) * 0.713 + 128,
    };
  }

  private yccToRgb(y: number, cb: number, cr: number): { red: number; green: number; blue: number } {
    return {
      red: this.clampColor(y + 1.402 * (cr - 128)),
      green: this.clampColor(y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)),
      blue: this.clampColor(y + 1.772 * (cb - 128)),
    };
  }

  private clampColor(value: number): number {
    return Math.max(0, Math.min(255, Math.round(value)));
  }

  private removeChromaProjectionSpill(
    data: Uint8ClampedArray,
    index: number,
    keyVectorCb: number,
    keyVectorCr: number,
    keyVectorLength: number,
    distance: number
  ): void {
    if (keyVectorLength <= 1 || distance >= 118 || data[index + 3] === 0) {
      return;
    }
    const ycc = this.rgbToYcc(data[index], data[index + 1], data[index + 2]);
    const pixelVectorCb = ycc.cb - 128;
    const pixelVectorCr = ycc.cr - 128;
    const projection =
      (pixelVectorCb * keyVectorCb + pixelVectorCr * keyVectorCr) / keyVectorLength;
    if (projection <= 0) {
      return;
    }
    const weight = this.smoothstep(0, 1, (118 - distance) / 118) * 0.92;
    const unitCb = keyVectorCb / keyVectorLength;
    const unitCr = keyVectorCr / keyVectorLength;
    const nextCb = 128 + (pixelVectorCb - unitCb * projection * weight);
    const nextCr = 128 + (pixelVectorCr - unitCr * projection * weight);
    const nextRgb = this.yccToRgb(ycc.y, nextCb, nextCr);
    data[index] = nextRgb.red;
    data[index + 1] = nextRgb.green;
    data[index + 2] = nextRgb.blue;
  }

  private colorDistanceToBackground(
    data: Uint8ClampedArray,
    index: number,
    backgroundColor: { red: number; green: number; blue: number }
  ): number {
    const redDistance = data[index] - backgroundColor.red;
    const greenDistance = data[index + 1] - backgroundColor.green;
    const blueDistance = data[index + 2] - backgroundColor.blue;
    return Math.sqrt(
      redDistance * redDistance +
      greenDistance * greenDistance +
      blueDistance * blueDistance
    );
  }

  private resolveChromaDominance(
    data: Uint8ClampedArray,
    index: number,
    backgroundColor: { red: number; green: number; blue: number }
  ): number {
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (backgroundColor.green > backgroundColor.red && backgroundColor.green > backgroundColor.blue) {
      return (green - Math.max(red, blue)) / Math.max(1, green);
    }
    if (backgroundColor.red > backgroundColor.green && backgroundColor.blue > backgroundColor.green) {
      return (Math.min(red, blue) - green) / Math.max(1, Math.min(red, blue));
    }
    if (backgroundColor.blue > backgroundColor.red && backgroundColor.blue > backgroundColor.green) {
      return (blue - Math.max(red, green)) / Math.max(1, blue);
    }
    return 0;
  }

  private removeChromaSpill(
    data: Uint8ClampedArray,
    index: number,
    backgroundColor: { red: number; green: number; blue: number },
    isEdgePixel: boolean
  ): void {
    if (!isEdgePixel || data[index + 3] === 0) {
      return;
    }
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    if (backgroundColor.green > backgroundColor.red && backgroundColor.green > backgroundColor.blue) {
      const neutralCeiling = Math.max(red, blue) + 8;
      if (green > neutralCeiling) {
        data[index + 1] = Math.max(0, Math.min(255, neutralCeiling));
      }
      return;
    }
    if (backgroundColor.red > backgroundColor.green && backgroundColor.blue > backgroundColor.green) {
      const neutralCeiling = green + 10;
      if (red > neutralCeiling) {
        data[index] = Math.max(0, Math.min(255, neutralCeiling));
      }
      if (blue > neutralCeiling) {
        data[index + 2] = Math.max(0, Math.min(255, neutralCeiling));
      }
      return;
    }
    if (backgroundColor.blue > backgroundColor.red && backgroundColor.blue > backgroundColor.green) {
      const neutralCeiling = Math.max(red, green) + 8;
      if (blue > neutralCeiling) {
        data[index + 2] = Math.max(0, Math.min(255, neutralCeiling));
      }
    }
  }

  private removeChromaRimPixels(
    imageData: ImageData,
    backgroundMask: Uint8Array,
    backgroundColor: { red: number; green: number; blue: number }
  ): void {
    const { width, height, data } = imageData;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const dataIndex = pixelIndex * 4;
        if (data[dataIndex + 3] === 0) {
          continue;
        }
        const touchesBackground = this.hasBackgroundNeighbor(backgroundMask, width, height, x, y, 2);
        if (!touchesBackground) {
          continue;
        }
        const dominance = this.resolveChromaDominance(data, dataIndex, backgroundColor);
        const distance = this.colorDistanceToBackground(data, dataIndex, backgroundColor);
        if (dominance >= 0.2 || distance <= 86) {
          data[dataIndex + 3] = Math.min(data[dataIndex + 3], Math.round(255 * 0.22));
          this.removeChromaSpill(data, dataIndex, backgroundColor, true);
        }
      }
    }
  }

  private removeTinyAlphaSpeckles(imageData: ImageData, maxComponentSize: number): void {
    const { width, height, data } = imageData;
    const visited = new Uint8Array(width * height);
    const queue: number[] = [];

    for (let start = 0; start < visited.length; start += 1) {
      if (visited[start] !== 0 || data[start * 4 + 3] <= 8) {
        continue;
      }
      let cursor = 0;
      queue.length = 0;
      queue.push(start);
      visited[start] = 1;
      while (cursor < queue.length) {
        const pixelIndex = queue[cursor];
        cursor += 1;
        const x = pixelIndex % width;
        const y = Math.floor(pixelIndex / width);
        const neighbors = [pixelIndex - 1, pixelIndex + 1, pixelIndex - width, pixelIndex + width];
        for (const nextIndex of neighbors) {
          if (nextIndex < 0 || nextIndex >= visited.length || visited[nextIndex] !== 0) {
            continue;
          }
          const nextX = nextIndex % width;
          const nextY = Math.floor(nextIndex / width);
          if (Math.abs(nextX - x) + Math.abs(nextY - y) !== 1) {
            continue;
          }
          if (data[nextIndex * 4 + 3] <= 8) {
            continue;
          }
          visited[nextIndex] = 1;
          queue.push(nextIndex);
        }
      }
      if (queue.length > maxComponentSize) {
        continue;
      }
      for (const pixelIndex of queue) {
        data[pixelIndex * 4 + 3] = 0;
      }
    }
  }

  private removeLightBackgroundPixels(imageData: ImageData): void {
    const { width, height, data } = imageData;
    const pixelCount = width * height;
    const backgroundMask = new Uint8Array(pixelCount);
    const queue: number[] = [];
    let cursor = 0;
    const backgroundColor = this.estimateBorderBackgroundColor(imageData);

    const enqueue = (x: number, y: number): void => {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
      }
      const pixelIndex = y * width + x;
      if (backgroundMask[pixelIndex] !== 0) {
        return;
      }
      const dataIndex = pixelIndex * 4;
      if (!this.isBackgroundCandidate(data, dataIndex, backgroundColor, 232, 34, 34)) {
        return;
      }
      backgroundMask[pixelIndex] = 1;
      queue.push(pixelIndex);
    };

    for (let x = 0; x < width; x += 1) {
      enqueue(x, 0);
      enqueue(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(0, y);
      enqueue(width - 1, y);
    }

    while (cursor < queue.length) {
      const pixelIndex = queue[cursor];
      cursor += 1;
      const x = pixelIndex % width;
      const y = Math.floor(pixelIndex / width);
      enqueue(x + 1, y);
      enqueue(x - 1, y);
      enqueue(x, y + 1);
      enqueue(x, y - 1);
    }

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (backgroundMask[pixelIndex] === 0) {
        continue;
      }
      data[pixelIndex * 4 + 3] = 0;
    }

    // Soften the white matte left by anti-aliasing without deleting internal white clothing/details.
    const featheredAlpha = new Uint8ClampedArray(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      featheredAlpha[pixelIndex] = data[pixelIndex * 4 + 3];
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        if (backgroundMask[pixelIndex] !== 0) {
          continue;
        }
        const dataIndex = pixelIndex * 4;
        const alpha = data[dataIndex + 3];
        if (alpha === 0 || !this.isBackgroundCandidate(data, dataIndex, backgroundColor, 206, 56, 58)) {
          continue;
        }

        const touchesBackground = this.hasBackgroundNeighbor(backgroundMask, width, height, x, y, 1);
        if (touchesBackground) {
          featheredAlpha[pixelIndex] = Math.min(featheredAlpha[pixelIndex], Math.round(alpha * 0.35));
          continue;
        }

        if (this.hasBackgroundNeighbor(backgroundMask, width, height, x, y, 2)) {
          featheredAlpha[pixelIndex] = Math.min(featheredAlpha[pixelIndex], Math.round(alpha * 0.7));
        }
      }
    }

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      data[pixelIndex * 4 + 3] = featheredAlpha[pixelIndex];
    }
  }

  private estimateBorderBackgroundColor(imageData: ImageData): { red: number; green: number; blue: number } | null {
    const { width, height, data } = imageData;
    let redTotal = 0;
    let greenTotal = 0;
    let blueTotal = 0;
    let count = 0;

    const sample = (x: number, y: number): void => {
      const index = (y * width + x) * 4;
      const alpha = data[index + 3];
      if (alpha === 0) {
        return;
      }
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const brightness = red * 0.299 + green * 0.587 + blue * 0.114;
      if (brightness < 190 || maxChannel - minChannel > 72) {
        return;
      }
      redTotal += red;
      greenTotal += green;
      blueTotal += blue;
      count += 1;
    };

    for (let x = 0; x < width; x += 1) {
      sample(x, 0);
      sample(x, height - 1);
    }
    for (let y = 1; y < height - 1; y += 1) {
      sample(0, y);
      sample(width - 1, y);
    }

    if (count < Math.max(4, Math.floor((width + height) / 16))) {
      return null;
    }

    return {
      red: Math.round(redTotal / count),
      green: Math.round(greenTotal / count),
      blue: Math.round(blueTotal / count),
    };
  }

  private isBackgroundCandidate(
    data: Uint8ClampedArray,
    index: number,
    backgroundColor: { red: number; green: number; blue: number } | null,
    minBrightness: number,
    maxChannelSpread: number,
    maxColorDistance: number
  ): boolean {
    const alpha = data[index + 3];
    if (alpha === 0) {
      return true;
    }
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const brightness = red * 0.299 + green * 0.587 + blue * 0.114;
    const isLightNeutral = brightness >= minBrightness && maxChannel - minChannel <= maxChannelSpread;
    if (isLightNeutral) {
      return true;
    }
    if (!backgroundColor) {
      return false;
    }
    const redDistance = red - backgroundColor.red;
    const greenDistance = green - backgroundColor.green;
    const blueDistance = blue - backgroundColor.blue;
    const colorDistance = Math.sqrt(
      redDistance * redDistance +
      greenDistance * greenDistance +
      blueDistance * blueDistance
    );
    return brightness >= 178 && colorDistance <= maxColorDistance;
  }

  private hasBackgroundNeighbor(
    backgroundMask: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    radius: number
  ): boolean {
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
      for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) {
          continue;
        }
        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) {
          continue;
        }
        if (backgroundMask[nextY * width + nextX] !== 0) {
          return true;
        }
      }
    }
    return false;
  }

  private findOpaqueBounds(imageData: ImageData): {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null {
    const { width, height, data } = imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha <= 8) {
          continue;
        }
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    if (maxX < minX || maxY < minY) {
      return null;
    }

    return { minX, minY, maxX, maxY };
  }

  private resolveMaxAllowedLineThickness(
    imageWidth: number,
    imageHeight: number,
    rows: number,
    cols: number
  ): number {
    const maxLineByWidth = cols > 1 ? Math.floor((imageWidth - cols) / (cols - 1)) : Number.MAX_SAFE_INTEGER;
    const maxLineByHeight = rows > 1 ? Math.floor((imageHeight - rows) / (rows - 1)) : Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.min(maxLineByWidth, maxLineByHeight));
  }

  private async resolveSplitLineThicknessPx(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThicknessPercent: number,
    lineThicknessPxFallback: number
  ): Promise<number> {
    if (!Number.isFinite(lineThicknessPercent)) {
      return Math.max(0, Math.floor(lineThicknessPxFallback));
    }

    const normalizedPercent = Math.max(0, lineThicknessPercent);
    if (normalizedPercent <= 0) {
      return 0;
    }

    const image = await loadImageElement(sourceImage);
    const imageWidth = Math.max(1, image.naturalWidth);
    const imageHeight = Math.max(1, image.naturalHeight);
    const basis = Math.max(1, Math.min(imageWidth, imageHeight));
    const rawPixelThickness = Math.max(1, Math.round((basis * normalizedPercent) / 100));
    const maxAllowedThickness = this.resolveMaxAllowedLineThickness(imageWidth, imageHeight, rows, cols);
    return Math.max(0, Math.min(rawPixelThickness, maxAllowedThickness));
  }

  private async readStoryboardMetadata(
    sourceImage: string
  ): Promise<{ gridRows: number; gridCols: number; frameNotes: string[] } | null> {
    try {
      const metadata = await readStoryboardImageMetadata(sourceImage);
      if (!metadata) {
        return null;
      }

      return {
        gridRows: metadata.gridRows,
        gridCols: metadata.gridCols,
        frameNotes: Array.isArray(metadata.frameNotes) ? metadata.frameNotes : [],
      };
    } catch {
      return null;
    }
  }

  private splitIntoSegments(totalSize: number, segmentCount: number): number[] {
    const baseSize = Math.floor(totalSize / segmentCount);
    const remainder = totalSize % segmentCount;

    return Array.from(
      { length: segmentCount },
      (_item, index) => baseSize + (index < remainder ? 1 : 0)
    );
  }

  private async localSplit(
    sourceImage: string,
    rows: number,
    cols: number,
    lineThickness: number
  ): Promise<string[]> {
    const image = await loadImageElement(sourceImage);

    const maxAllowedLine = this.resolveMaxAllowedLineThickness(
      image.naturalWidth,
      image.naturalHeight,
      rows,
      cols
    );
    const resolvedLineThickness = Math.min(Math.max(0, lineThickness), maxAllowedLine);

    const usableWidth = image.naturalWidth - (cols - 1) * resolvedLineThickness;
    const usableHeight = image.naturalHeight - (rows - 1) * resolvedLineThickness;

    if (usableWidth < cols || usableHeight < rows) {
      throw new Error('分割线过粗，无法完成切割');
    }

    const columnWidths = this.splitIntoSegments(usableWidth, cols);
    const rowHeights = this.splitIntoSegments(usableHeight, rows);

    const results: string[] = [];

    const yOffsets: number[] = [];
    let yCursor = 0;
    for (let row = 0; row < rows; row += 1) {
      yOffsets.push(yCursor);
      yCursor += rowHeights[row];
      if (row < rows - 1) {
        yCursor += resolvedLineThickness;
      }
    }

    const xOffsets: number[] = [];
    let xCursor = 0;
    for (let col = 0; col < cols; col += 1) {
      xOffsets.push(xCursor);
      xCursor += columnWidths[col];
      if (col < cols - 1) {
        xCursor += resolvedLineThickness;
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const targetWidth = columnWidths[col];
        const targetHeight = rowHeights[row];

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('无法初始化画布');
        }

        context.drawImage(
          image,
          xOffsets[col],
          yOffsets[row],
          targetWidth,
          targetHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );
        results.push(canvasToDataUrl(canvas));
      }
    }

    return results;
  }
}
