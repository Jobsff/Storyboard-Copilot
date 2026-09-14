/**
 * 抠图键色解析 / 序列化 / 边框自动取键聚类（批次15 自 matting.ts 拆分，
 * matting.ts 统一 re-export，既有导入路径不受影响）。
 */

export type RgbTuple = [number, number, number];

/** 单次抠图最多键色数（渐变背景 / 墙+地面多键）。 */
export const MAX_KEY_COLORS = 4;

/**
 * 绿幕键色判定阈值（批次16 固化）：绿通道高出红蓝最大值至少 25 才算绿主导。
 * 真实绿幕键（9,210,24 / 6,162,29）远超此值；品红（244,5,197）/ 暗紫地面（125,65,104）
 * / 蓝（0,0,255）/ 灰（128,128,128）均为负值或远低于阈值。
 */
export const GREEN_KEY_DOMINANCE_MIN = 25;

/** 绿主导键色：g − max(r,b) ≥ GREEN_KEY_DOMINANCE_MIN（批次16 管线路由判据）。 */
export function isGreenKey(key: RgbTuple): boolean {
  return key[1] - Math.max(key[0], key[2]) >= GREEN_KEY_DOMINANCE_MIN;
}

/** 抠图管线类别。 */
export type MattingPipelineKind = 'green' | 'gentle';

/**
 * 键色组 → 管线路由（批次16，用户零感知）：
 * - 全部为绿键 → 'green'（批次15 完整管线：s* 影子识别 / despill / 种子自中和，
 *   绿幕真机实证效果好，一字不动）；
 * - 任一键非绿 → 'gentle'（v0.4.1 = 批次14 温和管线：批次15 为绿幕加的去污染 /
 *   影子 / 种子门在品红场景过度治疗，真机实证品红不如批次14）。
 * 多键最近匹配属纯基建，两条管线共享，与路由正交。
 */
export function routeMattingPipeline(keys: RgbTuple[]): MattingPipelineKind {
  return keys.length > 0 && keys.every(isGreenKey) ? 'green' : 'gentle';
}

const KEY_COLOR_STORAGE_KEY = 'keyColor';
const KEY_COLORS_STORAGE_KEY = 'keyColors';


/** 边框取键聚类选项。 */
export interface SampleBorderKeyColorsOptions {
  /** 最多输出键数（默认 MAX_KEY_COLORS=4）。 */
  maxColors?: number;
  /** 聚类合并半径（欧氏距离，默认 40：渐变自然分裂为 2~3 键，均色区合并为 1 键）。 */
  mergeRadius?: number;
  /** 最小样本占比（低于此占比的簇丢弃，默认 0.03）。 */
  minShare?: number;
  /** 边框取样厚度（像素，默认 2）。 */
  borderThickness?: number;
}

/**
 * 边框主色聚类自动取键（批次15）：取样边框像素 → 5bit/通道分桶 → 按计数贪心聚类。
 * 纯色背景聚成 1 键；品红墙+暗紫地面聚成 2~3 键；返回按样本数降序的 1~4 个键色。
 */
export function sampleBorderKeyColors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: SampleBorderKeyColorsOptions = {}
): RgbTuple[] {
  if (width < 1 || height < 1 || data.length < width * height * 4) {
    return [];
  }
  const maxColors = Math.max(1, Math.min(MAX_KEY_COLORS, options.maxColors ?? MAX_KEY_COLORS));
  const mergeRadius = options.mergeRadius ?? 40;
  const minShare = options.minShare ?? 0.03;
  const thickness = Math.max(1, options.borderThickness ?? 2);

  interface Bucket { count: number; r: number; g: number; b: number }
  const buckets = new Map<number, Bucket>();
  let total = 0;
  const sample = (x: number, y: number): void => {
    const index = (y * width + x) * 4;
    if (data[index + 3] === 0) {
      return;
    }
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
    total += 1;
  };

  for (let x = 0; x < width; x += 1) {
    for (let t = 0; t < thickness; t += 1) {
      sample(x, t);
      sample(x, height - 1 - t);
    }
  }
  for (let y = thickness; y < height - thickness; y += 1) {
    for (let t = 0; t < thickness; t += 1) {
      sample(t, y);
      sample(width - 1 - t, y);
    }
  }
  if (total === 0) {
    return [];
  }

  const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);
  interface Cluster { count: number; r: number; g: number; b: number }
  const clusters: Cluster[] = [];
  for (const bucket of sorted) {
    const br = bucket.r / bucket.count;
    const bg = bucket.g / bucket.count;
    const bb = bucket.b / bucket.count;
    let bestIndex = -1;
    let bestDist = Infinity;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      const cr = cluster.r / cluster.count - br;
      const cg = cluster.g / cluster.count - bg;
      const cb = cluster.b / cluster.count - bb;
      const dist = Math.sqrt(cr * cr + cg * cg + cb * cb);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = index;
      }
    }
    const target = bestDist <= mergeRadius ? clusters[bestIndex]
      : bestDist <= mergeRadius * 2 && clusters.length >= maxColors ? clusters[bestIndex]
      : null;
    if (target) {
      target.count += bucket.count;
      target.r += bucket.r;
      target.g += bucket.g;
      target.b += bucket.b;
    } else if (clusters.length < maxColors) {
      clusters.push({ count: bucket.count, r: bucket.r, g: bucket.g, b: bucket.b });
    }
  }

  return clusters
    .filter((cluster) => cluster.count >= Math.max(16, total * minShare))
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map((cluster) => [
      Math.round(cluster.r / cluster.count),
      Math.round(cluster.g / cluster.count),
      Math.round(cluster.b / cluster.count),
    ] as RgbTuple);
}

/**
 * 解析工具 options 里的单键色（options 形态 `{ keyColor?: [number,number,number] }`；
 * ToolOptionsPrimitive 不收数组，编辑器按 annotate 惯例以 "r,g,b" 字符串落盘，
 * 数组 / "[r,g,b]" / "r,g,b" 三种形态均兼容读取）。
 */
export function parseMattingKeyColor(value: unknown): RgbTuple | null {
  let parts: unknown[];
  if (Array.isArray(value)) {
    parts = value;
  } else if (typeof value === 'string') {
    let body = value.trim();
    if (!body) {
      return null;
    }
    if (body.startsWith('[') && body.endsWith(']')) {
      body = body.slice(1, -1);
    }
    parts = body.split(',');
  } else {
    return null;
  }

  if (parts.length !== 3) {
    return null;
  }

  const channels: number[] = [];
  for (const part of parts) {
    const numeric = typeof part === 'number' ? part : Number(String(part).trim());
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 255) {
      return null;
    }
    channels.push(Math.round(numeric));
  }
  return channels as RgbTuple;
}

export function stringifyMattingKeyColor(color: RgbTuple): string {
  return color.join(',');
}

/**
 * 解析多键色（批次15）：兼容 `[[r,g,b],...]` 数组 / `"[r,g,b],[r,g,b]"` JSON 串 /
 * `"r,g,b|r,g,b"` 竖线串 / 单键 `"r,g,b"`；超出 MAX_KEY_COLORS 截断。
 */
export function parseMattingKeyColors(value: unknown): RgbTuple[] | null {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'number')) {
      const single = parseMattingKeyColor(value);
      return single ? [single] : null;
    }
    const colors: RgbTuple[] = [];
    for (const item of value) {
      const parsed = parseMattingKeyColor(item);
      if (!parsed) {
        return null;
      }
      colors.push(parsed);
    }
    return colors.length > 0 ? colors.slice(0, MAX_KEY_COLORS) : null;
  }

  if (typeof value !== 'string') {
    return null;
  }
  const body = value.trim();
  if (!body) {
    return null;
  }
  if (body.startsWith('[')) {
    try {
      return parseMattingKeyColors(JSON.parse(body) as unknown);
    } catch {
      return null;
    }
  }
  const colors: RgbTuple[] = [];
  for (const segment of body.split('|')) {
    const parsed = parseMattingKeyColor(segment);
    if (!parsed) {
      return null;
    }
    colors.push(parsed);
  }
  return colors.length > 0 ? colors.slice(0, MAX_KEY_COLORS) : null;
}

export function stringifyMattingKeyColors(colors: RgbTuple[]): string {
  return colors
    .slice(0, MAX_KEY_COLORS)
    .map((color) => stringifyMattingKeyColor(color))
    .join('|');
}

export function readMattingKeyColorFromOptions(
  options: Record<string, unknown>
): RgbTuple | null {
  return parseMattingKeyColor(options[KEY_COLOR_STORAGE_KEY]);
}

export function writeMattingKeyColorToOptions(
  options: Record<string, unknown>,
  color: RgbTuple
): Record<string, unknown> {
  return { ...options, [KEY_COLOR_STORAGE_KEY]: stringifyMattingKeyColor(color) };
}

/** 读多键色：优先 `keyColors`，回落旧单键 `keyColor`（老项目兼容）。 */
export function readMattingKeyColorsFromOptions(
  options: Record<string, unknown>
): RgbTuple[] | null {
  if (options[KEY_COLORS_STORAGE_KEY] !== undefined) {
    const parsed = parseMattingKeyColors(options[KEY_COLORS_STORAGE_KEY]);
    if (parsed && parsed.length > 0) {
      return parsed;
    }
  }
  const single = readMattingKeyColorFromOptions(options);
  return single ? [single] : null;
}

/** 写多键色（清掉旧单键字段避免双真源）。 */
export function writeMattingKeyColorsToOptions(
  options: Record<string, unknown>,
  colors: RgbTuple[]
): Record<string, unknown> {
  const rest = { ...options };
  delete rest[KEY_COLOR_STORAGE_KEY];
  rest[KEY_COLORS_STORAGE_KEY] = stringifyMattingKeyColors(colors);
  return rest;
}

