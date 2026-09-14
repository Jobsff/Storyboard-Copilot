/**
 * AI 抠图（批次16）：SAM-HQ 内网服务的纯函数编排。
 *
 * 职责：点列表管理、decode 的 404 自动恢复（重 embed + 重放全部历史点一次）、
 * 服务端蒙版（尺寸随版本 256/1024，按实际宽高消费）→ 原图尺寸的引导滤波放大 + 1px 羽化、
 * 前景占比统计、health.models 模型档自适应。
 * 全部为纯函数（网络与 canvas 由调用方注入/承担），可 vitest 直测。
 */

import type { SamModel } from '../../../commands/sam';

export type AiMattingModel = SamModel;

/**
 * SAM/BiRefNet 上传尺寸（服务端上限 50MB）：长边 > maxDimension 时等比降采样，
 * 否则原尺寸。纯函数，供 embed 上传与 BiRefNet 一键去底共用。
 */
export function resolveSamUploadSize(
  naturalWidth: number,
  naturalHeight: number,
  maxDimension: number
): { width: number; height: number } {
  if (naturalWidth <= 0 || naturalHeight <= 0 || maxDimension <= 0) {
    return { width: Math.max(1, Math.round(naturalWidth)), height: Math.max(1, Math.round(naturalHeight)) };
  }
  const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
  return {
    width: Math.max(1, Math.round(naturalWidth * scale)),
    height: Math.max(1, Math.round(naturalHeight * scale)),
  };
}

/** 编辑器默认模型档（health.models 缺失/为空时的兜底，对齐旧服务行为）。 */
export const FALLBACK_MODELS: AiMattingModel[] = ['vit_t', 'vit_b'];

/**
 * health.models → 编辑器可用模型档：空/缺失兜底 ['vit_t','vit_b']（旧服务零变化）；
 * 非空时原样采用（服务端升级后含 vit_l 等新档自动出现）。
 */
export function resolveAvailableModels(models: readonly string[] | undefined): AiMattingModel[] {
  if (!models || models.length === 0) {
    return [...FALLBACK_MODELS];
  }
  return [...models];
}

/**
 * 当前选中模型 ∩ 可用档：当前档仍可用则保持；否则落到可用档首项
 * （服务端下线某档或首次打开时自动校正，调用方负责触发重 embed）。
 */
export function pickEffectiveModel(
  current: AiMattingModel,
  available: readonly AiMattingModel[]
): AiMattingModel {
  if (available.includes(current)) {
    return current;
  }
  return available[0] ?? current;
}

/**
 * RGBA 像素 → 灰度（luminance 近似 0.299R+0.587G+0.114B 取整）。
 * 灰度蒙版（R=G=B）与原「取红通道」逐像素等价；RGB/RGBA 彩色蒙版更稳。
 */
export function rgbaToGrayLuminance(data: Uint8ClampedArray | Uint8Array): Uint8Array {
  const pixelCount = Math.floor(data.length / 4);
  const gray = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const o = i * 4;
    gray[i] = Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
  }
  return gray;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type AiMattingPoint = {
  /** 原图像素坐标。 */
  x: number;
  y: number;
  /** 1 = 前景（保留），0 = 背景（排除）。 */
  label: 0 | 1;
};

export function appendPoint(
  points: AiMattingPoint[],
  point: AiMattingPoint
): AiMattingPoint[] {
  return [...points, point];
}

export function removePointAt(
  points: AiMattingPoint[],
  index: number
): AiMattingPoint[] {
  return points.filter((_, i) => i !== index);
}

export function clearPoints(): AiMattingPoint[] {
  return [];
}

/** 服务端入参：[x, y, label] 三元组（坐标四舍五入到整数像素）。 */
export function pointsToTriples(
  points: AiMattingPoint[]
): Array<[number, number, number]> {
  return points.map((point) => [
    Math.round(point.x),
    Math.round(point.y),
    point.label,
  ]);
}

/** decode 回调的返回：蒙版灰度数组 + PNG 实际宽高（服务端升级后尺寸不再恒为 256）。 */
export type DecodedMask = {
  mask: Uint8Array;
  width: number;
  height: number;
};

/**
 * decode 编排：正常 decode；命中 embed 过期（404）时自动重新 embed 并
 * **重放全部历史点一次**（服务端无状态，必须带全量点）。仍失败则抛出。
 * decode/embed 为注入回调（网络由调用方承担），可单测。
 * 蒙版尺寸透传自 decode 回调（PNG 实际宽高），调用方据此做后续放大/合成。
 */
export async function decodeMaskWithRecovery(args: {
  points: AiMattingPoint[];
  embedId: string;
  model: AiMattingModel;
  decode: (embedId: string, points: AiMattingPoint[]) => Promise<DecodedMask>;
  embed: (model: AiMattingModel) => Promise<string>;
  isEmbedExpired: (error: unknown) => boolean;
}): Promise<{ embedId: string; mask: Uint8Array; maskWidth: number; maskHeight: number }> {
  const { points, embedId, model, decode, embed, isEmbedExpired } = args;
  const toResult = async (id: string) => {
    const decoded = await decode(id, points);
    return {
      embedId: id,
      mask: decoded.mask,
      maskWidth: decoded.width,
      maskHeight: decoded.height,
    };
  };
  try {
    return await toResult(embedId);
  } catch (error) {
    if (!isEmbedExpired(error)) {
      throw error;
    }
    const newEmbedId = await embed(model);
    return toResult(newEmbedId);
  }
}

/**
 * 服务端灰度蒙版（任意尺寸：旧服务 256，升级后 1024）→ 目标尺寸的双线性插值放大。
 * 最近邻坐标落点以目标像素中心在源图上的连续坐标为准，边缘钳制。
 */
export function upsampleMaskBilinear(
  src: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) {
    return new Uint8Array(0);
  }
  const dst = new Uint8Array(dstWidth * dstHeight);
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  for (let dy = 0; dy < dstHeight; dy += 1) {
    // 目标像素中心映射回源坐标（半像素对齐）
    const sy = (dy + 0.5) * yRatio - 0.5;
    const y0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
    const y1 = Math.min(srcHeight - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - y0));
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const sx = (dx + 0.5) * xRatio - 0.5;
      const x0 = Math.max(0, Math.min(srcWidth - 1, Math.floor(sx)));
      const x1 = Math.min(srcWidth - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const top = src[y0 * srcWidth + x0] * (1 - fx) + src[y0 * srcWidth + x1] * fx;
      const bottom =
        src[y1 * srcWidth + x0] * (1 - fx) + src[y1 * srcWidth + x1] * fx;
      dst[dy * dstWidth + dx] = Math.round(top * (1 - fy) + bottom * fy);
    }
  }
  return dst;
}

/** 1px 羽化：3×3 盒式模糊（边缘 256 蒙版放大的固有锯齿过渡，见 API 文档第五节）。 */
export function featherMask(
  mask: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  if (width <= 0 || height <= 0) {
    return new Uint8Array(0);
  }
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue;
          }
          sum += mask[ny * width + nx];
          count += 1;
        }
      }
      out[y * width + x] = Math.round(sum / count);
    }
  }
  return out;
}

/** 前景占比（灰度 > 127 记为前景）。用于「蒙版全黑」检测。 */
export function maskForegroundRatio(mask: Uint8Array): number {
  if (mask.length === 0) {
    return 0;
  }
  let foreground = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] > 127) {
      foreground += 1;
    }
  }
  return foreground / mask.length;
}

/**
 * 孔洞填充（批次16 客户端增强）：从四边界对「背景」做四邻域泛洪，
 * 凡不可达边界的背景区（封闭孔洞）填为前景——修头发黑斑与四肢碎裂。
 * 前景判定与前景占比一致：灰度 > 127。
 */
export function fillMaskHoles(
  gray: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  const out = new Uint8Array(gray);
  if (width <= 0 || height <= 0 || out.length !== width * height) {
    return out;
  }
  const isForeground = (value: number) => value > 127;
  const external = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const push = (pixelIndex: number): void => {
    if (external[pixelIndex] === 0 && !isForeground(gray[pixelIndex])) {
      external[pixelIndex] = 1;
      queue[tail] = pixelIndex;
      tail += 1;
    }
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = (pixelIndex - x) / width;
    if (x > 0) push(pixelIndex - 1);
    if (x < width - 1) push(pixelIndex + 1);
    if (y > 0) push(pixelIndex - width);
    if (y < height - 1) push(pixelIndex + width);
  }
  for (let i = 0; i < out.length; i += 1) {
    if (external[i] === 0 && !isForeground(gray[i])) {
      out[i] = 255;
    }
  }
  return out;
}

/** 灰度 box 均值滤波（积分图，O(N)；窗口出界按实际面积取均值）。 */
function boxFilterMean(
  src: Float64Array,
  width: number,
  height: number,
  radius: number
): Float64Array {
  const sat = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += src[y * width + x];
      sat[(y + 1) * (width + 1) + (x + 1)] = sat[y * (width + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const sum =
        sat[(y1 + 1) * (width + 1) + (x1 + 1)]
        - sat[y0 * (width + 1) + (x1 + 1)]
        - sat[(y1 + 1) * (width + 1) + x0]
        + sat[y0 * (width + 1) + x0];
      out[y * width + x] = sum / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

/** 灰度引导滤波（He et al. 局部线性模型；引导 I 与目标 p 均为 0-1 浮点域）。 */
function guidedFilterGray(
  guide: Float64Array,
  target: Float64Array,
  width: number,
  height: number,
  radius: number,
  eps: number
): Float64Array {
  const pixelCount = width * height;
  const meanI = boxFilterMean(guide, width, height, radius);
  const meanP = boxFilterMean(target, width, height, radius);
  const ip = new Float64Array(pixelCount);
  const ii = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    ip[i] = guide[i] * target[i];
    ii[i] = guide[i] * guide[i];
  }
  const corrIp = boxFilterMean(ip, width, height, radius);
  const corrII = boxFilterMean(ii, width, height, radius);
  const a = new Float64Array(pixelCount);
  const b = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const varI = corrII[i] - meanI[i] * meanI[i];
    a[i] = (corrIp[i] - meanI[i] * meanP[i]) / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxFilterMean(a, width, height, radius);
  const meanB = boxFilterMean(b, width, height, radius);
  const q = new Float64Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    q[i] = Math.max(0, Math.min(1, meanA[i] * guide[i] + meanB[i]));
  }
  return q;
}

/** 等比降采样灰度图（box 均值）。 */
function downsampleGray(
  src: Float64Array,
  width: number,
  height: number,
  dstWidth: number,
  dstHeight: number
): Float64Array {
  const out = new Float64Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y += 1) {
    const y0 = Math.floor((y * height) / dstHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / dstHeight));
    for (let x = 0; x < dstWidth; x += 1) {
      const x0 = Math.floor((x * width) / dstWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / dstWidth));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          sum += src[sy * width + sx];
          count += 1;
        }
      }
      out[y * dstWidth + x] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

const GUIDED_WORK_PIXEL_LIMIT = 6_000_000;

/**
 * 蒙版引导滤波上采样（批次16 客户端增强）：服务端蒙版以原图亮度为引导 I 做引导滤波
 * 放大到原图尺寸——边缘按图像结构对齐（显著优于双线性的块状边）。
 * 超大图内部自动降到 ≤6M 像素工作域滤波后再放大回原尺寸（边缘损失可忽略），
 * radius 语义为「原图域」像素半径，工作域内按比例换算。
 */
export function upsampleMaskGuided(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  guideRgba: Uint8ClampedArray | Uint8Array,
  guideWidth: number,
  guideHeight: number,
  radius = 8,
  eps = 1e-3
): Uint8Array {
  if (
    guideWidth <= 0 || guideHeight <= 0
    || maskWidth <= 0 || maskHeight <= 0
    || guideRgba.length < guideWidth * guideHeight * 4
  ) {
    return new Uint8Array(0);
  }

  const guideGray = new Float64Array(guideWidth * guideHeight);
  for (let i = 0; i < guideGray.length; i += 1) {
    const o = i * 4;
    guideGray[i] =
      (0.299 * guideRgba[o] + 0.587 * guideRgba[o + 1] + 0.114 * guideRgba[o + 2]) / 255;
  }

  // 工作域上限：超大图先降采样滤波（radius 随比例换算），再放大回原尺寸
  let workWidth = guideWidth;
  let workHeight = guideHeight;
  let workScale = 1;
  while (workWidth * workHeight > GUIDED_WORK_PIXEL_LIMIT) {
    workWidth = Math.max(1, Math.floor(workWidth / 2));
    workHeight = Math.max(1, Math.floor(workHeight / 2));
    workScale *= 2;
  }

  let guideWork = guideGray;
  if (workScale > 1) {
    guideWork = downsampleGray(guideGray, guideWidth, guideHeight, workWidth, workHeight);
  }
  const maskWork = upsampleMaskBilinear(mask, maskWidth, maskHeight, workWidth, workHeight);
  const maskWork01 = new Float64Array(workWidth * workHeight);
  for (let i = 0; i < maskWork.length; i += 1) {
    maskWork01[i] = maskWork[i] / 255;
  }

  const workRadius = Math.max(2, Math.round(radius / workScale));
  const filtered = guidedFilterGray(
    guideWork, maskWork01, workWidth, workHeight, workRadius, eps
  );

  const filtered255 = new Uint8Array(workWidth * workHeight);
  for (let i = 0; i < filtered.length; i += 1) {
    filtered255[i] = Math.round(filtered[i] * 255);
  }
  if (workScale > 1 || workWidth !== guideWidth || workHeight !== guideHeight) {
    return upsampleMaskBilinear(filtered255, workWidth, workHeight, guideWidth, guideHeight);
  }
  return filtered255;
}

/**
 * 「整体模式」自动布点（批次16 客户端增强）：中心优先 + 3×2 网格偏内 4 点，
 * 与既有正点按 6% 对角线距离去重；返回**新增**点（调用方自行合并）。
 */
export function generateAutoPoints(
  width: number,
  height: number,
  existing: AiMattingPoint[]
): AiMattingPoint[] {
  if (width <= 0 || height <= 0) {
    return [];
  }
  const candidates: Array<{ x: number; y: number }> = [
    { x: width / 2, y: height / 2 },
    { x: width / 4, y: height / 4 },
    { x: (3 * width) / 4, y: height / 4 },
    { x: width / 4, y: (3 * height) / 4 },
    { x: (3 * width) / 4, y: (3 * height) / 4 },
  ];
  const minDistance = Math.hypot(width, height) * 0.06;
  const added: AiMattingPoint[] = [];
  for (const candidate of candidates) {
    const x = clamp(candidate.x, 0, width - 1);
    const y = clamp(candidate.y, 0, height - 1);
    const duplicated = [...existing, ...added].some(
      (point) => Math.hypot(point.x - x, point.y - y) < minDistance
    );
    if (!duplicated) {
      added.push({ x, y, label: 1 });
    }
  }
  return added;
}
