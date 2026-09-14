#!/usr/bin/env node
/**
 * matting.ts 真实样图闭环验收 harness（批次15，任务书 D 项）。
 * 不入 npm test 主链、不进前端 bundle（scripts/ 不入 src/，check-bundle 只扫 dist）。
 * PNG 编解码为本文件内最小实现（8-bit 非隔行，colorType 0/2/4/6，filter 0-4 + node:zlib），
 * 项目 node_modules 无 pngjs 等传递依赖（已实证）。
 *
 * 用法：
 *   node scripts/matting-harness.mjs <in.png> <out.png> [options]
 * 选项：
 *   --keys auto          边框主色聚类自动取键（sampleBorderKeyColors，默认）
 *   --keys r,g,b|r,g,b   手动键色（| 分隔，1~4 个）
 *   --max N              先盒式降采样到最长边 ≤ N（0=原图，默认 0）
 *   --over RRGGBB        额外输出合成到底色的检查图（目视看杂色/绿晕粉边，如 --over 808080）
 *   --stats              打印边缘带 despill 指标 / 背景 alpha=0 占比（回归测试标定用）
 *   --dump-fixture W out.png  把「降采样后、抠图前」的输入按宽 W 存 PNG（回归测试 fixture 用）
 *
 * Node ≥ 22.6 直接 import 项目内 matting.ts（type stripping，无构建步骤、零新依赖）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const matting = await import(path.join(rootDir, 'src/features/canvas/application/matting.ts'));

// ────────────────────────── 最小 PNG 编解码 ──────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 解码 8-bit 非隔行 PNG（colorType 0/2/4/6）→ { width, height, rgba: Uint8ClampedArray }。 */
export function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    throw new Error('不是 PNG 文件（签名不符）');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = -1;
  const idatParts = [];
  while (pos + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深 ${bitDepth}（仅 8/16-bit）`);
      if (interlace !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const channelsByColorType = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}（仅 0/2/4/6）`);

  // 16-bit 按字节流 unfilter（PNG filter 本就按字节），取样时取高字节
  const bytesPerSample = bitDepth / 8;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels * bytesPerSample;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const row = raw.subarray(rowStart, rowStart + stride);
    const outRow = pixels.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    const bpp = channels * bytesPerSample;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? outRow[i - bpp] : 0;
      const up = prevRow ? prevRow[i] : 0;
      const upLeft = prevRow && i >= bpp ? prevRow[i - bpp] : 0;
      let value = row[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      outRow[i] = value & 0xff;
    }
  }

  const readSample = (buffer, offset) => bytesPerSample === 1
    ? buffer[offset]
    : (buffer[offset] << 8) | buffer[offset + 1];
  const to8 = bytesPerSample === 1
    ? (v) => v
    : (v) => Math.round((v * 255) / 65535);

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * channels * bytesPerSample;
    const dst = i * 4;
    if (colorType === 6) {
      rgba[dst] = to8(readSample(pixels, src));
      rgba[dst + 1] = to8(readSample(pixels, src + bytesPerSample));
      rgba[dst + 2] = to8(readSample(pixels, src + bytesPerSample * 2));
      rgba[dst + 3] = to8(readSample(pixels, src + bytesPerSample * 3));
    } else if (colorType === 2) {
      rgba[dst] = to8(readSample(pixels, src));
      rgba[dst + 1] = to8(readSample(pixels, src + bytesPerSample));
      rgba[dst + 2] = to8(readSample(pixels, src + bytesPerSample * 2));
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      rgba[dst] = to8(readSample(pixels, src));
      rgba[dst + 1] = rgba[dst];
      rgba[dst + 2] = rgba[dst];
      rgba[dst + 3] = to8(readSample(pixels, src + bytesPerSample));
    } else {
      rgba[dst] = to8(readSample(pixels, src));
      rgba[dst + 1] = rgba[dst];
      rgba[dst + 2] = rgba[dst];
      rgba[dst + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** 编码 8-bit RGBA PNG（filter 0 + deflate）。 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ────────────────────────── 工具函数 ──────────────────────────

/** 盒式降采样（面积平均，含 alpha）。 */
function downsample(rgba, width, height, targetWidth, targetHeight) {
  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  for (let ty = 0; ty < targetHeight; ty += 1) {
    const y0 = Math.floor((ty * height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / targetHeight));
    for (let tx = 0; tx < targetWidth; tx += 1) {
      const x0 = Math.floor((tx * width) / targetWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / targetWidth));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const index = (y * width + x) * 4;
          r += rgba[index];
          g += rgba[index + 1];
          b += rgba[index + 2];
          a += rgba[index + 3];
          n += 1;
        }
      }
      const dst = (ty * targetWidth + tx) * 4;
      out[dst] = r / n;
      out[dst + 1] = g / n;
      out[dst + 2] = b / n;
      out[dst + 3] = a / n;
    }
  }
  return out;
}

function compositeOver(rgba, hex) {
  const back = [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    out[i] = rgba[i] * alpha + back[0] * (1 - alpha);
    out[i + 1] = rgba[i + 1] * alpha + back[1] * (1 - alpha);
    out[i + 2] = rgba[i + 2] * alpha + back[2] * (1 - alpha);
    out[i + 3] = 255;
  }
  return out;
}

function parseManualKeys(text) {
  const parsed = matting.parseMattingKeyColors(text);
  if (!parsed || parsed.length === 0) {
    throw new Error(`无法解析键色: ${text}`);
  }
  return parsed;
}

// ────────────────────────── 主流程 ──────────────────────────

function main() {
  const args = process.argv.slice(2);
  const [inputPath, outputPath] = args.filter((a) => !a.startsWith('--'));
  if (!inputPath || !outputPath) {
    console.error('用法: node scripts/matting-harness.mjs <in.png> <out.png> [--keys auto|r,g,b|...] [--max N] [--over RRGGBB] [--stats] [--dump-fixture W out.png]');
    process.exit(2);
  }

  const getOption = (name) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const maxDim = Number(getOption('max') ?? 0);
  const overHex = getOption('over');
  const wantStats = args.includes('--stats');
  const keysArg = getOption('keys') ?? 'auto';
  const fixtureWidth = getOption('dump-fixture') !== undefined
    ? Number(args[args.indexOf('--dump-fixture') + 1]) : undefined;
  const fixturePath = getOption('dump-fixture') !== undefined
    ? args[args.indexOf('--dump-fixture') + 2] : undefined;

  const image = decodePng(fs.readFileSync(inputPath));
  console.log(`输入: ${inputPath} ${image.width}x${image.height}`);

  let data = image.rgba;
  let { width, height } = image;
  if (maxDim > 0 && Math.max(width, height) > maxDim) {
    const ratio = maxDim / Math.max(width, height);
    const targetWidth = Math.max(1, Math.round(width * ratio));
    const targetHeight = Math.max(1, Math.round(height * ratio));
    data = downsample(data, width, height, targetWidth, targetHeight);
    width = targetWidth;
    height = targetHeight;
    console.log(`降采样 → ${width}x${height}`);
  }

  if (fixturePath) {
    const fw = fixtureWidth > 0 ? Math.min(width, fixtureWidth) : width;
    const fh = Math.max(1, Math.round((height * fw) / width));
    const fixtureData = fw === width ? data : downsample(data, width, height, fw, fh);
    fs.writeFileSync(fixturePath, encodePng(fw, fh, fixtureData));
    console.log(`fixture 已写出: ${fixturePath} (${fw}x${fh})`);
  }

  const keyColors = keysArg === 'auto'
    ? matting.sampleBorderKeyColors(data, width, height)
    : parseManualKeys(keysArg);
  if (keyColors.length === 0) {
    console.error('自动取键失败（边框无有效采样）');
    process.exit(1);
  }
  console.log(`键色(${keyColors.length}): ${matting.stringifyMattingKeyColors(keyColors)}`);
  const pipeline = matting.routeMattingPipeline(keyColors);
  console.log(`管线: ${pipeline}${pipeline === 'green' ? '（批次15 完整：影子识别/despill/自中和）' : '（批次14 / v0.4.1 温和）'}`);

  const started = performance.now();
  const detail = matting.matteSolidBackgroundDetailed(data, width, height, keyColors);
  const elapsed = (performance.now() - started).toFixed(0);
  if (!detail) {
    console.error('matteSolidBackground 返回退化（无种子/图太小）');
    process.exit(1);
  }
  console.log(`matting 耗时 ${elapsed}ms`);

  const pixelCount = width * height;
  let transparent = 0;
  let semi = 0;
  for (let i = 0; i < pixelCount; i += 1) {
    const alpha = detail.data[i * 4 + 3];
    if (alpha === 0) transparent += 1;
    else if (alpha < 255) semi += 1;
  }
  console.log(`alpha=0 占比 ${(transparent / pixelCount).toFixed(3)}；半透明 ${(semi / pixelCount).toFixed(4)}`);

  if (wantStats) {
    // 边缘带（0.35≤α<0.9）输出色到最近种子 ref 的最大色距（despoll 效果指标）
    let maxEdgeDist = 0;
    let maxEdgeAt = -1;
    for (let i = 0; i < pixelCount; i += 1) {
      const alpha = detail.data[i * 4 + 3] / 255;
      if (alpha >= 0.35 && alpha < 0.9) {
        const dr = detail.data[i * 4] - detail.refR[i];
        const dg = detail.data[i * 4 + 1] - detail.refG[i];
        const db = detail.data[i * 4 + 2] - detail.refB[i];
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist > maxEdgeDist) {
          maxEdgeDist = dist;
          maxEdgeAt = i;
        }
      }
    }
    const bgPixels = detail.isBackground.reduce((sum, v) => sum + v, 0);
    let bgCleared = 0;
    for (let i = 0; i < pixelCount; i += 1) {
      if (detail.isBackground[i] === 1 && detail.data[i * 4 + 3] === 0) bgCleared += 1;
    }
    console.log(`边缘带(0.35≤α<0.9) 最大 dist(fore,ref)=${maxEdgeDist.toFixed(1)} @${maxEdgeAt % width},${Math.floor(maxEdgeAt / width)}`);
    console.log(`背景区(容差+影子) ${bgPixels}px，其中 α=0 ${bgCleared}px（占比 ${(bgCleared / Math.max(1, bgPixels)).toFixed(4)}）`);
  }

  fs.writeFileSync(outputPath, encodePng(width, height, detail.data));
  console.log(`输出: ${outputPath}`);
  if (overHex) {
    const overPath = outputPath.replace(/\.png$/i, '') + `-over${overHex}.png`;
    fs.writeFileSync(overPath, encodePng(width, height, compositeOver(detail.data, overHex)));
    console.log(`底色检查图: ${overPath}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
