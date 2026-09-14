import { describe, expect, it } from 'vitest';

import {
  fillMaskHoles,
  generateAutoPoints,
  upsampleMaskBilinear,
  upsampleMaskGuided,
  type AiMattingPoint,
} from '../aiMatting';

/** 构造灰度蒙版助手。 */
function grayFrom(width: number, height: number, paint: (x: number, y: number) => number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = paint(x, y);
    }
  }
  return gray;
}

describe('批次16 客户端增强：fillMaskHoles 孔洞填充', () => {
  it('封闭孔洞（白环中的黑洞）填为前景', () => {
    // 5×5 白环：边界与环为前景，中心 (2,2) 为背景孔洞
    const mask = grayFrom(5, 5, (x, y) => {
      const onRing = x >= 1 && x <= 3 && y >= 1 && y <= 3;
      return onRing ? 255 : 255; // 全前景底，中心挖洞
    });
    mask[2 * 5 + 2] = 0;
    const filled = fillMaskHoles(mask, 5, 5);
    expect(filled[2 * 5 + 2]).toBe(255);
  });

  it('开放凹角（连通边界的凹槽）不填', () => {
    // 5×5：全背景，仅一个前景 U 形；凹槽从上边界连通 → 不算孔洞
    const mask = grayFrom(5, 5, (x, y) => {
      // U 形前景：左右臂 + 底
      const leftArm = x === 1 && y >= 1;
      const rightArm = x === 3 && y >= 1;
      const bottom = y === 3 && x >= 1 && x <= 3;
      return leftArm || rightArm || bottom ? 255 : 0;
    });
    const filled = fillMaskHoles(mask, 5, 5);
    // 凹槽 (2,1)、(2,2) 与上边界连通 → 保持背景
    expect(filled[1 * 5 + 2]).toBe(0);
    expect(filled[2 * 5 + 2]).toBe(0);
    // U 形前景保持
    expect(filled[1 * 5 + 1]).toBe(255);
    expect(filled[3 * 5 + 1]).toBe(255);
  });

  it('全背景返回全背景（无孔洞概念）', () => {
    const mask = new Uint8Array(9);
    const filled = fillMaskHoles(mask, 3, 3);
    expect(Array.from(filled)).toEqual(Array.from(mask));
  });

  it('全前景恒等', () => {
    const mask = new Uint8Array(16).fill(255);
    expect(Array.from(fillMaskHoles(mask, 4, 4))).toEqual(Array.from(mask));
  });
});

describe('批次16 客户端增强：upsampleMaskGuided 引导滤波上采样', () => {
  function buildEdgeCase(): {
    guideRgba: Uint8ClampedArray;
    maskSmall: Uint8Array;
  } {
    const guideW = 128;
    const guideH = 64;
    const guideRgba = new Uint8ClampedArray(guideW * guideH * 4);
    for (let y = 0; y < guideH; y += 1) {
      for (let x = 0; x < guideW; x += 1) {
        const i = (y * guideW + x) * 4;
        const value = x >= 64 ? 255 : 0;
        guideRgba[i] = value;
        guideRgba[i + 1] = value;
        guideRgba[i + 2] = value;
        guideRgba[i + 3] = 255;
      }
    }
    // 32×32 低清蒙版：x ≥ 16 前景，边缘列手动模糊（模拟 256 蒙版放大前的软边）
    const mw = 32;
    const mh = 32;
    const maskSmall = new Uint8Array(mw * mh);
    for (let y = 0; y < mh; y += 1) {
      for (let x = 0; x < mw; x += 1) {
        maskSmall[y * mw + x] = x >= 16 ? 255 : 0;
      }
      maskSmall[y * mw + 15] = 128;
    }
    return { guideRgba, maskSmall };
  }

  it('边缘过渡带窄于双线性，且 50% 交叉点对齐引导边缘', () => {
    const { guideRgba, maskSmall } = buildEdgeCase();
    const gw = 128;
    const gh = 64;
    const guided = upsampleMaskGuided(maskSmall, 32, 32, guideRgba, gw, gh, 4, 1e-3);
    const bilinear = upsampleMaskBilinear(maskSmall, 32, 32, gw, gh);
    const row = 32;
    const guidedRow = guided.slice(row * gw, (row + 1) * gw);
    const bilinearRow = bilinear.slice(row * gw, (row + 1) * gw);
    // 理想二值边缘（x≥64 前景）的两个本质指标：边缘位置对齐 + 过渡陡度
    const crossPoint = (rowValues: Uint8Array) => {
      for (let x = 0; x < rowValues.length; x += 1) {
        if (rowValues[x] >= 128) {
          return x;
        }
      }
      return -1;
    };
    const maxStep = (rowValues: Uint8Array) => {
      let step = 0;
      for (let x = 1; x < rowValues.length; x += 1) {
        step = Math.max(step, Math.abs(rowValues[x] - rowValues[x - 1]));
      }
      return step;
    };
    // 边缘位置对齐：引导滤波交叉点钉在引导边缘 x=64，双线性偏左 2px
    expect(Math.abs(crossPoint(guidedRow) - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs(crossPoint(bilinearRow) - 64)).toBeGreaterThanOrEqual(2);
    // 过渡陡度：guided 单步跃变显著大于双线性
    expect(maxStep(guidedRow)).toBeGreaterThan(maxStep(bilinearRow));
  });

  it('无结构（纯色引导）时输出近似输入（退化为平滑）', () => {
    const guideW = 64;
    const guideH = 64;
    const guideRgba = new Uint8ClampedArray(guideW * guideH * 4).fill(255);
    guideRgba[3] = 255;
    const maskSmall = new Uint8Array(16 * 16).fill(220);
    const out = upsampleMaskGuided(maskSmall, 16, 16, guideRgba, guideW, guideH, 4, 1e-3);
    let sum = 0;
    for (let i = 0; i < out.length; i += 1) sum += out[i];
    const mean = sum / out.length;
    // 输入 220 经滤波后仍应接近（无结构域 guided 退化为均值平滑）
    expect(Math.abs(mean - 220)).toBeLessThan(30);
  });

  it('超大图自动工作降采样不崩且尺寸正确（512×512 guide，0 工作缩放内）', () => {
    const gw = 512;
    const gh = 512;
    const guideRgba = new Uint8ClampedArray(gw * gh * 4);
    for (let y = 0; y < gh; y += 1) {
      for (let x = 0; x < gw; x += 1) {
        const i = (y * gw + x) * 4;
        const value = ((x >> 4) + (y >> 4)) % 2 === 0 ? 255 : 30;
        guideRgba[i] = value;
        guideRgba[i + 1] = value;
        guideRgba[i + 2] = value;
        guideRgba[i + 3] = 255;
      }
    }
    const maskSmall = new Uint8Array(64 * 64).fill(180);
    const out = upsampleMaskGuided(maskSmall, 64, 64, guideRgba, gw, gh, 8, 1e-3);
    expect(out.length).toBe(gw * gh);
  });
});

describe('批次16 客户端增强：generateAutoPoints 自动布点', () => {
  it('无既有正点时布 5 点（中心 + 3×2 偏内 4 点），label 全为 1', () => {
    const added = generateAutoPoints(1000, 1000, []);
    expect(added.length).toBe(5);
    expect(added.every((p) => p.label === 1)).toBe(true);
    const center = added.find((p) => p.x === 500 && p.y === 500);
    expect(center).toBeDefined();
  });

  it('与既有正点距离过近的候选跳过（去重）', () => {
    const existing: AiMattingPoint[] = [{ x: 500, y: 500, label: 1 }];
    const added = generateAutoPoints(1000, 1000, existing);
    // 中心被去重跳过
    expect(added.some((p) => Math.hypot(p.x - 500, p.y - 500) < 60)).toBe(false);
    expect(added.length).toBeGreaterThan(0);
  });

  it('全部候选被既有点覆盖时返回空数组', () => {
    const existing: AiMattingPoint[] = [
      { x: 500, y: 500, label: 1 },
      { x: 250, y: 250, label: 1 },
      { x: 750, y: 250, label: 1 },
      { x: 250, y: 750, label: 1 },
      { x: 750, y: 750, label: 1 },
    ];
    expect(generateAutoPoints(1000, 1000, existing)).toEqual([]);
  });

  it('坐标钳制在图内', () => {
    const added = generateAutoPoints(40, 40, []);
    for (const p of added) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(39);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(39);
    }
  });
});
