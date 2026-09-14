/**
 * 测试专用最小 PNG 解码（批次15 回归 fixture 用）：8/16-bit 非隔行，colorType 0/2/4/6，
 * filter 0-4。输入为 base64（内嵌于 mattingFixtureData.ts），解压用全局
 * DecompressionStream('deflate')（PNG IDAT 即 zlib 流），不依赖 node API，可过 tsc。
 * 与 scripts/matting-harness.mjs 的编码端配套（fixture 由 harness --dump-fixture 生成）。
 * 仅测试环境使用，不进前端 bundle。
 */

export interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

interface ReadableLike {
  readonly readable: ReadableStream;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  const ctor = (globalThis as unknown as {
    DecompressionStream?: new (format: string) => ReadableLike;
  }).DecompressionStream;
  if (!ctor) {
    throw new Error('环境缺少 DecompressionStream，无法解码 fixture');
  }
  const source = new Blob([data.buffer as ArrayBuffer]).stream() as unknown as {
    pipeThrough: (transform: unknown) => ReadableStream;
  };
  const stream = source.pipeThrough(new ctor('deflate'));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

/** 解码内嵌 base64 PNG → RGBA。 */
export async function decodePngBase64(base64: string): Promise<DecodedPng> {
  const buffer = base64ToBytes(base64);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== signature[i]) {
      throw new Error('fixture 不是 PNG（签名不符）');
    }
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = -1;
  const idatParts: Uint8Array[] = [];
  while (pos + 8 <= buffer.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(buffer[pos + 4], buffer[pos + 5], buffer[pos + 6], buffer[pos + 7]);
    const dataStart = pos + 8;
    const data = buffer.subarray(dataStart, dataStart + length);
    if (type === 'IHDR') {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 && bitDepth !== 16) throw new Error(`不支持的位深 ${bitDepth}`);
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + length;
  }

  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);

  const idatLength = idatParts.reduce((sum, part) => sum + part.length, 0);
  const idat = new Uint8Array(idatLength);
  let idatOffset = 0;
  for (const part of idatParts) {
    idat.set(part, idatOffset);
    idatOffset += part.length;
  }
  const raw = await inflateZlib(idat);

  const bytesPerSample = bitDepth / 8;
  const stride = width * channels * bytesPerSample;
  const pixels = new Uint8Array(height * stride);
  const bpp = channels * bytesPerSample;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outRow = pixels.subarray(y * stride, (y + 1) * stride);
    const prevRow = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= bpp ? outRow[i - bpp] : 0;
      const up = prevRow ? prevRow[i] : 0;
      const upLeft = prevRow && i >= bpp ? prevRow[i - bpp] : 0;
      let value = raw[rowStart + i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) value += paeth(left, up, upLeft);
      outRow[i] = value & 0xff;
    }
  }

  const to8 = bytesPerSample === 1
    ? (offset: number) => pixels[offset]
    : (offset: number) => Math.round(((pixels[offset] << 8) | pixels[offset + 1]) * 255 / 65535);
  const step = bytesPerSample;

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * channels * bytesPerSample;
    const dst = i * 4;
    if (colorType === 6) {
      rgba[dst] = to8(src);
      rgba[dst + 1] = to8(src + step);
      rgba[dst + 2] = to8(src + step * 2);
      rgba[dst + 3] = to8(src + step * 3);
    } else if (colorType === 2) {
      rgba[dst] = to8(src);
      rgba[dst + 1] = to8(src + step);
      rgba[dst + 2] = to8(src + step * 2);
      rgba[dst + 3] = 255;
    } else if (colorType === 4) {
      rgba[dst] = to8(src);
      rgba[dst + 1] = rgba[dst];
      rgba[dst + 2] = rgba[dst];
      rgba[dst + 3] = to8(src + step);
    } else {
      rgba[dst] = to8(src);
      rgba[dst + 1] = rgba[dst];
      rgba[dst + 2] = rgba[dst];
      rgba[dst + 3] = 255;
    }
  }
  return { width, height, rgba };
}
