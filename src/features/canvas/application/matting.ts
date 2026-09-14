/**
 * 纯色背景连续 alpha matting（批次14 基础版 + 批次15 绿幕升级 + 批次16 按键色路由）。
 * 基础算法移植自 image-studio 技能 `_magenta_key`（scripts/image_studio.py L788-833）。
 *
 * 批次16 管线路由（真机 v0.4.2 用户实测驱动：绿幕很好、品红还不如 v0.4.1）：
 *  - 键色组全部为绿主导键（isGreenKey）→ 'green' 管线 = 批次15 完整管线（下 A/B/C，
 *    绿幕真机实证效果好，保留一字不动）；
 *  - 任一键非绿 → 'gentle' 管线 = 批次14（v0.4.1）原始像素处理：seedErode=1、
 *    无种子双门、无 despill、无影子 s* 检测、无自中和、unmix 信任 0.8、仅 α=0 填 ref
 *    ——批次15 为绿幕加的去污染/影子/种子门在品红场景过度治疗（品红无绿幕的可见
 *    溢色问题，批次14 的 unmix 本就够）。多键最近匹配属纯基建，两管线共享。
 *
 * 批次15 升级（仅 green 管线；用户真机样图闭环驱动，harness=scripts/matting-harness.mjs）：
 *  A. 多键色（1~4）：逐像素取最近键（欧氏距离）参与背景距离 / 容差清零 / 投影 / 影子检测；
 *  B. 亮度缩放键匹配（Primatte 式影子识别）：P ≈ s·K（s∈[0.15,1.0]）残差 < shadowTolerance
 *     → 判背景（暗紫地面与脚下阴影自动消失）。三重门防误杀（真机样图实证）：
 *     色度方向门（cos≥0.9，暗棕球杆 vs 暗紫地面）、键领地密度门（41² 邻域内该键容差
 *     背景占比 ≥15%，深色头发块附近没有地面）、边界连通门（影子判定须与图边背景
 *     四连通，画面内部落在键轴上的物体被营救）；
 *  C. 边缘去污染：键色色度轴 despill（技能 `_despill` L939-962 的通用化，全额收回到
 *     深度内核参考色电平，逐通道安全缩放），作用域 = 半透明带 0<α<0.9 + 深度内核外的
 *     全部种子（对齐 _despill 的 in_band 含不透明贴边像素；细发丝的腐蚀内核自身可能是
 *     混色像素，必须深内核做 ref 才能洗净绿丝）；unmix 信任曲线 0.5→0.9 渐入；
 *     α<0.35 边缘像素 RGB 直接取最近种子 ref；种子双门（强前景 ∨ 全部候选）。
 * 纯函数 + typed arrays，不依赖 canvas API，可 vitest / node harness。
 */

import {
  MAX_KEY_COLORS,
  routeMattingPipeline,
  type RgbTuple,
} from './mattingKeys.ts';

export interface MatteSolidBackgroundOptions {
  /** 前景种子阈值：像素到最近键欧氏距离 > fgThreshold 进入候选（默认 60）。 */
  fgThreshold?: number;
  /** 距最近键 < bgTolerance 强制 alpha=0（默认 30，对应技能 bg_tolerance）。 */
  bgTolerance?: number;
  /**
   * 种子腐蚀轮数（默认随管线路由：gentle=1（批次14 原始行为）、green=0（全部候选
   * 入选，混色排除由「深度内核种子去污染 + despill」承担；阴影皮肤细褶皱经腐蚀会
   * 整条失去种子 → 投影 α≈0.5 半透明浅带，真机品红图手臂断痕根因））。
   */
  seedErode?: number;
  /** alpha 下限，低于此值清零（默认 0.025，对应技能 alpha_floor）。 */
  alphaFloor?: number;
  /**
   * 亮度缩放影子识别残差阈值：||P−s*·K|| < shadowTolerance 判背景（默认 45；≤0 关闭
   * 影子识别）。仅 green 管线生效（gentle 管线恒为批次14 行为 = 无影子识别）。
   */
  shadowTolerance?: number;
}

/** 3-4 chamfer 权重：正交步 3、对角步 4（≈3×欧氏距离）。 */
const CHAMFER_ORTHOGONAL = 3;
const CHAMFER_DIAGONAL = 4;

/** 亮度缩放 s 允许区间（批次15 B 项）。 */
const SHADOW_SCALE_MIN = 0.15;
const SHADOW_SCALE_MAX = 1;

/** 影子识别的色度方向门：P 的色度方向与键色色度轴夹角余弦低于此值不判背景
 * （暗棕球杆 vs 暗紫地面：残差同在阈值内但色度方向正交，Primatte 二维色度平面的简化）。 */
const CHROMA_COS_MIN = 0.9;
/** 色度向量模长低于此值时方向无意义（近灰暗像素），跳过方向门仅按残差判。 */
const CHROMA_DIR_MIN_MAGNITUDE = 4;
/** 影子识别的键领地密度门（Primatte detail 区域的离散近似）：像素邻域内「该键的容差
 * 背景像素」占比低于此值时不判背景——深色头发块虽落在暗紫地面键的射线上，但那片
 * 区域根本没有地面，只有真正的地面/影子邻域才充满该键的背景像素。 */
const SHADOW_DENSITY_WINDOW = 41;
const SHADOW_DENSITY_MIN_RATIO = 0.15;

/** despill 作用的 alpha 上界（半透明带 0<α<0.9；α≥0.9 非边界种子视为画面内部不动）。 */
const DESPILL_ALPHA_MAX = 0.9;
/** α 低于此值的边缘像素 RGB 直接用最近种子 ref 替代（批次15 C 项，原仅 α=0 填充）。 */
const REF_OVERRIDE_ALPHA = 0.35;
/** 深度内核之外种子去污染的 spill 门限（低于此值视为噪声不动）。 */
const SEED_DESPILL_GATE = 8;
/** 深度内核种子自中和门限（只中和强污染内核；薄褶皱不在内核，肤影安全）。 */
const DEEP_CORE_SELF_GATE = 40;
/** 种子自中和的色度方向门（与键轴夹角过大=色度方向无关的暖前景，不中和）。 */
const SEED_NEEDS_COS_MIN = 0.6;

function medianValue(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp255(value: number): number {
  return Math.min(255, Math.max(0, value));
}

/** 点击点 9×9 邻域 RGB 各通道中位数（越界钳制；抗噪抗渐变边）。 */
export function estimateKeyColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number
): RgbTuple {
  const x0 = Math.max(0, x - 4);
  const x1 = Math.min(width - 1, x + 4);
  const y0 = Math.max(0, y - 4);
  const y1 = Math.min(height - 1, y + 4);
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  for (let py = y0; py <= y1; py += 1) {
    for (let px = x0; px <= x1; px += 1) {
      const index = (py * width + px) * 4;
      reds.push(data[index]);
      greens.push(data[index + 1]);
      blues.push(data[index + 2]);
    }
  }

  return [
    Math.round(medianValue(reds)),
    Math.round(medianValue(greens)),
    Math.round(medianValue(blues)),
  ];
}

interface PreparedKeys {
  colors: RgbTuple[];
  /** dot(K,K)，s* = dot(P,K)/max(dot(K,K),1)。 */
  dotSelf: Float64Array;
  /** 键色色度轴 u = normalize(K − luma(K))，每键 3 分量。 */
  chromaAxis: Float64Array;
  /** 色度轴是否可用（K 接近灰色时 K−luma(K)≈0，despill 跳过）。 */
  chromaAxisOk: Uint8Array;
}

function prepareKeyColors(colors: RgbTuple[]): PreparedKeys {
  const count = colors.length;
  const dotSelf = new Float64Array(count);
  const chromaAxis = new Float64Array(count * 3);
  const chromaAxisOk = new Uint8Array(count);

  for (let k = 0; k < count; k += 1) {
    const [r, g, b] = colors[k];
    dotSelf[k] = r * r + g * g + b * b;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const ur = r - luma;
    const ug = g - luma;
    const ub = b - luma;
    const len = Math.sqrt(ur * ur + ug * ug + ub * ub);
    if (len > 1) {
      chromaAxis[k * 3] = ur / len;
      chromaAxis[k * 3 + 1] = ug / len;
      chromaAxis[k * 3 + 2] = ub / len;
      chromaAxisOk[k] = 1;
    }
  }

  return { colors, dotSelf, chromaAxis, chromaAxisOk };
}

interface PixelClassification {
  /** 每像素最近键索引。 */
  nearest: Uint8Array;
  /** 背景判定：容差命中（无条件）∪ 影子命中且与图边背景连通。 */
  isBackground: Uint8Array;
  /** 种子候选：非背景且到最近键距离 > fgThreshold。 */
  candidate: Uint8Array;
  /** 强前景：非背景且距离 > fgThreshold×1.5（保细线结构）。 */
  strong: Uint8Array;
}

/**
 * 形态学重建（border reconstruction）：mask 中与图边四连通的像素置 1。
 * 栈式 BFS，O(N)。
 */
function borderConnected(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let top = 0;

  const push = (pixelIndex: number): void => {
    if (mask[pixelIndex] === 1 && result[pixelIndex] === 0) {
      result[pixelIndex] = 1;
      stack[top] = pixelIndex;
      top += 1;
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

  while (top > 0) {
    top -= 1;
    const pixelIndex = stack[top];
    const x = pixelIndex % width;
    const y = (pixelIndex - x) / width;
    if (x > 0) push(pixelIndex - 1);
    if (x < width - 1) push(pixelIndex + 1);
    if (y > 0) push(pixelIndex - width);
    if (y < height - 1) push(pixelIndex + width);
  }

  return result;
}

function classifyPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keys: PreparedKeys,
  fgThreshold: number,
  bgTolerance: number,
  shadowTolerance: number
): PixelClassification {
  const pixelCount = width * height;
  const nearest = new Uint8Array(pixelCount);
  const toleranceHit = new Uint8Array(pixelCount);
  const rawCandidate = new Uint8Array(pixelCount);
  const shadowHit = new Uint8Array(pixelCount);
  const keyCount = keys.colors.length;
  const strongDist = fgThreshold * 1.5;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const r = data[dataIndex];
    const g = data[dataIndex + 1];
    const b = data[dataIndex + 2];

    let bestKey = 0;
    let bestDist = Infinity;
    for (let k = 0; k < keyCount; k += 1) {
      const kr = keys.colors[k][0] - r;
      const kg = keys.colors[k][1] - g;
      const kb = keys.colors[k][2] - b;
      const dist = Math.sqrt(kr * kr + kg * kg + kb * kb);
      if (dist < bestDist) {
        bestDist = dist;
        bestKey = k;
      }
    }
    nearest[pixelIndex] = bestKey;

    if (bestDist < bgTolerance) {
      // 容差命中：无条件背景（批次14 语义，镂空/内部同色小物件靠投影 alpha 兜底）
      toleranceHit[pixelIndex] = 1;
    } else if (bestDist > fgThreshold) {
      rawCandidate[pixelIndex] = 1;
    }
  }

  // 影子识别整套机制仅在 shadowTolerance > 0 时参与（gentle 管线传 0 = 批次14 行为，
  // 输出与关闭前逐字节一致，仅省去密度图 / 连通域 / 保护带的无效开销）。
  const reachable = new Uint8Array(pixelCount);
  if (shadowTolerance > 0) {
    // 键领地密度表（积分图）：每键统计「容差背景且最近键为该键」的像素，
    // 供影子识别判断局部是否真的存在该键的背景（Primatte detail 区域的离散近似）。
    const half = SHADOW_DENSITY_WINDOW >> 1;
    const density = buildKeyTerritoryDensity(toleranceHit, nearest, keyCount, width, height);

    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (toleranceHit[pixelIndex] === 1) {
        continue;
      }
      const dataIndex = pixelIndex * 4;
      const r = data[dataIndex];
      const g = data[dataIndex + 1];
      const b = data[dataIndex + 2];
      const bestKey = nearest[pixelIndex];
      const kr = keys.colors[bestKey][0];
      const kg = keys.colors[bestKey][1];
      const kb = keys.colors[bestKey][2];
      // 批次15 B：亮度缩放键匹配（影子识别）。s* = dot(P,K)/dot(K,K) 钳到 [0.15,1]。
      const dotPK = r * kr + g * kg + b * kb;
      const s = Math.min(
        SHADOW_SCALE_MAX,
        Math.max(SHADOW_SCALE_MIN, dotPK / Math.max(keys.dotSelf[bestKey], 1))
      );
      const dr = r - s * kr;
      const dg = g - s * kg;
      const db = b - s * kb;
      if (Math.sqrt(dr * dr + dg * dg + db * db) >= shadowTolerance) {
        continue;
      }
      // 色度方向门：暗色像素会整体塌向 RGB 原点附近，仅凭残差无法区分
      // 「同色相更暗的真背景」与「色度方向不同的暗色前景」，补角度判据。
      if (keys.chromaAxisOk[bestKey] === 1) {
        const pl = 0.299 * r + 0.587 * g + 0.114 * b;
        const pr = r - pl;
        const pg = g - pl;
        const pb = b - pl;
        const mag = Math.sqrt(pr * pr + pg * pg + pb * pb);
        if (mag > CHROMA_DIR_MIN_MAGNITUDE) {
          const cos = (pr * keys.chromaAxis[bestKey * 3]
            + pg * keys.chromaAxis[bestKey * 3 + 1]
            + pb * keys.chromaAxis[bestKey * 3 + 2]) / mag;
          if (cos < CHROMA_COS_MIN) {
            continue;
          }
        }
      }
      // 键领地密度门：邻域内该键的容差背景像素太少说明这片区域根本没有这种背景
      // （深色头发块 vs 远处的暗紫地面），影子判定不生效。按实际窗口面积取占比
      // （图边处窗口被裁剪，固定计数会误伤角落）。
      const x = pixelIndex % width;
      const y = (pixelIndex - x) / width;
      const x0 = Math.max(0, x - half);
      const y0 = Math.max(0, y - half);
      const x1 = Math.min(width - 1, x + half);
      const y1 = Math.min(height - 1, y + half);
      const count = density[bestKey].rectCount(x0, y0, x1, y1);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (count < SHADOW_DENSITY_MIN_RATIO * area) {
        continue;
      }
      shadowHit[pixelIndex] = 1;
    }

    // 批次15 B 空间门：影子判定必须与图边背景四连通才生效（洪泛走「容差∪影子」联合掩膜，
    // 纯背景区多为容差命中，影子区要借道它们抵达图边），防止画面内部落在键轴射线上的
    // 物体（深色衣裙 vs 暗紫地面）被成片误杀。
    const traversal = new Uint8Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      traversal[pixelIndex] = toleranceHit[pixelIndex] | shadowHit[pixelIndex];
    }
    reachable.set(borderConnected(traversal, width, height));

    // 前景保护带（1px）：抗锯齿混色像素天然近似落在键轴射线上（前景靠灰时），
    // 不能被影子识别当成「更暗的背景」清掉。保护源 = 未被判背景的前景候选
    // （自身中影子的候选不得作为保护源，否则整片影子自我保护）。
    const protectSource = new Uint8Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (rawCandidate[pixelIndex] === 1 && shadowHit[pixelIndex] === 0) {
        protectSource[pixelIndex] = 1;
      }
    }
    const protectedFromShadow = dilateMask(protectSource, width, height, 1);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (shadowHit[pixelIndex] === 1 && protectedFromShadow[pixelIndex] === 1) {
        shadowHit[pixelIndex] = 0;
      }
    }
  }

  const isBackground = new Uint8Array(pixelCount);
  const candidate = new Uint8Array(pixelCount);
  const strong = new Uint8Array(pixelCount);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (toleranceHit[pixelIndex] === 1
      || (shadowHit[pixelIndex] === 1 && reachable[pixelIndex] === 1)) {
      isBackground[pixelIndex] = 1;
      continue;
    }
    const dist = nearestKeyDistance(data, pixelIndex, keys.colors[nearest[pixelIndex]]);
    if (dist > fgThreshold) {
      candidate[pixelIndex] = 1;
      if (dist > strongDist) {
        strong[pixelIndex] = 1;
      }
    }
  }

  return { nearest, isBackground, candidate, strong };
}

function nearestKeyDistance(
  data: Uint8ClampedArray,
  pixelIndex: number,
  key: RgbTuple
): number {
  const dataIndex = pixelIndex * 4;
  const dr = data[dataIndex] - key[0];
  const dg = data[dataIndex + 1] - key[1];
  const db = data[dataIndex + 2] - key[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** 3×3 全邻域腐蚀，越界邻域按非种子处理（对齐 scipy border_value=0）。 */
function erodeSeedMask(
  seed: Uint8Array,
  width: number,
  height: number,
  rounds: number
): Uint8Array {
  let current = seed;

  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        if (current[pixelIndex] === 0) {
          continue;
        }

        let keep = 1;
        for (let offsetY = -1; offsetY <= 1 && keep === 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1 && keep === 1; offsetX += 1) {
            if (offsetX === 0 && offsetY === 0) {
              continue;
            }
            const nextX = x + offsetX;
            const nextY = y + offsetY;
            if (
              nextX < 0 || nextX >= width || nextY < 0 || nextY >= height
              || current[nextY * width + nextX] === 0
            ) {
              keep = 0;
            }
          }
        }
        next[pixelIndex] = keep;
      }
    }
    current = next;
  }

  return current;
}

/** 3×3 全邻域膨胀（腐蚀的逆操作），用于前景保护带。 */
function dilateMask(mask: Uint8Array, width: number, height: number, rounds: number): Uint8Array {
  let current = mask;
  for (let round = 0; round < rounds; round += 1) {
    const next = new Uint8Array(current.length);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        if (current[pixelIndex] === 1) {
          next[pixelIndex] = 1;
          continue;
        }
        let hit = 0;
        for (let offsetY = -1; offsetY <= 1 && hit === 0; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1 && hit === 0; offsetX += 1) {
            const nextX = x + offsetX;
            const nextY = y + offsetY;
            if (
              nextX >= 0 && nextX < width && nextY >= 0 && nextY < height
              && current[nextY * width + nextX] === 1
            ) {
              hit = 1;
            }
          }
        }
        next[pixelIndex] = hit;
      }
    }
    current = next;
  }
  return current;
}

/**
 * 两遍 chamfer 传播：每个像素携带最近种子像素的 RGB（近似技能的 EDT-with-indices）。
 * 前向左上→右下、后向右下→左上。
 */
function propagateNearestSeed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: Uint8Array
): { dist: Float64Array; refR: Uint8Array; refG: Uint8Array; refB: Uint8Array } {
  const pixelCount = width * height;
  const dist = new Float64Array(pixelCount);
  const refR = new Uint8Array(pixelCount);
  const refG = new Uint8Array(pixelCount);
  const refB = new Uint8Array(pixelCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (seed[pixelIndex] === 1) {
      const dataIndex = pixelIndex * 4;
      dist[pixelIndex] = 0;
      refR[pixelIndex] = data[dataIndex];
      refG[pixelIndex] = data[dataIndex + 1];
      refB[pixelIndex] = data[dataIndex + 2];
    } else {
      dist[pixelIndex] = Infinity;
    }
  }

  const relax = (target: number, source: number, weight: number): void => {
    const candidate = dist[source] + weight;
    if (candidate < dist[target]) {
      dist[target] = candidate;
      refR[target] = refR[source];
      refG[target] = refG[source];
      refB[target] = refB[source];
    }
  };

  // 前向：左上 → 右下
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      if (x > 0) {
        relax(pixelIndex, pixelIndex - 1, CHAMFER_ORTHOGONAL);
      }
      if (y > 0) {
        relax(pixelIndex, pixelIndex - width, CHAMFER_ORTHOGONAL);
      }
      if (x > 0 && y > 0) {
        relax(pixelIndex, pixelIndex - width - 1, CHAMFER_DIAGONAL);
      }
      if (x < width - 1 && y > 0) {
        relax(pixelIndex, pixelIndex - width + 1, CHAMFER_DIAGONAL);
      }
    }
  }

  // 后向：右下 → 左上
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const pixelIndex = y * width + x;
      if (x < width - 1) {
        relax(pixelIndex, pixelIndex + 1, CHAMFER_ORTHOGONAL);
      }
      if (y < height - 1) {
        relax(pixelIndex, pixelIndex + width, CHAMFER_ORTHOGONAL);
      }
      if (x < width - 1 && y < height - 1) {
        relax(pixelIndex, pixelIndex + width + 1, CHAMFER_DIAGONAL);
      }
      if (x > 0 && y < height - 1) {
        relax(pixelIndex, pixelIndex + width - 1, CHAMFER_DIAGONAL);
      }
    }
  }

  return { dist, refR, refG, refB };
}

function hasAnySeed(seed: Uint8Array): boolean {
  for (let index = 0; index < seed.length; index += 1) {
    if (seed[index] === 1) {
      return true;
    }
  }
  return false;
}

/** 单键容差像素密度的积分图。 */
class DensityMap {
  private readonly sat: Int32Array;
  private readonly width: number;

  constructor(width: number, height: number, mask: Uint8Array) {
    // sat 尺寸 (w+1)*(h+1)，首行首列为 0
    this.width = width;
    this.sat = new Int32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y += 1) {
      let rowSum = 0;
      for (let x = 0; x < width; x += 1) {
        rowSum += mask[y * width + x];
        this.sat[(y + 1) * (width + 1) + (x + 1)] = this.sat[y * (width + 1) + (x + 1)] + rowSum;
      }
    }
  }

  /** [x0,y0]-[x1,y1] 闭区间矩形内命中像素数。 */
  rectCount(x0: number, y0: number, x1: number, y1: number): number {
    const w1 = this.width + 1;
    return this.sat[(y1 + 1) * w1 + (x1 + 1)]
      - this.sat[y0 * w1 + (x1 + 1)]
      - this.sat[(y1 + 1) * w1 + x0]
      + this.sat[y0 * w1 + x0];
  }
}

function buildKeyTerritoryDensity(
  toleranceHit: Uint8Array,
  nearest: Uint8Array,
  keyCount: number,
  width: number,
  height: number
): DensityMap[] {
  const maps: DensityMap[] = [];
  for (let k = 0; k < keyCount; k += 1) {
    const mask = new Uint8Array(toleranceHit.length);
    for (let pixelIndex = 0; pixelIndex < toleranceHit.length; pixelIndex += 1) {
      mask[pixelIndex] = toleranceHit[pixelIndex] === 1 && nearest[pixelIndex] === k ? 1 : 0;
    }
    maps.push(new DensityMap(width, height, mask));
  }
  return maps;
}

/**
 * 沿键色色度轴 despill：spill = dot(P − ref, u)，spill>0 时把像素色度沿键色轴收回。
 * u 为键色色度轴 normalize(K − luma(K))（_despill 的通用化）；结果写入 despillScratch[0..2]。
 * selfNeutralize=false（半透明带 / 种子链式校正）：扣减以参考色色度电平为目标、以像素
 * 自身灰点为界（spill 里混有参考色自身偏暖/偏冷的分量，全额扣减会越过中性点落到补色
 * 一侧，品红溢出扣过头变假绿）。
 * selfNeutralize=true（深度内核种子自中和）：自相对扣到自身灰点（_despill 原义「只扣
 * R/B 超出亮度的溢出」），要求像素色度方向与键轴同族（cos ≥ 0.8，暖肤色与键轴夹角大
 * 不应被去饱和）——ref 链式部分校正会让绿丝代代残留，内核污染源必须一次到位。
 */
const despillScratch = new Uint8ClampedArray(3);

function despillIntoScratch(
  r: number,
  g: number,
  b: number,
  keys: PreparedKeys,
  keyIndex: number,
  refR: number,
  refG: number,
  refB: number,
  spillGate: number,
  selfNeutralize: boolean
): void {
  despillScratch[0] = r;
  despillScratch[1] = g;
  despillScratch[2] = b;
  if (keys.chromaAxisOk[keyIndex] !== 1) {
    return;
  }
  const ax0 = keys.chromaAxis[keyIndex * 3];
  const ax1 = keys.chromaAxis[keyIndex * 3 + 1];
  const ax2 = keys.chromaAxis[keyIndex * 3 + 2];
  const pl = 0.299 * r + 0.587 * g + 0.114 * b;
  const spillSelf = (r - pl) * ax0 + (g - pl) * ax1 + (b - pl) * ax2;
  let effective: number;
  if (selfNeutralize) {
    if (spillSelf <= spillGate) {
      return;
    }
    effective = spillSelf;
  } else {
    const spill = (r - refR) * ax0 + (g - refG) * ax1 + (b - refB) * ax2;
    if (spill <= spillGate) {
      return;
    }
    effective = Math.min(spill, Math.max(spillSelf, 0));
  }
  const c0 = ax0 * effective;
  const c1 = ax1 * effective;
  const c2 = ax2 * effective;
  let scale = 1;
  if (c0 > 0 && c0 * scale > r) scale = r / c0;
  if (c1 > 0 && c1 * scale > g) scale = g / c1;
  if (c2 > 0 && c2 * scale > b) scale = b / c2;
  if (c0 < 0 && c0 * scale < r - 255) scale = (r - 255) / c0;
  if (c1 < 0 && c1 * scale < g - 255) scale = (g - 255) / c1;
  if (c2 < 0 && c2 * scale < b - 255) scale = (b - 255) / c2;
  despillScratch[0] = clamp255(r - c0 * scale);
  despillScratch[1] = clamp255(g - c1 * scale);
  despillScratch[2] = clamp255(b - c2 * scale);
}

export interface MatteSolidBackgroundDetail {
  data: Uint8ClampedArray;
  refR: Uint8Array;
  refG: Uint8Array;
  refB: Uint8Array;
  seed: Uint8Array;
  /** 背景判定像素（容差 ∪ 连通影子识别），回归测试与 harness 统计用。 */
  isBackground: Uint8Array;
  nearest: Uint8Array;
}

/**
 * 投影 alpha（py:816 逐字；green/gentle 两管线共享基建）：
 * clamp(dot(px-bg, ref-bg) / max(|ref-bg|², 1), 0, 1)
 */
function projectedAlpha(
  r: number,
  g: number,
  b: number,
  bgR: number,
  bgG: number,
  bgB: number,
  refR: number,
  refG: number,
  refB: number
): number {
  const refDr = refR - bgR;
  const refDg = refG - bgG;
  const refDb = refB - bgB;
  const denom = refDr * refDr + refDg * refDg + refDb * refDb;
  const alpha = ((r - bgR) * refDr + (g - bgG) * refDg + (b - bgB) * refDb) / Math.max(denom, 1);
  return Math.min(1, Math.max(0, alpha));
}

function normalizeKeyColors(input: RgbTuple | RgbTuple[]): RgbTuple[] {
  // 单键直接传 [r,g,b]（元素是数字）；多键传 [[r,g,b],...]
  const list: unknown[] = Array.isArray(input)
    && input.length === 3
    && input.every((channel) => typeof channel === 'number')
    ? [input]
    : Array.isArray(input) ? input : [input];
  return list
    .filter((color): color is RgbTuple =>
      Array.isArray(color) && color.length === 3
      && color.every((channel) => Number.isFinite(channel)))
    .slice(0, MAX_KEY_COLORS)
    .map((color) => [
      Math.max(0, Math.min(255, Math.round(color[0]))),
      Math.max(0, Math.min(255, Math.round(color[1]))),
      Math.max(0, Math.min(255, Math.round(color[2]))),
    ] as RgbTuple);
}

/**
 * 任意高饱和纯色 / 渐变背景 → 连续 alpha matting（带调试中间量，供回归测试与 harness）。
 * 批次16 按键色组自动路由：全绿键 → green 管线（批次15 完整管线）；任一键非绿 →
 * gentle 管线（批次14 / v0.4.1 温和管线 + 多键最近匹配基建）。调用方零感知。
 * 返回 null 表示退化（w/h<3、无有效键色、无前景种子），调用方应原样保留输入。
 */
export function matteSolidBackgroundDetailed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: RgbTuple | RgbTuple[],
  options: MatteSolidBackgroundOptions = {}
): MatteSolidBackgroundDetail | null {
  const pixelCount = width * height;
  if (width < 3 || height < 3 || data.length < pixelCount * 4) {
    return null;
  }

  const keyColors = normalizeKeyColors(keyColor);
  if (keyColors.length === 0) {
    return null;
  }

  if (routeMattingPipeline(keyColors) === 'gentle') {
    return matteGentlePipelineDetailed(data, width, height, keyColors, options);
  }
  return matteGreenPipelineDetailed(data, width, height, keyColors, options);
}

/**
 * gentle 管线（批次16 恢复批次14 / v0.4.1 原始像素处理；品红等非绿键路由到此）。
 * 与批次14 逐字对齐：seedErode 默认 1（无种子双门 = 无强前景绕过）、无种子去污染 /
 * 自中和、无 despill、无影子 s* 检测（classifyPixels 传 shadowTolerance=0）、
 * unmix 信任曲线 w=clamp((α−0.8)/0.2,0,1)、仅 α=0 像素填 ref。
 * 多键最近匹配基建（nearest / 容差 / 投影 / 种子判定逐像素取最近键）与批次15 共享。
 */
function matteGentlePipelineDetailed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColors: RgbTuple[],
  options: MatteSolidBackgroundOptions
): MatteSolidBackgroundDetail | null {
  const pixelCount = width * height;
  const fgThreshold = options.fgThreshold ?? 60;
  const bgTolerance = options.bgTolerance ?? 30;
  const seedErode = options.seedErode ?? 1;
  const alphaFloor = options.alphaFloor ?? 0.025;

  const keys = prepareKeyColors(keyColors);
  const { nearest, isBackground, candidate } = classifyPixels(
    data, width, height, keys, fgThreshold, bgTolerance, 0
  );

  if (!hasAnySeed(candidate)) {
    // 无任何前景采样（对应技能 ValueError「无可靠前景采样」）：无从估计参考色，原样返回。
    return null;
  }

  // 批次14 种子：腐蚀存活候选（越界按非种子）；腐蚀清空（细线目标）退回腐蚀前候选。
  const eroded = seedErode > 0 ? erodeSeedMask(candidate, width, height, seedErode) : candidate;
  let seed = eroded;
  if (!hasAnySeed(seed)) {
    seed = candidate;
  }

  // 无种子去污染：参考色传播基于原图。
  const workData = new Uint8ClampedArray(data);
  const { refR, refG, refB } = propagateNearestSeed(workData, width, height, seed);

  const output = new Uint8ClampedArray(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const r = workData[dataIndex];
    const g = workData[dataIndex + 1];
    const b = workData[dataIndex + 2];
    const keyIndex = nearest[pixelIndex];
    const bgR = keys.colors[keyIndex][0];
    const bgG = keys.colors[keyIndex][1];
    const bgB = keys.colors[keyIndex][2];

    let alpha = projectedAlpha(
      r, g, b, bgR, bgG, bgB, refR[pixelIndex], refG[pixelIndex], refB[pixelIndex]
    );
    // 容差命中强制透明（shadowTolerance=0 → isBackground 即纯容差判定，批次14 语义）
    if (isBackground[pixelIndex] === 1) {
      alpha = 0;
    }
    if (seed[pixelIndex] === 1) {
      alpha = 1;
    }
    if (alpha < alphaFloor) {
      alpha = 0;
    }

    let foreR: number;
    let foreG: number;
    let foreB: number;
    if (seed[pixelIndex] === 1) {
      // 种子像素保原色
      foreR = r;
      foreG = g;
      foreB = b;
    } else if (alpha === 0) {
      // 透明像素颜色填最近种子参考色（批次14：仅 α=0 填充）
      foreR = refR[pixelIndex];
      foreG = refG[pixelIndex];
      foreB = refB[pixelIndex];
    } else {
      // unmix 去污染（py:821-823 逐字；批次14 信任曲线：α=0.8 起渐入，α=1 全信）
      const w = Math.min(1, Math.max(0, (alpha - 0.8) / 0.2));
      const unR = (r - (1 - alpha) * bgR) / Math.max(alpha, 1e-2);
      const unG = (g - (1 - alpha) * bgG) / Math.max(alpha, 1e-2);
      const unB = (b - (1 - alpha) * bgB) / Math.max(alpha, 1e-2);
      foreR = clamp255(refR[pixelIndex] + w * (unR - refR[pixelIndex]));
      foreG = clamp255(refG[pixelIndex] + w * (unG - refG[pixelIndex]));
      foreB = clamp255(refB[pixelIndex] + w * (unB - refB[pixelIndex]));
    }

    output[dataIndex] = Math.round(foreR);
    output[dataIndex + 1] = Math.round(foreG);
    output[dataIndex + 2] = Math.round(foreB);
    output[dataIndex + 3] = Math.round(alpha * 255);
  }

  return { data: output, refR, refG, refB, seed, isBackground, nearest };
}

/**
 * green 管线（批次15 完整管线，绿幕真机实证达标，逻辑一字不动；全绿键路由到此）。
 */
function matteGreenPipelineDetailed(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColors: RgbTuple[],
  options: MatteSolidBackgroundOptions
): MatteSolidBackgroundDetail | null {
  const pixelCount = width * height;
  // 管线路由（批次16）：绿键 → 批次15 完整管线；非绿键 → 批次14 温和管线
  // （批次15 为绿幕加的去污染/影子/种子门在品红场景过度治疗，真机实证）。
  const pipeline = routeMattingPipeline(keyColors);
  const isGreenPipeline = pipeline === 'green';
  const fgThreshold = options.fgThreshold ?? 60;
  const bgTolerance = options.bgTolerance ?? 30;
  const seedErode = options.seedErode ?? (isGreenPipeline ? 0 : 1);
  const alphaFloor = options.alphaFloor ?? 0.025;
  const shadowTolerance = isGreenPipeline
    ? (options.shadowTolerance ?? 45)
    : 0;

  const keys = prepareKeyColors(keyColors);
  const { nearest, isBackground, candidate, strong } = classifyPixels(
    data, width, height, keys, fgThreshold, bgTolerance, shadowTolerance
  );

  if (!hasAnySeed(candidate)) {
    // 无任何前景采样（对应技能 ValueError「无可靠前景采样」）：无从估计参考色，原样返回。
    return null;
  }

  // 种子双门（批次15 C）：默认全部候选入选；显式 seedErode 时仅腐蚀存活者。
  // 强前景始终入选（保细线结构）。阴影皮肤细褶皱（到键距离刚过阈值 1-2px）经腐蚀会
  // 整条失去种子 → 投影 α≈0.5 半透明浅带（真机品红图手臂断痕根因），故默认不腐蚀；
  // 混色排除由「深度内核种子去污染 + despill」与影子识别各门承担。
  const eroded = seedErode > 0 ? erodeSeedMask(candidate, width, height, seedErode) : candidate;
  let seed = strong;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (eroded[pixelIndex] === 1) {
      seed[pixelIndex] = 1;
    }
  }
  if (!hasAnySeed(seed)) {
    // 腐蚀清空（细线目标等）：退回腐蚀前候选，避免整体无参考。
    seed = candidate;
  }

  // 种子去污染（批次15 C）：自相对 despill 到自身灰点（_despill 原义「只扣 R/B 超出
  // 亮度的溢出」）。中和范围 = 「细结构」的高溢出种子——发丝间绿丝/混色带（腐蚀 3 轮
  // 即消失的薄区域）；厚区域的高溢出种子（大片肤影/环境光渐变，如品红图粉肤影）保留，
  // 仅按局部参考色做限幅收回——色度与亮度无法区分「混入的背景色」与「环境光真实暗部」
  // 时，用结构尺度做最后裁决。
  const workData = new Uint8ClampedArray(data);
  if (isGreenPipeline) {
    const needs = new Uint8Array(pixelCount);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (seed[pixelIndex] === 0) {
        continue;
      }
      const dataIndex = pixelIndex * 4;
      const wr = workData[dataIndex];
      const wg = workData[dataIndex + 1];
      const wb = workData[dataIndex + 2];
      const pl = 0.299 * wr + 0.587 * wg + 0.114 * wb;
      const spillSelf = (wr - pl) * keys.chromaAxis[nearest[pixelIndex] * 3]
        + (wg - pl) * keys.chromaAxis[nearest[pixelIndex] * 3 + 1]
        + (wb - pl) * keys.chromaAxis[nearest[pixelIndex] * 3 + 2];
      if (spillSelf <= DEEP_CORE_SELF_GATE || keys.chromaAxisOk[nearest[pixelIndex]] === 0) {
        continue;
      }
      const pr = wr - pl;
      const pg = wg - pl;
      const pb = wb - pl;
      const mag = Math.sqrt(pr * pr + pg * pg + pb * pb);
      if (mag <= CHROMA_DIR_MIN_MAGNITUDE) {
        continue;
      }
      const cos = (pr * keys.chromaAxis[nearest[pixelIndex] * 3]
        + pg * keys.chromaAxis[nearest[pixelIndex] * 3 + 1]
        + pb * keys.chromaAxis[nearest[pixelIndex] * 3 + 2]) / mag;
      if (cos < SEED_NEEDS_COS_MIN) {
        continue;
      }
      needs[pixelIndex] = 1;
    }
    // 细结构 = needs 中腐蚀 3 轮即消失的部分（膨胀回补近似形态学开运算）
    const thick = dilateMask(erodeSeedMask(needs, width, height, 3), width, height, 3);
    const interior = propagateNearestSeed(workData, width, height, needs);
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
      if (seed[pixelIndex] === 0) {
        continue;
      }
      const dataIndex = pixelIndex * 4;
      const wr = workData[dataIndex];
      const wg = workData[dataIndex + 1];
      const wb = workData[dataIndex + 2];
      if (needs[pixelIndex] === 1 && thick[pixelIndex] === 0) {
        // 细结构高溢出种子：自相对中和到自身灰点，一次到位
        const pl = 0.299 * wr + 0.587 * wg + 0.114 * wb;
        despillIntoScratch(
          wr, wg, wb,
          keys,
          nearest[pixelIndex],
          pl, pl, pl,
          SEED_DESPILL_GATE,
          true
        );
      } else {
        // 其余种子（厚区域肤影/轻污染）：按局部参考色限幅收回
        despillIntoScratch(
          wr, wg, wb,
          keys,
          nearest[pixelIndex],
          interior.refR[pixelIndex],
          interior.refG[pixelIndex],
          interior.refB[pixelIndex],
          SEED_DESPILL_GATE,
          false
        );
      }
      workData[dataIndex] = despillScratch[0];
      workData[dataIndex + 1] = despillScratch[1];
      workData[dataIndex + 2] = despillScratch[2];
    }
  }

  const { refR, refG, refB } = propagateNearestSeed(workData, width, height, seed);

  const output = new Uint8ClampedArray(pixelCount * 4);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const dataIndex = pixelIndex * 4;
    const r = workData[dataIndex];
    const g = workData[dataIndex + 1];
    const b = workData[dataIndex + 2];
    const keyIndex = nearest[pixelIndex];
    const bgR = keys.colors[keyIndex][0];
    const bgG = keys.colors[keyIndex][1];
    const bgB = keys.colors[keyIndex][2];

    // 投影 alpha（py:816 逐字，两管线共享基建）
    let alpha = projectedAlpha(
      r, g, b, bgR, bgG, bgB, refR[pixelIndex], refG[pixelIndex], refB[pixelIndex]
    );
    if (isBackground[pixelIndex] === 1) {
      alpha = 0;
    }
    if (seed[pixelIndex] === 1) {
      alpha = 1;
    }
    if (alpha < alphaFloor) {
      alpha = 0;
    }

    let foreR: number;
    let foreG: number;
    let foreB: number;
    if (seed[pixelIndex] === 1) {
      // 种子像素保（去污染后的）原色
      foreR = r;
      foreG = g;
      foreB = b;
    } else if (alpha < REF_OVERRIDE_ALPHA) {
      // 全透明与低 α 边缘像素颜色一律填最近种子参考色（批次15 C：原仅 α=0 填充）
      foreR = refR[pixelIndex];
      foreG = refG[pixelIndex];
      foreB = refB[pixelIndex];
    } else {
      let workR = r;
      let workG = g;
      let workB = b;
      // 批次15 C：色度轴 despill（_despill 通用化，半透明带 α<0.9；仅 green 管线）。
      if (isGreenPipeline && alpha < DESPILL_ALPHA_MAX) {
        despillIntoScratch(
          workR, workG, workB, keys, keyIndex,
          refR[pixelIndex], refG[pixelIndex], refB[pixelIndex], 0, false
        );
        workR = despillScratch[0];
        workG = despillScratch[1];
        workB = despillScratch[2];
      }
      // unmix 去污染（py:821-823；批次15 C：信任曲线 0.5→0.9 渐入）
      const w = Math.min(1, Math.max(0, (alpha - 0.5) / 0.4));
      const unR = (workR - (1 - alpha) * bgR) / Math.max(alpha, 1e-2);
      const unG = (workG - (1 - alpha) * bgG) / Math.max(alpha, 1e-2);
      const unB = (workB - (1 - alpha) * bgB) / Math.max(alpha, 1e-2);
      foreR = clamp255(refR[pixelIndex] + w * (unR - refR[pixelIndex]));
      foreG = clamp255(refG[pixelIndex] + w * (unG - refG[pixelIndex]));
      foreB = clamp255(refB[pixelIndex] + w * (unB - refB[pixelIndex]));
    }

    output[dataIndex] = Math.round(foreR);
    output[dataIndex + 1] = Math.round(foreG);
    output[dataIndex + 2] = Math.round(foreB);
    output[dataIndex + 3] = Math.round(alpha * 255);
  }

  return { data: output, refR, refG, refB, seed, isBackground, nearest };
}

/**
 * 任意高饱和纯色 / 渐变背景 → 连续 alpha matting（straight alpha 覆盖式输出）。
 * 已有 alpha 的输入按 RGB 原样处理；w/h < 3、无有效键色或无前景种子时原样返回副本。
 */
export function matteSolidBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  keyColor: RgbTuple | RgbTuple[],
  options: MatteSolidBackgroundOptions = {}
): { data: Uint8ClampedArray } {
  const detail = matteSolidBackgroundDetailed(data, width, height, keyColor, options);
  if (detail) {
    return { data: detail.data };
  }
  return { data: new Uint8ClampedArray(data) };
}

// 批次15：键色解析 / 序列化 / 边框取键聚类拆分至 mattingKeys.ts（控制单文件规模），
// 此处统一 re-export，既有 `from '../matting'` 导入路径不受影响。
// （import 带 .ts 扩展名以兼容 node 原生 type-stripping 直跑 harness。）
export {
  MAX_KEY_COLORS,
  GREEN_KEY_DOMINANCE_MIN,
  isGreenKey,
  routeMattingPipeline,
  parseMattingKeyColor,
  parseMattingKeyColors,
  stringifyMattingKeyColor,
  stringifyMattingKeyColors,
  readMattingKeyColorFromOptions,
  readMattingKeyColorsFromOptions,
  writeMattingKeyColorToOptions,
  writeMattingKeyColorsToOptions,
  sampleBorderKeyColors,
  type MattingPipelineKind,
  type SampleBorderKeyColorsOptions,
} from './mattingKeys.ts';
export type { RgbTuple } from './mattingKeys.ts';
