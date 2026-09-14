import { invoke } from '@tauri-apps/api/core';

/**
 * SAM 模型档（不再硬卡两项）：运行时以 samHealth().models 为唯一真相源
 * （旧服务返回 ['vit_t','vit_b']，升级后可能含 'vit_l'）。
 * vit_t=整体（快）/ vit_b=细节（HQ）/ vit_l=高召回（大模型）。
 */
export type SamModel = string;

export interface SamHealthInfo {
  ok: boolean;
  service: string;
  version: string;
  device: string;
  /** 服务实际支持的模型档（enabled=true，已知档 vit_t/vit_b/vit_l 优先序）。 */
  models: SamModel[];
  maxUploadMb: number;
  /** BiRefNet 一键去底端点是否可用（v1.1+；旧服务恒 false）。 */
  birefnet: boolean;
  /** decode 蒙版边长（旧服务 256 / v1.1 为 1024）。 */
  maskSize: number;
}

export interface SamEmbedResult {
  embedId: string;
  model: string;
  width: number;
  height: number;
  cached: boolean;
}

export interface SamDecodeResult {
  /** 灰度蒙版 PNG 的 base64（前景=255 背景=0；尺寸随服务端版本 256 或 1024，按 PNG 实际宽高解析）。 */
  maskPngBase64: string;
}

/** SAM 命令错误类别：embed_expired = 需要重新 embed（前端自动重放点）。 */
export type SamServiceErrorKind =
  | 'network'
  | 'http'
  | 'bad_request'
  | 'embed_expired'
  | 'service';

/** 结构化错误（Rust 端 SamCommandError 序列化；网络层兜底为 network）。 */
export class SamServiceError extends Error {
  readonly kind: SamServiceErrorKind;

  constructor(kind: SamServiceErrorKind, message: string) {
    super(message);
    this.name = 'SamServiceError';
    this.kind = kind;
  }
}

function toSamServiceError(error: unknown): SamServiceError {
  if (error instanceof SamServiceError) {
    return error;
  }
  const payload = error as { kind?: unknown; message?: unknown };
  if (payload && typeof payload === 'object' && typeof payload.kind === 'string') {
    const kind = payload.kind as SamServiceErrorKind;
    const message = typeof payload.message === 'string' ? payload.message : String(error);
    return new SamServiceError(kind, message);
  }
  return new SamServiceError(
    'network',
    error instanceof Error ? error.message : String(error)
  );
}

export async function samHealth(baseUrl: string): Promise<SamHealthInfo> {
  try {
    return await invoke<SamHealthInfo>('sam_health', { baseUrl });
  } catch (error) {
    throw toSamServiceError(error);
  }
}

export async function samEmbed(
  baseUrl: string,
  imageBase64: string,
  model: SamModel
): Promise<SamEmbedResult> {
  try {
    return await invoke<SamEmbedResult>('sam_embed', {
      baseUrl,
      imageBase64,
      model,
    });
  } catch (error) {
    throw toSamServiceError(error);
  }
}

/** points = [x, y, label] 三元组（原图像素坐标，label 1=前景 0=背景）。 */
export async function samDecode(
  baseUrl: string,
  embedId: string,
  model: SamModel,
  points: Array<[number, number, number]>
): Promise<SamDecodeResult> {
  try {
    return await invoke<SamDecodeResult>('sam_decode', {
      baseUrl,
      embedId,
      model,
      points,
    });
  } catch (error) {
    throw toSamServiceError(error);
  }
}

/**
 * BiRefNet 全分辨率抠图（预留壳）：multipart file → 全尺寸 RGBA PNG base64 直返。
 * TODO(服务端上线后接线)：Rust 端命令已就绪但未注册进 lib.rs，本封装暂不可调用，
 * 端点上线后：Rust 注册命令 → 工具按钮/编辑器接此封装 → 真机联调。
 */
export async function birefMatting(
  baseUrl: string,
  imageBase64: string
): Promise<string> {
  try {
    return await invoke<string>('biref_matting', { baseUrl, imageBase64 });
  } catch (error) {
    throw toSamServiceError(error);
  }
}
