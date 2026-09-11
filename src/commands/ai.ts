import { invoke, isTauri } from '@tauri-apps/api/core';

/**
 * 追加 hop 规格（批次8：NEWAPI 接口 / aifast 入链；Rust ExtraHopSpec 对齐）。
 * model 为完整 id（`{provider}/{model}`），display_name 为端点显示名（链轨迹用）。
 */
export interface ExtraHopSpec {
  provider_id: string;
  model: string;
  display_name: string;
}

/**
 * 自动降级链选项（仅智能出图虚拟模型注入；不带 = 单点直连，行为与历史版本一致）。
 * Rust 侧按 available_providers（有 key 的渠道 id 列表）过滤 build_chain；
 * extra_hops（批次8，可选）：NEWAPI 接口 / aifast 追加档，缺省空 = 行为与 v0.3.0 一致。
 */
export interface GenerateFallbackOptions {
  quality: 'standard' | 'pro';
  available_providers: string[];
  extra_hops?: ExtraHopSpec[];
}

export interface GenerateRequest {
  prompt: string;
  model: string;
  size: string;
  aspect_ratio: string;
  reference_images?: string[];
  extra_params?: Record<string, unknown>;
  fallback?: GenerateFallbackOptions;
}

export interface ReversePromptRequest {
  provider: string;
  image: string;
  language?: string;
  format?: 'text' | 'json';
  model?: string;
}

export type GenerationJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'not_found';

/** 链轨迹条目（Rust ChainAttempt；批次5 generationMeta 数据源）。 */
export interface GenerationAttemptStatus {
  provider_id: string;
  model: string;
  error_class?: string | null;
  error?: string | null;
  /** 端点显示名（批次8，NEWAPI 接口 extra hop 才有；展示优先于 provider_id）。 */
  display_name?: string | null;
}

export interface GenerationJobStatus {
  job_id: string;
  status: GenerationJobState;
  result?: string | null;
  error?: string | null;
  /** 错误分类（timeout/channel_down/auth/quota/content_filter/unknown），批次5 接 UI。 */
  error_class?: string | null;
  /** 实际执行渠道：running=当前 hop，succeeded=实际命中（Rust skip_serializing_if 可缺省）。 */
  provider_id?: string | null;
  model?: string | null;
  /** 链轨迹；单点任务缺省。 */
  attempts?: GenerationAttemptStatus[];
  /** 公司 OSS 归档直链（批次11）；成功且已归档才有（Rust serde rename ossUrl）。 */
  ossUrl?: string | null;
}

const BASE64_PREVIEW_HEAD = 96;
const BASE64_PREVIEW_TAIL = 24;

function truncateText(value: string, max = 200): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...(${value.length} chars)`;
}

function truncateBase64Like(value: string): string {
  if (!value) {
    return value;
  }

  if (value.startsWith('data:')) {
    const [meta, payload = ''] = value.split(',', 2);
    if (payload.length <= BASE64_PREVIEW_HEAD + BASE64_PREVIEW_TAIL) {
      return value;
    }
    return `${meta},${payload.slice(0, BASE64_PREVIEW_HEAD)}...${payload.slice(-BASE64_PREVIEW_TAIL)}(${payload.length} chars)`;
  }

  const base64Like = /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 256;
  if (!base64Like) {
    return truncateText(value, 280);
  }

  return `${value.slice(0, BASE64_PREVIEW_HEAD)}...${value.slice(-BASE64_PREVIEW_TAIL)}(${value.length} chars)`;
}

function sanitizeGenerateRequestForLog(request: GenerateRequest): Record<string, unknown> {
  return {
    prompt: truncateText(request.prompt, 240),
    model: request.model,
    size: request.size,
    aspect_ratio: request.aspect_ratio,
    reference_images_count: request.reference_images?.length ?? 0,
    reference_images_preview: (request.reference_images ?? []).map((item) =>
      truncateBase64Like(item)
    ),
    extra_params: request.extra_params ?? {},
    fallback: request.fallback
      ? {
        quality: request.fallback.quality,
        available_providers: request.fallback.available_providers,
        extra_hops_count: request.fallback.extra_hops?.length ?? 0,
      }
      : undefined,
  };
}

function sanitizeReversePromptRequestForLog(request: ReversePromptRequest): Record<string, unknown> {
  return {
    provider: request.provider,
    language: request.language ?? '',
    format: request.format ?? '',
    image_preview: truncateBase64Like(request.image),
  };
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function normalizeInvokeError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const detailsText =
      'details' in error
        ? typeof (error as { details?: unknown }).details === 'string'
          ? (error as { details?: string }).details
          : undefined
        : undefined;
    return { message: error.message || 'Generation failed', details: detailsText };
  }

  if (typeof error === 'string') {
    return { message: error || 'Generation failed', details: error || undefined };
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      (typeof record.message === 'string' && record.message) ||
      (typeof record.error === 'string' && record.error) ||
      (typeof record.msg === 'string' && record.msg) ||
      'Generation failed';
    let details: string | undefined;
    try {
      details = truncateText(JSON.stringify(record, null, 2), 2000);
    } catch {
      details = truncateText(String(record), 2000);
    }
    return { message, details };
  }

  return { message: 'Generation failed' };
}

function createErrorWithDetails(message: string, details?: string): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  if (details) {
    error.details = details;
  }
  return error;
}

export async function setApiKey(provider: string, apiKey: string): Promise<void> {
  console.info('[AI] set_api_key', {
    provider,
    apiKeyMasked: apiKey ? `${apiKey.slice(0, 4)}***${apiKey.slice(-2)}` : '',
    tauri: isTauri(),
  });
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke('set_api_key', { provider, apiKey });
}

export async function generateImage(request: GenerateRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[AI] generate_image request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<unknown>('generate_image', { request });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'Generation returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('Generation returned empty image source');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[AI] generate_image success', {
      elapsedMs,
      resultPreview: truncateText(result, 220),
    });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[AI] generate_image failed', {
      elapsedMs,
      request: sanitizeGenerateRequestForLog(request),
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export async function submitGenerateImageJob(request: GenerateRequest): Promise<string> {
  console.info('[AI] submit_generate_image_job request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const jobId = await invoke<string>('submit_generate_image_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_image_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateImageJob(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('get_generate_image_job', { jobId });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_image_job returned invalid payload');
  }
  return result;
}

export async function submitGenerateVideoJob(request: GenerateRequest): Promise<string> {
  console.info('[AI] submit_generate_video_job request', {
    ...sanitizeGenerateRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const jobId = await invoke<string>('submit_generate_video_job', { request });
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error('submit_generate_video_job returned invalid job id');
  }
  return jobId.trim();
}

export async function getGenerateVideoJob(jobId: string): Promise<GenerationJobStatus> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const result = await invoke<GenerationJobStatus>('get_generate_video_job', { jobId });
  if (!result || typeof result !== 'object' || typeof result.status !== 'string') {
    throw new Error('get_generate_video_job returned invalid payload');
  }
  return result;
}

export async function listModels(): Promise<string[]> {
  return await invoke('list_models');
}

/** 生成历史台账条目（Rust GenerationHistoryDto 对齐；纯元数据，无图片）。 */
export interface GenerationHistoryEntry {
  job_id: string;
  provider_id: string;
  model: string;
  /** auto=智能链（有 fallback），manual=单点直连。 */
  mode: string;
  quality?: string | null;
  prompt?: string | null;
  size?: string | null;
  aspect_ratio?: string | null;
  duration_ms?: number | null;
  /** 链轨迹原文 JSON（GenerationAttemptStatus[]）；单点为 null。 */
  attempts_json?: string | null;
  status: string;
  error_class?: string | null;
  created_at: number;
  /** 公司 OSS 归档直链（批次11）；未归档缺省（Rust serde rename ossUrl）。 */
  ossUrl?: string | null;
}

/** 生成历史台账查询（批次5 设置页消费；按 created_at 倒序，默认 100 条）。 */
export async function listGenerationHistory(limit = 100): Promise<GenerationHistoryEntry[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const rows = await invoke<GenerationHistoryEntry[]>('list_generation_history', { limit });
  return Array.isArray(rows) ? rows : [];
}

/** 单渠道探活请求快照（localStorage 是 key 唯一真源，Rust 不持久化密钥）。 */
export interface ChannelProbeRequest {
  provider_id: string;
  api_key: string;
  base_url?: string | null;
}

export type ChannelProbeStatus = 'ok' | 'reachable' | 'down' | 'unconfigured';

/** 渠道探活/健康结果（Rust ChannelProbeDto 对齐）。 */
export interface ChannelProbeResult {
  provider_id: string;
  status: ChannelProbeStatus | string;
  latency_ms?: number | null;
  detail?: string | null;
  /** 该渠道在三条静态链中的成员模型被探活列表命中的个数（ok 时才有意义）。 */
  chain_models_ok?: number | null;
  checked_at: number;
}

/**
 * 渠道探活（模块 C doctor）：零生成成本，只拉模型列表，绝不发生成请求。
 * 10s/渠道自身超时，总耗时 ≈ 最慢渠道封顶；结果落 ai_channel_health 台账。
 */
export async function probeChannels(
  providers: ChannelProbeRequest[]
): Promise<ChannelProbeResult[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const rows = await invoke<ChannelProbeResult[]>('probe_channels', { providers });
  return Array.isArray(rows) ? rows : [];
}

/** 最近一次渠道健康结果（面板/选择器圆点数据源；不触发探测）。 */
export async function listChannelHealth(): Promise<ChannelProbeResult[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  const rows = await invoke<ChannelProbeResult[]>('list_channel_health');
  return Array.isArray(rows) ? rows : [];
}

export async function listProviderModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string
): Promise<string[]> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  return await invoke('list_provider_models', {
    provider,
    apiKey: apiKey ?? '',
    baseUrl: baseUrl ?? null,
  });
}

export async function reversePrompt(request: ReversePromptRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[AI] reverse_prompt request', {
    ...sanitizeReversePromptRequestForLog(request),
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<unknown>('reverse_prompt', {
      provider: request.provider,
      request: {
        image: request.image,
        language: request.language,
        format: request.format,
        model: request.model ?? null,
      },
    });
    if (typeof rawResult !== 'string') {
      throw createErrorWithDetails(
        'reverse_prompt returned non-string payload',
        truncateText(
          (() => {
            try {
              return JSON.stringify(rawResult, null, 2);
            } catch {
              return String(rawResult);
            }
          })(),
          2000
        )
      );
    }
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('reverse_prompt returned empty content');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[AI] reverse_prompt success', { elapsedMs, length: result.length });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[AI] reverse_prompt failed', {
      elapsedMs,
      request: sanitizeReversePromptRequestForLog(request),
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export interface CraftImagePromptRequest {
  provider: string;
  apiKey: string;
  userInput: string;
  category?: string;
  model?: string;
  language?: string;
}

export async function craftImagePrompt(request: CraftImagePromptRequest): Promise<string> {
  const startedAt = performance.now();
  console.info('[AI] craft_image_prompt request', {
    provider: request.provider,
    category: request.category ?? 'general',
    userInputLength: request.userInput.length,
    tauri: isTauri(),
  });

  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }

  try {
    const rawResult = await invoke<string>('craft_image_prompt', {
      provider: request.provider,
      apiKey: request.apiKey,
      userInput: request.userInput,
      category: request.category ?? null,
      model: request.model ?? null,
      language: request.language ?? null,
    });
    const result = rawResult.trim();
    if (!result) {
      throw createErrorWithDetails('craft_image_prompt returned empty content');
    }
    const elapsedMs = Math.round(performance.now() - startedAt);
    console.info('[AI] craft_image_prompt success', { elapsedMs, length: result.length });
    return result;
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startedAt);
    const normalizedError = normalizeInvokeError(error);
    console.error('[AI] craft_image_prompt failed', {
      elapsedMs,
      provider: request.provider,
      category: request.category,
      error,
      normalizedError,
    });
    const commandError: ErrorWithDetails = new Error(normalizedError.message);
    commandError.details = normalizedError.details;
    throw commandError;
  }
}

export async function setJuyouapiBaseUrl(baseUrl: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_juyouapi_base_url', { baseUrl });
}

export async function setOllamaBaseUrl(baseUrl: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_ollama_base_url', { baseUrl });
}

export async function setOllamaModel(model: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_ollama_model', { model });
}

/**
 * Register (or update) a runtime custom NEWAPI-compatible endpoint in the Rust backend.
 * The provider id should be unique per endpoint (e.g. `newapi_<hash>`); requests whose
 * model id starts with `${id}/` route to this provider instance.
 */
export async function registerCustomEndpoint(
  id: string,
  baseUrl: string,
  apiKey: string
): Promise<void> {
  if (!isTauri()) return;
  await invoke('register_custom_endpoint', { id, baseUrl, apiKey });
}

/** Remove a previously registered runtime custom endpoint from the Rust backend. */
export async function removeCustomEndpoint(id: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('remove_custom_endpoint', { id });
}

/**
 * 注入 / 清除公司 OSS 归档凭据（批次11）。空 ak/sk = 关闭归档。
 * 与 set_api_key 同哲学：Rust 不持久化密钥，前端 localStorage 是唯一真源。
 */
export async function setOssConfig(accessKey: string, secretKey: string): Promise<void> {
  if (!isTauri()) return;
  await invoke('set_oss_config', { ak: accessKey, sk: secretKey });
}

/**
 * 归档通道连通性测试（批次11）：上传 1×1 PNG 到 `未分类/.connectivity-test-{ts}.png`。
 * 可传当前输入框的密钥（未保存即可测）；不传则用 Rust 侧已注入配置。
 * 成功返回人话信息 + 测试对象 URL；失败 reject 人话原因（403/超时/网络不可达）。
 */
export async function testOssArchive(accessKey?: string, secretKey?: string): Promise<string> {
  if (!isTauri()) {
    throw new Error('当前不是 Tauri 容器环境，请使用 `npm run tauri dev` 启动');
  }
  return await invoke<string>('test_oss_archive', {
    accessKey: accessKey ?? null,
    secretKey: secretKey ?? null,
  });
}
