import { describe, expect, it } from 'vitest';

import {
  applyNegativeClears,
  appendPoint,
  clearPoints,
  decodeMaskWithRecovery,
  featherMask,
  maskForegroundRatio,
  negativeClearRadius,
  pickEffectiveModel,
  pointsToTriples,
  removePointAt,
  resolveAvailableModels,
  resolveSamUploadSize,
  rgbaToGrayLuminance,
  upsampleMaskBilinear,
  type AiMattingPoint,
} from '../aiMatting';
import { SamServiceError } from '../../../../commands/sam';

describe('批次16：点列表管理', () => {
  it('append 追加正/负点，removePointAt 按 index 删除，clear 清空', () => {
    let points: AiMattingPoint[] = clearPoints();
    points = appendPoint(points, { x: 512.4, y: 550.6, label: 1 });
    points = appendPoint(points, { x: 100, y: 900, label: 0 });
    expect(points).toEqual([
      { x: 512.4, y: 550.6, label: 1 },
      { x: 100, y: 900, label: 0 },
    ]);
    points = removePointAt(points, 0);
    expect(points).toEqual([{ x: 100, y: 900, label: 0 }]);
    points = removePointAt(points, 5);
    expect(points).toHaveLength(1);
    points = clearPoints();
    expect(points).toEqual([]);
  });

  it('pointsToTriples 四舍五入坐标并保留 label', () => {
    expect(
      pointsToTriples([
        { x: 512.4, y: 550.6, label: 1 },
        { x: 100.2, y: 900.8, label: 0 },
      ])
    ).toEqual([
      [512, 551, 1],
      [100, 901, 0],
    ]);
  });
});

describe('批次16：decode 404 自动恢复（重 embed + 重放全部历史点）', () => {
  it('正常路径：直接 decode，不触发重 embed', async () => {
    let embedCalls = 0;
    let receivedPoints: AiMattingPoint[] = [];
    const result = await decodeMaskWithRecovery({
      points: [
        { x: 1, y: 2, label: 1 },
        { x: 3, y: 4, label: 0 },
      ],
      embedId: 'embed-1',
      model: 'vit_t',
      decode: async (embedId, points) => {
        receivedPoints = points;
        expect(embedId).toBe('embed-1');
        return { mask: new Uint8Array([255, 0]), width: 2, height: 1 };
      },
      embed: async () => {
        embedCalls += 1;
        return 'embed-2';
      },
      isEmbedExpired: (error) => error instanceof SamServiceError && error.kind === 'embed_expired',
    });
    expect(result.embedId).toBe('embed-1');
    expect(Array.from(result.mask)).toEqual([255, 0]);
    expect(result.maskWidth).toBe(2);
    expect(result.maskHeight).toBe(1);
    expect(embedCalls).toBe(0);
    expect(receivedPoints).toHaveLength(2);
  });

  it('embed 过期：自动重 embed 并重放全部历史点一次', async () => {
    let decodeCalls = 0;
    const decodeEmbedIds: string[] = [];
    const decodePointsSnapshots: number[] = [];
    const result = await decodeMaskWithRecovery({
      points: [
        { x: 10, y: 20, label: 1 },
        { x: 30, y: 40, label: 0 },
        { x: 50, y: 60, label: 1 },
      ],
      embedId: 'expired-id',
      model: 'vit_t',
      decode: async (embedId, points) => {
        decodeCalls += 1;
        decodeEmbedIds.push(embedId);
        decodePointsSnapshots.push(points.length);
        if (decodeCalls === 1) {
          throw new SamServiceError('embed_expired', 'embed expired');
        }
        return { mask: new Uint8Array([1, 2, 3]), width: 3, height: 1 };
      },
      embed: async () => 'fresh-id',
      isEmbedExpired: (error) => error instanceof SamServiceError && error.kind === 'embed_expired',
    });
    expect(decodeCalls).toBe(2);
    expect(decodeEmbedIds).toEqual(['expired-id', 'fresh-id']);
    // 重放必须带全量历史点
    expect(decodePointsSnapshots).toEqual([3, 3]);
    expect(result.embedId).toBe('fresh-id');
    expect(Array.from(result.mask)).toEqual([1, 2, 3]);
    expect(result.maskWidth).toBe(3);
    expect(result.maskHeight).toBe(1);
  });

  it('蒙版尺寸透传：新服务 1024 蒙版按实际宽高返回（动态尺寸消费）', async () => {
    const result = await decodeMaskWithRecovery({
      points: [{ x: 512, y: 512, label: 1 }],
      embedId: 'embed-1024',
      model: 'vit_l',
      decode: async () => ({
        mask: new Uint8Array(1024 * 1024).fill(255),
        width: 1024,
        height: 1024,
      }),
      embed: async () => 'should-not-embed',
      isEmbedExpired: () => false,
    });
    expect(result.maskWidth).toBe(1024);
    expect(result.maskHeight).toBe(1024);
    expect(result.mask.length).toBe(1024 * 1024);
  });

  it('非 embed 过期错误直接抛出（不盲目重试）', async () => {
    let decodeCalls = 0;
    await expect(
      decodeMaskWithRecovery({
        points: [{ x: 1, y: 1, label: 1 }],
        embedId: 'embed-1',
        model: 'vit_t',
        decode: async () => {
          decodeCalls += 1;
          throw new SamServiceError('service', 'boom');
        },
        embed: async () => 'should-not-embed',
        isEmbedExpired: (error) => error instanceof SamServiceError && error.kind === 'embed_expired',
      })
    ).rejects.toThrow('boom');
    expect(decodeCalls).toBe(1);
  });

  it('重 embed 后仍失败则抛出（只重试一次）', async () => {
    let decodeCalls = 0;
    await expect(
      decodeMaskWithRecovery({
        points: [{ x: 1, y: 1, label: 1 }],
        embedId: 'embed-1',
        model: 'vit_t',
        decode: async () => {
          decodeCalls += 1;
          throw new SamServiceError('embed_expired', 'expired again');
        },
        embed: async () => 'fresh-id',
        isEmbedExpired: (error) => error instanceof SamServiceError && error.kind === 'embed_expired',
      })
    ).rejects.toThrow('expired again');
    expect(decodeCalls).toBe(2);
  });
});

describe('批次16：蒙版双线性放大', () => {
  it('等尺寸放大是恒等变换', () => {
    const src = new Uint8Array([0, 128, 255, 64]);
    expect(upsampleMaskBilinear(src, 2, 2, 2, 2)).toEqual(src);
  });

  it('2×2 → 4×4：角点保持，边中间为双线性均值', () => {
    // [0, 255] / [255, 0]
    const src = new Uint8Array([0, 255, 255, 0]);
    const dst = upsampleMaskBilinear(src, 2, 2, 4, 4);
    // 四角对齐源角点（半像素对齐后中心恰落源像素）
    expect(dst[0]).toBe(0);
    expect(dst[3]).toBe(255);
    expect(dst[12]).toBe(255);
    expect(dst[15]).toBe(0);
    // (0,1) 处 = 上下源插值中点附近：0 与 255 的过渡
    expect(dst[1]).toBeGreaterThan(0);
    expect(dst[1]).toBeLessThan(255);
  });

  it('256 → 1024 尺寸正确且取值范围钳制在 0-255', () => {
    const src = new Uint8Array(256 * 256);
    src.fill(200, 0, 256 * 128);
    const dst = upsampleMaskBilinear(src, 256, 256, 1024, 1024);
    expect(dst.length).toBe(1024 * 1024);
    let min = 255;
    let max = 0;
    for (const value of dst) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    expect(min).toBeGreaterThanOrEqual(0);
    expect(max).toBeLessThanOrEqual(255);
    // 上半填充 200 → 平坦区域中心采样 = 200（双线性保持平坦区）
    expect(dst[1024 * 256]).toBe(200);
  });

  it('非法尺寸返回空数组', () => {
    expect(upsampleMaskBilinear(new Uint8Array(4), 0, 2, 4, 4)).toHaveLength(0);
  });
});

describe('批次16：蒙版羽化与前景占比', () => {
  it('1px 羽化平滑硬边缘（中心保留，拐角变淡）', () => {
    // 4×4：上半 255 下半 0 的硬边
    const mask = new Uint8Array(16);
    for (let x = 0; x < 4; x += 1) {
      mask[x] = 255;
    }
    const feathered = featherMask(mask, 4, 4);
    // 边界越界跳过：角 (0,0) 邻域 4 格均值 = 128；边 (1,0) 邻域 6 格均值 = 128
    expect(feathered[0]).toBe(128);
    expect(feathered[1]).toBe(128);
    // 过渡行 (y=1, x=1) 邻域 9 格（含自身）均值 = 85
    expect(feathered[5]).toBe(85);
    // 纯背景角 (y=3, x=3) 保持 0
    expect(feathered[15]).toBe(0);
  });

  it('前景占比：全黑 0 / 全白 1 / 半白 0.5', () => {
    expect(maskForegroundRatio(new Uint8Array([0, 0, 0]))).toBe(0);
    expect(maskForegroundRatio(new Uint8Array([255, 255, 255]))).toBe(1);
    // 127 不算前景（阈值 > 127）
    expect(maskForegroundRatio(new Uint8Array([255, 255, 127, 0]))).toBe(0.5);
  });
});

describe('服务端升级兼容：蒙版灰度通道解析（luminance）', () => {
  it('灰度蒙版（R=G=B）与旧「取红通道」逐像素等价', () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255,
      128, 128, 128, 255,
      255, 255, 255, 128,
      64, 64, 64, 0,
    ]);
    expect(Array.from(rgbaToGrayLuminance(rgba))).toEqual([0, 128, 255, 64]);
  });

  it('彩色 RGB 蒙版按 0.299R+0.587G+0.114B 取整（RGB/RGBA 载荷更稳）', () => {
    // 纯红 255,0,0 → round(0.299*255) = 76（旧红通道会误读为 255 全前景）
    // 纯绿 0,255,0 → round(0.587*255) = 150；纯蓝 → round(0.114*255) = 29
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
    ]);
    expect(Array.from(rgbaToGrayLuminance(rgba))).toEqual([76, 150, 29]);
  });

  it('空载荷返回空数组', () => {
    expect(rgbaToGrayLuminance(new Uint8ClampedArray(0))).toHaveLength(0);
  });
});

describe('服务端升级兼容：模型档自适应（health.models 驱动）', () => {
  it('models 缺失/为空时兜底 [vit_t]（vit_b 已下线）', () => {
    expect(resolveAvailableModels(undefined)).toEqual(['vit_t']);
    expect(resolveAvailableModels([])).toEqual(['vit_t']);
  });

  it('vit_b（细节 HQ）一律过滤下线；vit_l 等新档自动出现', () => {
    expect(resolveAvailableModels(['vit_t', 'vit_b'])).toEqual(['vit_t']);
    expect(resolveAvailableModels(['vit_t', 'vit_b', 'vit_l'])).toEqual(['vit_t', 'vit_l']);
  });

  it('当前档仍可用则保持；服务端下线当前档时落到可用档首项', () => {
    expect(pickEffectiveModel('vit_t', ['vit_t', 'vit_l'])).toBe('vit_t');
    expect(pickEffectiveModel('vit_l', ['vit_t', 'vit_l'])).toBe('vit_l');
    expect(pickEffectiveModel('vit_b', ['vit_t', 'vit_l'])).toBe('vit_t');
    // 可用列表为空（防御）时保持当前档
    expect(pickEffectiveModel('vit_t', [])).toBe('vit_t');
  });
});

describe('批次16c：负点硬清除（橡皮擦语义，applyNegativeClears）', () => {
  it('negativeClearRadius = 对角线 5%，下限 24px，非法尺寸兜底 24', () => {
    expect(negativeClearRadius(1024, 1024)).toBe(72); // hypot≈1448 → 72
    expect(negativeClearRadius(768, 1376)).toBe(79); // hypot≈1578 → 79
    expect(negativeClearRadius(200, 200)).toBe(24); // 283*0.05≈14 → 下限
    expect(negativeClearRadius(0, 100)).toBe(24);
  });

  it('负点 0.7r 内全清、圈外原样、过渡带部分清除', () => {
    const size = 1024;
    const alpha = new Uint8Array(size * size).fill(255);
    const out = applyNegativeClears(alpha, size, size, [{ x: 400, y: 400, label: 0 }]);
    const at = (x: number, y: number) => out[y * size + x];
    expect(at(400, 400)).toBe(0); // 圆心
    expect(at(400 + 30, 400)).toBe(0); // 0.7r=50.4 内
    expect(at(400 + 100, 400)).toBe(255); // d=100 > r=72 圈外
    const edge = at(400 + 62, 400); // d=62 ∈ (50.4, 72) 过渡带
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
    // 正点不影响
    const onlyPositive = applyNegativeClears(alpha, size, size, [{ x: 400, y: 400, label: 1 }]);
    expect(onlyPositive[400 * size + 400]).toBe(255);
  });

  it('多负点叠加清除（取各圆交集最小），无负点原样副本', () => {
    const size = 400;
    const alpha = new Uint8Array(size * size).fill(200);
    const two = applyNegativeClears(alpha, size, size, [
      { x: 100, y: 100, label: 0 },
      { x: 300, y: 300, label: 0 },
    ]);
    expect(two[100 * size + 100]).toBe(0);
    expect(two[300 * size + 300]).toBe(0);
    expect(two[0]).toBe(200); // 左上角在两圈之外
    const none = applyNegativeClears(alpha, size, size, []);
    expect(Array.from(none)).toEqual(Array.from(alpha));
  });
});

describe('SAM/BiRefNet 上传尺寸（resolveSamUploadSize）', () => {
  it('长边 ≤ 上限：原尺寸不缩放', () => {
    expect(resolveSamUploadSize(768, 1376, 4096)).toEqual({ width: 768, height: 1376 });
    expect(resolveSamUploadSize(4096, 100, 4096)).toEqual({ width: 4096, height: 100 });
  });

  it('长边 > 上限：等比降采样到长边=上限（宽/高图两种朝向）', () => {
    expect(resolveSamUploadSize(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(resolveSamUploadSize(4096, 8192, 4096)).toEqual({ width: 2048, height: 4096 });
  });

  it('非法输入兜底至少 1px 不崩', () => {
    expect(resolveSamUploadSize(0, 100, 4096)).toEqual({ width: 1, height: 100 });
    expect(resolveSamUploadSize(-5, -5, 4096)).toEqual({ width: 1, height: 1 });
  });
});
