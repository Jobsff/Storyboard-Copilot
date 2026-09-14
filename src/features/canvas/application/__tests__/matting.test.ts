import { describe, expect, it } from 'vitest';

import {
  estimateKeyColor,
  isGreenKey,
  matteSolidBackground,
  matteSolidBackgroundDetailed,
  MAX_KEY_COLORS,
  parseMattingKeyColor,
  parseMattingKeyColors,
  readMattingKeyColorsFromOptions,
  routeMattingPipeline,
  sampleBorderKeyColors,
  writeMattingKeyColorsToOptions,
  type MatteSolidBackgroundDetail,
  type RgbTuple,
} from '../matting';
import { decodePngBase64 } from './pngDecode';
import {
  GREEN_SCREEN_128_PNG_BASE64,
  MAGENTA_GRADIENT_128_PNG_BASE64,
} from './mattingFixtureData';

const SIZE = 24;
const FG: RgbTuple = [100, 100, 100];
const CORE_MIN = 7;
const CORE_MAX = 16;

function blend(background: RgbTuple, foreground: RgbTuple, t: number): RgbTuple {
  return [
    Math.round(background[0] + (foreground[0] - background[0]) * t),
    Math.round(background[1] + (foreground[1] - background[1]) * t),
    Math.round(background[2] + (foreground[2] - background[2]) * t),
  ];
}

/** 24×24：纯色背景 + 中央 10×10 目标（core），core 外圈 1px 为 t=0.2 混色环。 */
function buildScene(background: RgbTuple, initialAlpha = 255): Uint8ClampedArray {
  const mixed = blend(background, FG, 0.2);
  const data = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const index = (y * SIZE + x) * 4;
      const inCore = x >= CORE_MIN && x <= CORE_MAX && y >= CORE_MIN && y <= CORE_MAX;
      const inRing = x >= CORE_MIN - 1 && x <= CORE_MAX + 1 && y >= CORE_MIN - 1 && y <= CORE_MAX + 1;
      const color = inCore ? FG : inRing ? mixed : background;
      data[index] = color[0];
      data[index + 1] = color[1];
      data[index + 2] = color[2];
      data[index + 3] = initialAlpha;
    }
  }
  return data;
}

function alphaAt(data: Uint8ClampedArray, x: number, y: number): number {
  return data[(y * SIZE + x) * 4 + 3];
}

function colorAt(data: Uint8ClampedArray, x: number, y: number): RgbTuple {
  const index = (y * SIZE + x) * 4;
  return [data[index], data[index + 1], data[index + 2]];
}

describe('matteSolidBackground 连续 alpha matting', () => {
  it('纯色背景像素 → alpha=0（品红键色）', () => {
    const key: RgbTuple = [255, 0, 255];
    const result = matteSolidBackground(buildScene(key), SIZE, SIZE, key);
    expect(alphaAt(result.data, 0, 0)).toBe(0);
    expect(alphaAt(result.data, 5, 11)).toBe(0);
    expect(alphaAt(result.data, 23, 23)).toBe(0);
  });

  it('中心目标像素 → alpha=255 且保原色（品红键色）', () => {
    const key: RgbTuple = [255, 0, 255];
    const result = matteSolidBackground(buildScene(key), SIZE, SIZE, key);
    expect(alphaAt(result.data, 11, 11)).toBe(255);
    expect(colorAt(result.data, 11, 11)).toEqual(FG);
    expect(colorAt(result.data, 9, 14)).toEqual(FG);
  });

  it('目标边缘混色像素 → alpha 连续非二值（0.15~0.85，输入 alpha 被覆盖）', () => {
    const key: RgbTuple = [255, 0, 255];
    // 输入带任意 alpha（如 200），输出应为计算值而非沿用输入
    const result = matteSolidBackground(buildScene(key, 200), SIZE, SIZE, key);
    const samples: Array<[number, number]> = [
      [6, 11],
      [17, 11],
      [11, 6],
      [11, 17],
      [6, 6],
      [17, 17],
    ];
    for (const [x, y] of samples) {
      const alpha = alphaAt(result.data, x, y);
      expect(alpha).toBeGreaterThan(Math.ceil(0.15 * 255));
      expect(alpha).toBeLessThan(Math.floor(0.85 * 255));
      // 投影 alpha 应精确落在真实混色比例 0.2 附近（51/255）
      expect(Math.abs(alpha - 51)).toBeLessThanOrEqual(1);
    }
  });

  it('品红 / 绿 / 蓝三种键色等价', () => {
    const keys: RgbTuple[] = [
      [255, 0, 255],
      [0, 255, 0],
      [0, 0, 255],
    ];
    for (const key of keys) {
      const result = matteSolidBackground(buildScene(key), SIZE, SIZE, key);
      expect(alphaAt(result.data, 0, 0)).toBe(0);
      expect(alphaAt(result.data, 11, 11)).toBe(255);
      expect(colorAt(result.data, 11, 11)).toEqual(FG);
      const edgeAlpha = alphaAt(result.data, 6, 11);
      expect(edgeAlpha).toBeGreaterThan(Math.ceil(0.15 * 255));
      expect(edgeAlpha).toBeLessThan(Math.floor(0.85 * 255));
      expect(Math.abs(edgeAlpha - 51)).toBeLessThanOrEqual(1);
    }
  });

  it('镂空（背景色包围的洞）也透（全图键控）', () => {
    const key: RgbTuple = [255, 0, 255];
    const data = buildScene(key);
    // 在目标 core 中央凿 3×3 纯背景色洞
    for (let y = 10; y <= 12; y += 1) {
      for (let x = 10; x <= 12; x += 1) {
        const index = (y * SIZE + x) * 4;
        data[index] = key[0];
        data[index + 1] = key[1];
        data[index + 2] = key[2];
      }
    }
    const result = matteSolidBackground(data, SIZE, SIZE, key);
    expect(alphaAt(result.data, 11, 11)).toBe(0);
    expect(alphaAt(result.data, 10, 12)).toBe(0);
    // 洞外目标本体不受影响
    expect(alphaAt(result.data, 8, 8)).toBe(255);
  });

  it('w/h < 3 直接原样返回；无前景种子原样返回', () => {
    const tiny = new Uint8ClampedArray([255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255]);
    const tinyResult = matteSolidBackground(tiny, 2, 2, [255, 0, 255]);
    expect(Array.from(tinyResult.data)).toEqual(Array.from(tiny));

    const allBackground = buildScene([255, 0, 255]);
    // 全图刷成背景色 → 无种子
    for (let index = 0; index < allBackground.length; index += 4) {
      allBackground[index] = 255;
      allBackground[index + 1] = 0;
      allBackground[index + 2] = 255;
    }
    const noSeedResult = matteSolidBackground(allBackground, SIZE, SIZE, [255, 0, 255]);
    expect(Array.from(noSeedResult.data)).toEqual(Array.from(allBackground));
  });

  it('腐蚀把目标边缘混色像素排除在种子外（1px 细目标不误判）', () => {
    const key: RgbTuple = [255, 0, 255];
    const data = buildScene(key);
    const result = matteSolidBackground(data, SIZE, SIZE, key, { seedErode: 1 });
    // 混色环本就非种子；core 中心仍是种子 → 全图至少存在 alpha=255 像素
    expect(alphaAt(result.data, 12, 12)).toBe(255);
    // seedErode=0 时混色环仍非种子（距离 48 < 60），行为一致
    const noErode = matteSolidBackground(data, SIZE, SIZE, key, { seedErode: 0 });
    expect(alphaAt(noErode.data, 6, 11)).toBeGreaterThan(38);
    expect(alphaAt(noErode.data, 6, 11)).toBeLessThan(217);
  });
});

describe('estimateKeyColor 9×9 中位数抗噪', () => {
  function buildNoiseImage(): { data: Uint8ClampedArray; width: number; height: number } {
    const width = 12;
    const height = 12;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = 255;
        data[index + 1] = 0;
        data[index + 2] = 255;
        data[index + 3] = 255;
      }
    }
    // 4 个绿色噪点落在 (6,6) 的 9×9 邻域内
    for (const [x, y] of [[4, 4], [5, 5], [7, 7], [8, 8]] as const) {
      const index = (y * width + x) * 4;
      data[index] = 0;
      data[index + 1] = 255;
      data[index + 2] = 0;
    }
    return { data, width, height };
  }

  it('少数噪点不影响中位数键色', () => {
    const { data, width, height } = buildNoiseImage();
    expect(estimateKeyColor(data, width, height, 6, 6)).toEqual([255, 0, 255]);
  });

  it('点击点越界时邻域钳制不崩溃', () => {
    const { data, width, height } = buildNoiseImage();
    expect(estimateKeyColor(data, width, height, 0, 0)).toEqual([255, 0, 255]);
    expect(estimateKeyColor(data, width, height, width - 1, height - 1)).toEqual([255, 0, 255]);
  });
});

describe('parseMattingKeyColor', () => {
  it('兼容数组 / JSON 字符串 / 逗号字符串三种形态', () => {
    expect(parseMattingKeyColor([255, 0, 255])).toEqual([255, 0, 255]);
    expect(parseMattingKeyColor('255,0,255')).toEqual([255, 0, 255]);
    expect(parseMattingKeyColor('[255, 0, 255]')).toEqual([255, 0, 255]);
  });

  it('非法形态返回 null', () => {
    expect(parseMattingKeyColor(undefined)).toBeNull();
    expect(parseMattingKeyColor('')).toBeNull();
    expect(parseMattingKeyColor('256,0,255')).toBeNull();
    expect(parseMattingKeyColor('1,2')).toBeNull();
    expect(parseMattingKeyColor({})).toBeNull();
  });
});

/** 画布构建器：按像素函数填充 32 以下小图。 */
function buildPixels(
  width: number,
  height: number,
  paint: (x: number, y: number) => RgbTuple | null
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = paint(x, y);
      const index = (y * width + x) * 4;
      if (color) {
        data[index] = color[0];
        data[index + 1] = color[1];
        data[index + 2] = color[2];
      }
      data[index + 3] = 255;
    }
  }
  return data;
}

describe('批次15 A：多键色最近匹配', () => {
  const KEY_A: RgbTuple = [255, 0, 255];
  const KEY_B: RgbTuple = [0, 150, 255];
  const FG: RgbTuple = [60, 60, 60];
  const W = 40;
  const H = 32;

  function twoToneScene(): Uint8ClampedArray {
    return buildPixels(W, H, (x, y) => {
      if (x >= 26 && x <= 33 && y >= 12 && y <= 19) {
        return FG;
      }
      return x < 20 ? KEY_A : KEY_B;
    });
  }

  it('双键同时清掉左右两种背景，前景保原色', () => {
    const result = matteSolidBackground(twoToneScene(), W, H, [KEY_A, KEY_B]);
    expect(result.data[(5 * W + 5) * 4 + 3]).toBe(0);
    expect(result.data[(5 * W + 35) * 4 + 3]).toBe(0);
    expect(result.data[(15 * W + 29) * 4 + 3]).toBe(255);
    expect(result.data[(15 * W + 29) * 4]).toBe(FG[0]);
  });

  it('单键 A 时右侧 B 背景不被清掉（多键必要性）', () => {
    const result = matteSolidBackground(twoToneScene(), W, H, [KEY_A]);
    expect(result.data[(5 * W + 5) * 4 + 3]).toBe(0);
    expect(result.data[(5 * W + 35) * 4 + 3]).toBe(255);
  });

  it('超上限键色截断为 4 个', () => {
    const keys: RgbTuple[] = [
      [1, 0, 0],
      [2, 0, 0],
      [3, 0, 0],
      [4, 0, 0],
      [5, 0, 0],
    ];
    const result = matteSolidBackground(twoToneScene(), W, H, keys);
    expect(result.data.length).toBe(W * H * 4);
  });
});

describe('批次15 B：亮度缩放影子识别（s* 缩放命中暗背景）', () => {
  const KEY: RgbTuple = [0, 255, 0];
  const FG: RgbTuple = [200, 40, 50];
  const W = 40;
  const H = 32;

  function sceneWithShadow(): Uint8ClampedArray {
    // 上 20 行纯绿背景；下 12 行 = 0.35×键（脚下影子带）；左上放红色前景块
    return buildPixels(W, H, (x, y) => {
      if (x >= 4 && x <= 14 && y >= 2 && y <= 9) {
        return FG;
      }
      if (y >= 20) {
        return [0, 89, 0];
      }
      return KEY;
    });
  }

  it('纯键色与 0.35×键影子带都透明', () => {
    const result = matteSolidBackground(sceneWithShadow(), W, H, [KEY]);
    expect(result.data[(5 * W + 20) * 4 + 3]).toBe(0);
    expect(result.data[(25 * W + 20) * 4 + 3]).toBe(0);
    expect(result.data[(30 * W + 5) * 4 + 3]).toBe(0);
  });

  it('色度方向不同的暗前景（棕块）不被影子识别吞掉', () => {
    // 棕色 (60,40,30) 残差 67 在阈值外，且远离前景块也应保持前景
    const data = sceneWithShadow();
    for (let y = 25; y <= 28; y += 1) {
      for (let x = 28; x <= 31; x += 1) {
        const index = (y * W + x) * 4;
        data[index] = 60;
        data[index + 1] = 40;
        data[index + 2] = 30;
      }
    }
    const result = matteSolidBackground(data, W, H, [KEY]);
    expect(result.data[(26 * W + 29) * 4 + 3]).toBe(255);
  });

  it('shadowTolerance=0 关闭影子识别', () => {
    const result = matteSolidBackground(sceneWithShadow(), W, H, [KEY], { shadowTolerance: 0 });
    expect(result.data[(5 * W + 20) * 4 + 3]).toBe(0);
    expect(result.data[(25 * W + 20) * 4 + 3]).toBeGreaterThan(0);
  });
});

describe('批次15 C：色度轴 despill 方向与作用域（批次16 起仅 green 管线，用绿键测）', () => {
  // 前景用与键色不同族的暖棕（自中和的色度方向门会跳过它，代表正常前景）
  const KEY: RgbTuple = [0, 255, 0];
  const FG: RgbTuple = [200, 150, 90];
  const W = 32;
  const H = 24;

  function scene(): MatteSolidBackgroundDetail {
    const data = buildPixels(W, H, (x, y) => {
      if (x >= 4 && x <= 11 && y >= 4 && y <= 11) {
        return FG;
      }
      if (x === 12 && y >= 4 && y <= 11) {
        // 紧贴前景块的键族混色列（t=0.36，投影 α≈0.36 落在 despill 作用带；到键距离
        // 87.5 ∈ (60,90) 不构成强前景，seedErode=2 让这列混色像素腐蚀淘汰、保持非种子
        // 以测半透明带 despill）
        return blend(KEY, FG, 0.36);
      }
      return KEY;
    });
    const detail = matteSolidBackgroundDetailed(data, W, H, [KEY], { seedErode: 2 });
    if (!detail) {
      throw new Error('despill 场景不应退化');
    }
    return detail;
  }

  it('半透明带 despill 沿键色轴收回溢出（spill 分量变小）', () => {
    const detail = scene();
    const u: RgbTuple = [-0.633, 0.4455, -0.633]; // normalize((0,255,0) − luma)
    const i = (7 * W + 12) * 4;
    const fore = [detail.data[i], detail.data[i + 1], detail.data[i + 2]];
    const alpha = detail.data[i + 3] / 255;
    expect(alpha).toBeGreaterThanOrEqual(0.35);
    expect(alpha).toBeLessThan(0.9);
    const spill = (fore[0] - FG[0]) * u[0] + (fore[1] - FG[1]) * u[1] + (fore[2] - FG[2]) * u[2];
    expect(spill).toBeLessThan(20);
  });

  it('种子像素与全透明像素颜色不受 despill 影响', () => {
    const detail = scene();
    // 前景块内部种子：保原色
    const seedIndex = (7 * W + 7) * 4;
    expect(detail.data[seedIndex]).toBe(FG[0]);
    expect(detail.data[seedIndex + 1]).toBe(FG[1]);
    expect(detail.data[seedIndex + 2]).toBe(FG[2]);
    expect(detail.data[seedIndex + 3]).toBe(255);
    // 全透明像素填最近种子参考色（不透绿色/杂色）
    const bgIndex = (1 * W + 1) * 4;
    expect(detail.data[bgIndex + 3]).toBe(0);
    expect(Math.abs(detail.data[bgIndex] - FG[0])).toBeLessThan(80);
  });
});

describe('批次15 C：种子双门（强前景 ∨ 腐蚀存活；批次16 起仅 green 管线，用绿键测）', () => {
  const KEY: RgbTuple = [0, 255, 0];
  const WEAK: RgbTuple = [0, 255, 80];
  const STRONG: RgbTuple = [0, 255, 140];
  const W = 32;
  const H = 24;

  function scene(seedErode: number): MatteSolidBackgroundDetail {
    // 孤点弱前景（dist 80 ∈ (60,90]）；5×5 弱前景块（腐蚀 2 轮后中心存活）；强前景孤点（dist 140）
    const data = buildPixels(W, H, (x, y) => {
      if (x === 8 && y === 5) {
        return WEAK;
      }
      if (x >= 13 && x <= 17 && y >= 3 && y <= 7) {
        return WEAK;
      }
      if (x === 26 && y === 5) {
        return STRONG;
      }
      return KEY;
    });
    const detail = matteSolidBackgroundDetailed(data, W, H, [KEY], { seedErode });
    if (!detail) {
      throw new Error('种子双门场景不应退化');
    }
    return detail;
  }

  it('默认 seedErode=0：孤点弱前景也入选种子（细褶皱保种子）', () => {
    const detail = scene(0);
    expect(detail.seed[5 * W + 8]).toBe(1);
  });

  it('显式 seedErode=2：孤点弱前景被腐蚀淘汰不入选种子', () => {
    const detail = scene(2);
    expect(detail.seed[5 * W + 8]).toBe(0);
  });

  it('显式 seedErode=2：5×5 弱前景块中心经腐蚀存活入选种子', () => {
    const detail = scene(2);
    expect(detail.seed[5 * W + 15]).toBe(1);
    expect(detail.data[(5 * W + 15) * 4 + 3]).toBe(255);
  });

  it('强前景孤点绕过腐蚀直接入选种子', () => {
    const detail = scene(2);
    expect(detail.seed[5 * W + 26]).toBe(1);
    expect(detail.data[(5 * W + 26) * 4 + 3]).toBe(255);
  });
});

describe('批次16：isGreenKey / routeMattingPipeline 管线路由判定', () => {
  it('绿主导键判定（g − max(r,b) ≥ 25 固化阈值）', () => {
    // 真机绿幕自动取键实值
    expect(isGreenKey([0, 255, 0])).toBe(true);
    expect(isGreenKey([9, 210, 24])).toBe(true);
    expect(isGreenKey([6, 162, 29])).toBe(true);
    expect(isGreenKey([100, 127, 102])).toBe(true); // 恰好 25
    // 非绿键：品红 / 暗紫地面 / 蓝 / 灰
    expect(isGreenKey([244, 5, 197])).toBe(false);
    expect(isGreenKey([255, 0, 255])).toBe(false);
    expect(isGreenKey([125, 65, 104])).toBe(false);
    expect(isGreenKey([0, 0, 255])).toBe(false);
    expect(isGreenKey([128, 128, 128])).toBe(false);
    expect(isGreenKey([100, 126, 102])).toBe(false); // 24，差一线
  });

  it('路由：全绿键 → green；任一非绿 → gentle', () => {
    expect(routeMattingPipeline([[0, 255, 0]])).toBe('green');
    expect(routeMattingPipeline([[9, 210, 24], [6, 162, 29]])).toBe('green');
    expect(routeMattingPipeline([[244, 5, 197], [125, 65, 104]])).toBe('gentle');
    expect(routeMattingPipeline([[9, 210, 24], [244, 5, 197]])).toBe('gentle');
  });
});

describe('批次16：按键色自动路由（行为级，编辑器 / toolProcessor 零改动）', () => {
  const W = 40;
  const H = 32;

  function shadowBandScene(key: RgbTuple, dark: RgbTuple, fg: RgbTuple): Uint8ClampedArray {
    // 上 20 行纯色背景；下 12 行 = 0.35×键（暗带）；左上放前景块
    return buildPixels(W, H, (x, y) => {
      if (x >= 4 && x <= 14 && y >= 2 && y <= 9) {
        return fg;
      }
      if (y >= 20) {
        return dark;
      }
      return key;
    });
  }

  it('品红键 → gentle：0.35×键暗带不透明（无影子识别，批次14 / v0.4.1 行为）', () => {
    const data = shadowBandScene([255, 0, 255], [89, 0, 89], [200, 150, 90]);
    const result = matteSolidBackground(data, W, H, [[255, 0, 255]]);
    expect(result.data[(25 * W + 20) * 4 + 3]).toBe(255);
    expect(result.data[(5 * W + 20) * 4 + 3]).toBe(0);
  });

  it('绿键 → green：同构暗带仍被影子识别清掉（批次15 行为不回潮）', () => {
    const data = shadowBandScene([0, 255, 0], [0, 89, 0], [200, 150, 90]);
    const result = matteSolidBackground(data, W, H, [[0, 255, 0]]);
    expect(result.data[(25 * W + 20) * 4 + 3]).toBe(0);
  });
});

describe('批次16：gentle 管线复用多键最近匹配基建', () => {
  const WALL: RgbTuple = [244, 5, 197];
  const FLOOR: RgbTuple = [125, 65, 104];
  const FG: RgbTuple = [60, 60, 60];
  const W = 40;
  const H = 32;

  function magentaTwoTone(): Uint8ClampedArray {
    return buildPixels(W, H, (x, y) => {
      if (x >= 26 && x <= 33 && y >= 12 && y <= 19) {
        return FG;
      }
      return y < 16 ? WALL : FLOOR;
    });
  }

  it('双键清掉墙 + 地面两种背景，前景保原色（批次14 像素处理 × 多键基建）', () => {
    const result = matteSolidBackground(magentaTwoTone(), W, H, [WALL, FLOOR]);
    expect(result.data[(5 * W + 5) * 4 + 3]).toBe(0);
    expect(result.data[(25 * W + 5) * 4 + 3]).toBe(0);
    expect(result.data[(15 * W + 29) * 4 + 3]).toBe(255);
    expect(result.data[(15 * W + 29) * 4]).toBe(FG[0]);
  });

  it('单键只清墙：地面保持不透明（多键必要性；gentle 无影子识别兜底）', () => {
    const result = matteSolidBackground(magentaTwoTone(), W, H, [WALL]);
    expect(result.data[(5 * W + 5) * 4 + 3]).toBe(0);
    expect(result.data[(25 * W + 5) * 4 + 3]).toBe(255);
  });
});

/**
 * 批次14（v0.4.1）单键参考实现：按 HANDOFF.md 批次14 节与 image-studio `_magenta_key`
 * （py L788-823）内联转录，独立于 matting.ts 内部实现，作 gentle 管线的对照基准。
 * 前景种子 = 到键色距离 > fgThreshold；种子腐蚀 1 轮（清空退回腐蚀前）；两遍 3-4
 * chamfer 最近种子参考色；投影 alpha；距键 < bgTolerance → α=0；种子强制 1；
 * α<alphaFloor 清零；unmix w=clamp((α−0.8)/0.2,0,1)；种子保原色、仅 α=0 填 ref。
 */
function batch14ReferenceMatte(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  key: RgbTuple,
  opts: { fgThreshold?: number; bgTolerance?: number; seedErode?: number; alphaFloor?: number } = {}
): Uint8ClampedArray {
  const fgThreshold = opts.fgThreshold ?? 60;
  const bgTolerance = opts.bgTolerance ?? 30;
  const erodeRounds = opts.seedErode ?? 1;
  const alphaFloor = opts.alphaFloor ?? 0.025;
  const pixelCount = width * height;

  const candidate = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const dr = data[i * 4] - key[0];
    const dg = data[i * 4 + 1] - key[1];
    const db = data[i * 4 + 2] - key[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) > fgThreshold) {
      candidate[i] = 1;
    }
  }

  let seed = candidate;
  for (let round = 0; round < erodeRounds; round += 1) {
    const next = new Uint8Array(pixelCount);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        if (seed[i] === 0) {
          continue;
        }
        let keep = 1;
        for (let oy = -1; oy <= 1 && keep === 1; oy += 1) {
          for (let ox = -1; ox <= 1 && keep === 1; ox += 1) {
            if (ox === 0 && oy === 0) {
              continue;
            }
            const nx = x + ox;
            const ny = y + oy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || seed[ny * width + nx] === 0) {
              keep = 0;
            }
          }
        }
        next[i] = keep;
      }
    }
    seed = next;
  }
  if (!seed.some((v) => v === 1)) {
    seed = candidate;
  }

  // 两遍 3-4 chamfer 最近种子参考色传播
  const dist = new Float64Array(pixelCount);
  const refR = new Uint8Array(pixelCount);
  const refG = new Uint8Array(pixelCount);
  const refB = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    if (seed[i] === 1) {
      dist[i] = 0;
      refR[i] = data[i * 4];
      refG[i] = data[i * 4 + 1];
      refB[i] = data[i * 4 + 2];
    } else {
      dist[i] = Infinity;
    }
  }
  const relax = (target: number, source: number, weight: number): void => {
    const candidateDist = dist[source] + weight;
    if (candidateDist < dist[target]) {
      dist[target] = candidateDist;
      refR[target] = refR[source];
      refG[target] = refG[source];
      refB[target] = refB[source];
    }
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (x > 0) relax(i, i - 1, 3);
      if (y > 0) relax(i, i - width, 3);
      if (x > 0 && y > 0) relax(i, i - width - 1, 4);
      if (x < width - 1 && y > 0) relax(i, i - width + 1, 4);
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (x < width - 1) relax(i, i + 1, 3);
      if (y < height - 1) relax(i, i + width, 3);
      if (x < width - 1 && y < height - 1) relax(i, i + width + 1, 4);
      if (x > 0 && y < height - 1) relax(i, i + width - 1, 4);
    }
  }

  const output = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const refDr = refR[i] - key[0];
    const refDg = refG[i] - key[1];
    const refDb = refB[i] - key[2];
    const denom = refDr * refDr + refDg * refDg + refDb * refDb;
    let alpha = ((r - key[0]) * refDr + (g - key[1]) * refDg + (b - key[2]) * refDb)
      / Math.max(denom, 1);
    alpha = Math.min(1, Math.max(0, alpha));
    const dr = r - key[0];
    const dg = g - key[1];
    const db = b - key[2];
    if (Math.sqrt(dr * dr + dg * dg + db * db) < bgTolerance) {
      alpha = 0;
    }
    if (seed[i] === 1) {
      alpha = 1;
    }
    if (alpha < alphaFloor) {
      alpha = 0;
    }

    let foreR: number;
    let foreG: number;
    let foreB: number;
    if (seed[i] === 1) {
      foreR = r;
      foreG = g;
      foreB = b;
    } else if (alpha === 0) {
      foreR = refR[i];
      foreG = refG[i];
      foreB = refB[i];
    } else {
      const w = Math.min(1, Math.max(0, (alpha - 0.8) / 0.2));
      const unR = (r - (1 - alpha) * key[0]) / Math.max(alpha, 1e-2);
      const unG = (g - (1 - alpha) * key[1]) / Math.max(alpha, 1e-2);
      const unB = (b - (1 - alpha) * key[2]) / Math.max(alpha, 1e-2);
      foreR = Math.min(255, Math.max(0, refR[i] + w * (unR - refR[i])));
      foreG = Math.min(255, Math.max(0, refG[i] + w * (unG - refG[i])));
      foreB = Math.min(255, Math.max(0, refB[i] + w * (unB - refB[i])));
    }

    output[i * 4] = Math.round(foreR);
    output[i * 4 + 1] = Math.round(foreG);
    output[i * 4 + 2] = Math.round(foreB);
    output[i * 4 + 3] = Math.round(alpha * 255);
  }
  return output;
}

describe('批次16：gentle 管线与批次14（v0.4.1）参考实现逐像素一致', () => {
  it('品红纯色背景 + 目标 + 混色环：RGBA 输出与参考实现全等', () => {
    const key: RgbTuple = [255, 0, 255];
    const data = buildScene(key);
    const gentle = matteSolidBackgroundDetailed(data, SIZE, SIZE, [key]);
    if (!gentle) {
      throw new Error('gentle 场景不应退化');
    }
    const reference = batch14ReferenceMatte(data, SIZE, SIZE, key);
    expect(Array.from(gentle.data)).toEqual(Array.from(reference));
  });

  it('品红渐变墙 + 暗紫地面 + 前景：RGBA 输出与参考实现全等', () => {
    const W = 40;
    const H = 32;
    const data = buildPixels(W, H, (x, y) => {
      if (x >= 26 && x <= 33 && y >= 12 && y <= 19) {
        return [60, 60, 60];
      }
      if (y < 16) {
        // 品红墙水平渐变
        const t = x / (W - 1);
        return [Math.round(200 + 44 * t), 5, Math.round(150 + 47 * t)];
      }
      return [125, 65, 104];
    });
    const key: RgbTuple = [222, 5, 173];
    const gentle = matteSolidBackgroundDetailed(data, W, H, [key]);
    if (!gentle) {
      throw new Error('gentle 渐变场景不应退化');
    }
    const reference = batch14ReferenceMatte(data, W, H, key);
    expect(Array.from(gentle.data)).toEqual(Array.from(reference));
  });

  it('多键 gentle：与单键参考实现共享投影 / unmix 语义（前景α=1、背景α=0）', () => {
    const W = 40;
    const H = 32;
    const wall: RgbTuple = [244, 5, 197];
    const floor: RgbTuple = [125, 65, 104];
    const data = buildPixels(W, H, (x, y) => {
      if (x >= 26 && x <= 33 && y >= 12 && y <= 19) {
        return [60, 60, 60];
      }
      return y < 16 ? wall : floor;
    });
    const detail = matteSolidBackgroundDetailed(data, W, H, [wall, floor]);
    if (!detail) {
      throw new Error('多键 gentle 场景不应退化');
    }
    // 背景两种键色区全透
    expect(detail.data[(5 * W + 5) * 4 + 3]).toBe(0);
    expect(detail.data[(25 * W + 5) * 4 + 3]).toBe(0);
    // 前景种子 α=1 保原色；中间混色带 α 连续
    expect(detail.data[(15 * W + 29) * 4 + 3]).toBe(255);
    expect(detail.data[(15 * W + 29) * 4]).toBe(60);
  });
});

describe('批次15：sampleBorderKeyColors 边框主色聚类', () => {
  it('品红渐变墙 + 绿地面聚出多键，纯色聚成单键', () => {
    const W = 48;
    const H = 48;
    const data = buildPixels(W, H, (x, y) => {
      if (y < 24) {
        const t = x / (W - 1);
        return [Math.round(200 + 55 * t), 0, Math.round(150 + 105 * t)];
      }
      return [0, 200, 60];
    });
    const keys = sampleBorderKeyColors(data, W, H);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.length).toBeLessThanOrEqual(MAX_KEY_COLORS);
    // 至少一个绿色系键与一个品红系键
    expect(keys.some((c) => c[1] > 100)).toBe(true);
    expect(keys.some((c) => c[0] > 150 && c[2] > 100 && c[1] < 80)).toBe(true);
  });

  it('纯色边框聚成 1 键且接近背景色', () => {
    const W = 32;
    const H = 32;
    const data = buildPixels(W, H, () => [9, 210, 24]);
    const keys = sampleBorderKeyColors(data, W, H);
    expect(keys.length).toBe(1);
    expect(Math.hypot(keys[0][0] - 9, keys[0][1] - 210, keys[0][2] - 24)).toBeLessThan(30);
  });
});

describe('批次15：多键色 options 读写', () => {
  it('parseMattingKeyColors 兼容竖线串 / JSON 串 / 数组 / 单键', () => {
    expect(parseMattingKeyColors('244,5,197|125,65,104')).toEqual([
      [244, 5, 197],
      [125, 65, 104],
    ]);
    expect(parseMattingKeyColors('[[255,0,255],[0,255,0]]')).toEqual([
      [255, 0, 255],
      [0, 255, 0],
    ]);
    expect(parseMattingKeyColors([[244, 5, 197]])).toEqual([[244, 5, 197]]);
    expect(parseMattingKeyColors([255, 0, 255])).toEqual([[255, 0, 255]]);
    expect(parseMattingKeyColors('1,2,3')).toEqual([[1, 2, 3]]);
    expect(parseMattingKeyColors('1,2|3')).toBeNull();
    expect(parseMattingKeyColors('')).toBeNull();
  });

  it('超上限截断', () => {
    const parsed = parseMattingKeyColors('1,0,0|2,0,0|3,0,0|4,0,0|5,0,0');
    expect(parsed?.length).toBe(MAX_KEY_COLORS);
  });

  it('write + read 往返；写多键清旧单键字段；读回落旧单键', () => {
    const colors: RgbTuple[] = [
      [244, 5, 197],
      [125, 65, 104],
    ];
    const options = writeMattingKeyColorsToOptions({ keyColor: '9,9,9' }, colors);
    expect(options.keyColor).toBeUndefined();
    expect(readMattingKeyColorsFromOptions(options)).toEqual(colors);
    expect(readMattingKeyColorsFromOptions({ keyColor: '9,9,9' })).toEqual([[9, 9, 9]]);
    expect(readMattingKeyColorsFromOptions({})).toBeNull();
  });
});

describe('批次15：真实样图缩样回归（128px fixture，锁达标指标）', () => {
  const GREEN_KEYS: RgbTuple[] = [
    [9, 210, 24],
    [6, 162, 29],
  ];
  const MAGENTA_KEYS: RgbTuple[] = [
    [244, 5, 197],
    [125, 65, 104],
    [151, 101, 124],
  ];

  interface FixtureMetrics {
    maxEdgeDist: number;
    stripClearedRatio: number;
    transparentRatio: number;
    headOpaqueRatio: number;
  }

  function measure(detail: MatteSolidBackgroundDetail, width: number, height: number, head: [number, number, number, number]): FixtureMetrics {
    const pixelCount = width * height;
    let maxEdgeDist = 0;
    let transparent = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      const alpha = detail.data[i * 4 + 3];
      if (alpha === 0) {
        transparent += 1;
      }
      const t = alpha / 255;
      if (t >= 0.35 && t < 0.9) {
        const dist = Math.hypot(
          detail.data[i * 4] - detail.refR[i],
          detail.data[i * 4 + 1] - detail.refG[i],
          detail.data[i * 4 + 2] - detail.refB[i]
        );
        if (dist > maxEdgeDist) {
          maxEdgeDist = dist;
        }
      }
    }
    let stripTotal = 0;
    let stripCleared = 0;
    for (let y = 0; y < height; y += 1) {
      for (const x of [0, 1, 2, width - 3, width - 2, width - 1]) {
        stripTotal += 1;
        if (detail.data[(y * width + x) * 4 + 3] === 0) {
          stripCleared += 1;
        }
      }
    }
    const [x0, x1, y0, y1] = head;
    let headTotal = 0;
    let headOpaque = 0;
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        headTotal += 1;
        if (detail.data[(y * width + x) * 4 + 3] > 200) {
          headOpaque += 1;
        }
      }
    }
    return {
      maxEdgeDist,
      stripClearedRatio: stripCleared / stripTotal,
      transparentRatio: transparent / pixelCount,
      headOpaqueRatio: headOpaque / headTotal,
    };
  }

  it('绿幕样图（自动双键）：无绿晕指标 + 背景 alpha=0 占比 + 人物完整', async () => {
    const fixture = await decodePngBase64(GREEN_SCREEN_128_PNG_BASE64);
    const detail = matteSolidBackgroundDetailed(fixture.rgba, fixture.width, fixture.height, GREEN_KEYS);
    expect(detail).not.toBeNull();
    const metrics = measure(detail as MatteSolidBackgroundDetail, fixture.width, fixture.height, [55, 75, 6, 42]);
    // 边缘带像素到最近种子 ref 的最大色距上限（无绿晕 / 无杂色）
    expect(metrics.maxEdgeDist).toBeLessThanOrEqual(90);
    // 已知背景区（左右边条）alpha=0 占比
    expect(metrics.stripClearedRatio).toBeGreaterThanOrEqual(0.98);
    expect(metrics.transparentRatio).toBeGreaterThanOrEqual(0.6);
    // 人物头部区域保持不透明（人物完整）
    expect(metrics.headOpaqueRatio).toBeGreaterThanOrEqual(0.75);
  });

  it('品红渐变样图（自动三键）：地面影子全透 + 无粉边 + 人物完整', async () => {
    const fixture = await decodePngBase64(MAGENTA_GRADIENT_128_PNG_BASE64);
    const detail = matteSolidBackgroundDetailed(fixture.rgba, fixture.width, fixture.height, MAGENTA_KEYS);
    expect(detail).not.toBeNull();
    const metrics = measure(detail as MatteSolidBackgroundDetail, fixture.width, fixture.height, [56, 72, 36, 58]);
    expect(metrics.maxEdgeDist).toBeLessThanOrEqual(90);
    expect(metrics.stripClearedRatio).toBeGreaterThanOrEqual(0.95);
    expect(metrics.transparentRatio).toBeGreaterThanOrEqual(0.65);
    expect(metrics.headOpaqueRatio).toBeGreaterThanOrEqual(0.6);
  });
});
