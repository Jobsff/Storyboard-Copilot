import { resolve666ApiKey } from '../models/providers/api666';
import {
  resolveAutoImageQuality,
  type ImageAutoQuality,
} from '../models/image/auto/autoCapabilities';
import { AIFAST_MODEL_NAMES } from '../models/image/aifast/modelNames';
import { AIFAST_BASE_URL, AIFAST_PROVIDER_ID, type CustomEndpoint } from '@/stores/settingsStore';
import { canvasAiGateway } from './canvasServices';
import {
  listChannelHealth,
  probeChannels,
  type ChannelProbeRequest,
  type ChannelProbeResult,
  type ExtraHopSpec,
} from '@/commands/ai';

/**
 * 降级链 fallback（与 Rust 侧 chain.rs 静态链成员一致）：
 * - quality：standard / pro，决定 Rust 打头的链
 * - availableProviders：有 key 的渠道 id 列表，Rust build_chain 按此过滤
 * - extraHops：NEWAPI 接口 / aifast 追加档（批次8，可选；空 = 行为与 v0.3.0 一致）
 * 空链（availableProviders 为空）时 buildImageFallback 返回 null，由生成入口拦截报错，
 * 绝不能把 auto/* 占位模型 id 在无 fallback 的情况下发给 Rust。
 */
export interface ImageFallbackOptions {
  quality: ImageAutoQuality;
  availableProviders: string[];
  extraHops?: ExtraHopSpec[];
}

/** 降级链渠道清单（顺序即 Rust 侧静态链成员，实际执行顺序由 chain.rs 决定）。批次10：aifast 进 pro 链第二位。 */
export const CHAIN_PROVIDER_IDS = ['grsai', 'aifast', '666api', 'juyouapi', 'kie'] as const;

/** 内置链成员裸模型名集合（批次8：NEWAPI 接口模型与之完全同名才允许入链）。 */
export const CHAIN_MEMBER_MODEL_NAMES: ReadonlySet<string> = new Set([
  'nano-banana-2', // grsai/kie
  'nano-banana-pro', // grsai（pro 链）
  'gemini-3.1-flash-image-preview', // 666api
  'gemini-3-pro-image', // 666api（pro 链）
  'gemini-3.1-flash-image', // juyouapi
  'gemini-3-pro-image-preview', // aifast（批次10 pro 链）
]);

/** 判断某链渠道是否已配置 key（666api 按 gemini 分组 key 并回退 default）。 */
export function hasChainApiKey(providerId: string, apiKeys: Record<string, string>): boolean {
  return Boolean(resolveChainApiKey(providerId, apiKeys).trim());
}

/** 取某链渠道的前端存储 key（localStorage 是 key 唯一真源）。 */
export function resolveChainApiKey(providerId: string, apiKeys: Record<string, string>): string {
  if (providerId === '666api') {
    // 链成员模型为 666api/gemini-3.1-flash-image-preview → gemini 分组 key（回退 666api_default）
    return resolve666ApiKey('666api/gemini-3.1-flash-image-preview', apiKeys) ?? '';
  }
  if (providerId === 'juyouapi') {
    return apiKeys['juyouapi'] ?? '';
  }
  return apiKeys[providerId] ?? '';
}

/** 现算链可用渠道：遍历链渠道检查 apiKeys（UI 层可直接用于空链提示）。 */
export function resolveChainAvailableProviders(apiKeys: Record<string, string>): string[] {
  return CHAIN_PROVIDER_IDS.filter((providerId) => hasChainApiKey(providerId, apiKeys));
}

/**
 * 把链内所有渠道的 key 一次性注入 Rust（set_api_key）。
 * 必要性：key 平时只在"提交前注入当前选中 provider"——链任务的 hop 会换渠道，
 * 若不预注入，hop 落到未注入渠道时会以 auth 失败白白烧掉一档。
 * 单渠道注入失败仅告警不阻断：链的降级语义本身可吸收单渠道 auth 失败。
 */
export async function injectChainApiKeys(
  apiKeys: Record<string, string>,
  availableProviders: string[]
): Promise<void> {
  await Promise.all(
    availableProviders.map(async (providerId) => {
      const apiKey = resolveChainApiKey(providerId, apiKeys);
      if (!apiKey.trim()) {
        return;
      }
      try {
        await canvasAiGateway.setApiKey(providerId, apiKey);
      } catch (error) {
        console.warn('[ImageFallback] inject chain api key failed', { providerId, error });
      }
    })
  );
}

// ============================== 渠道探活（模块 C doctor · 前端侧） ==============================

/**
 * 内置渠道的探活展示顺序（批次8 重排：grsai → aifast → 666api → juyouapi → agnes → ollama，
 * 隐藏渠道 kie/ppio/fal 垫底；与密钥区/专家模式 Tab 三处一致）。
 */
export const PROBE_CHANNEL_ORDER = [
  'grsai',
  AIFAST_PROVIDER_ID,
  '666api',
  'juyouapi',
  'agnes',
  'ollama',
  'kie',
  'ppio',
  'fal',
] as const;

/** 探活请求快照的设置源（key/baseUrl/端点清单取自 settingsStore 快照）。 */
export interface ProbeSettingsSource {
  apiKeys: Record<string, string>;
  juyouapiBaseUrl?: string;
  ollamaBaseUrl?: string;
  customEndpoints?: CustomEndpoint[];
}

/** 组装探活请求快照（批次8：纳入 aifast 固定 base + 每个已配置的 NEWAPI 接口端点）。 */
export function buildProbeRequests(settings: ProbeSettingsSource): ChannelProbeRequest[] {
  const apiKeys = settings.apiKeys ?? {};
  const builtIns: ChannelProbeRequest[] = PROBE_CHANNEL_ORDER.map((providerId) => ({
    provider_id: providerId,
    api_key:
      providerId === '666api'
        ? (resolve666ApiKey('666api/gemini-3.1-flash-image-preview', apiKeys) ?? '')
        : (apiKeys[providerId] ?? '').trim(),
    base_url:
      providerId === 'juyouapi'
        ? (settings.juyouapiBaseUrl?.trim() || null)
        : providerId === 'ollama'
          ? (settings.ollamaBaseUrl?.trim() || null)
          : providerId === AIFAST_PROVIDER_ID
            ? AIFAST_BASE_URL
            : null,
  }));
  // NEWAPI 接口端点：传端点自己的 base；未填 base 的端点跳过（Rust 无法探测）。
  const endpointRequests: ChannelProbeRequest[] = (settings.customEndpoints ?? [])
    .filter((endpoint) => endpoint.baseUrl.trim().length > 0)
    .map((endpoint) => ({
      provider_id: endpoint.id,
      api_key: (apiKeys[endpoint.id] ?? '').trim(),
      base_url: endpoint.baseUrl.trim(),
    }));
  return [...builtIns, ...endpointRequests];
}

/** 最近一次健康结果缓存（多组件实例共享，避免重复 invoke；探活后刷新）。 */
let channelHealthCache: ChannelProbeResult[] | null = null;
let channelHealthPromise: Promise<ChannelProbeResult[]> | null = null;

/** 读取最近一次健康台账（不触发探测；带模块级去重缓存）。 */
export function fetchChannelHealthCached(force = false): Promise<ChannelProbeResult[]> {
  if (!force && channelHealthCache) {
    return Promise.resolve(channelHealthCache);
  }
  if (!channelHealthPromise) {
    channelHealthPromise = listChannelHealth()
      .then((rows) => {
        channelHealthCache = rows;
        return rows;
      })
      .finally(() => {
        channelHealthPromise = null;
      });
  }
  return channelHealthPromise;
}

export function getCachedChannelHealth(): ChannelProbeResult[] | null {
  return channelHealthCache;
}

/** 全渠道探测（设置页面板[立即重新检测]/失败弹窗[检测所有渠道]/启动静默探活共用）。 */
export async function probeAllChannels(settings: ProbeSettingsSource): Promise<ChannelProbeResult[]> {
  const rows = await probeChannels(buildProbeRequests(settings));
  if (rows.length > 0) {
    channelHealthCache = rows;
  }
  return rows;
}

/**
 * 从 NEWAPI 接口端点 + aifast 配置解析追加档（批次8 引入，批次9 aifast 改静态清单）。
 * 入链规则：开启 joinChain 且已配 key 的端点，其模型中**与内置链成员模型名
 * 完全同名**的作为额外 hop 追加到内置链尾部；不同名绝不进链（Rust 侧还会再防御一次）。
 * aifast 候选模型 = 静态清单 AIFAST_MODEL_NAMES（v21 起无用户勾选）。
 */
export function resolveExtraChainHops(
  apiKeys: Record<string, string>,
  endpoints: CustomEndpoint[],
  aifast: { joinChain: boolean }
): ExtraHopSpec[] {
  const hops: ExtraHopSpec[] = [];
  const pushMatching = (providerId: string, displayName: string, models: string[]) => {
    for (const modelName of models) {
      if (!CHAIN_MEMBER_MODEL_NAMES.has(modelName)) {
        continue;
      }
      if (hops.some((hop) => hop.provider_id === providerId && hop.model === `${providerId}/${modelName}`)) {
        continue;
      }
      hops.push({
        provider_id: providerId,
        model: `${providerId}/${modelName}`,
        display_name: displayName,
      });
    }
  };

  for (const endpoint of endpoints) {
    if (!endpoint.joinChain) continue;
    if (!(apiKeys[endpoint.id] ?? '').trim()) continue;
    if (!endpoint.baseUrl.trim()) continue;
    pushMatching(endpoint.id, endpoint.name || endpoint.id, endpoint.selectedModels);
  }

  if (aifast.joinChain && (apiKeys[AIFAST_PROVIDER_ID] ?? '').trim()) {
    pushMatching(AIFAST_PROVIDER_ID, AIFAST_PROVIDER_ID, [...AIFAST_MODEL_NAMES]);
  }
  return hops;
}

/**
 * 构建 fallback 注入项；空链返回 null（调用方必须拦截，不得发请求）。
 * 仅图片生成入口（ImageEdit / StoryboardGen / SequenceFrameGen / UI 资产预设）调用；
 * 视频与反推提示词等入口明确排除降级链。
 *
 * extraSource（批次8，可选）：传入 NEWAPI 接口端点 + aifast 配置时，开启入链且
 * 已配 key 的端点追加进 availableProviders（key 预注入用）并生成 extraHops；
 * 不传 / 开关全关时行为与 v0.3.0 逐字节一致（红线）。
 */
export function buildAutoImageFallback(
  modelId: string,
  apiKeys: Record<string, string>,
  extraSource?: {
    customEndpoints?: CustomEndpoint[];
    aifastJoinChain?: boolean;
  }
): ImageFallbackOptions | null {
  const availableProviders = resolveChainAvailableProviders(apiKeys);
  if (availableProviders.length === 0) {
    return null;
  }
  const options: ImageFallbackOptions = {
    quality: resolveAutoImageQuality(modelId),
    availableProviders,
  };
  if (extraSource) {
    const extraHops = resolveExtraChainHops(
      apiKeys,
      extraSource.customEndpoints ?? [],
      { joinChain: extraSource.aifastJoinChain === true }
    );
    if (extraHops.length > 0) {
      options.availableProviders = [...availableProviders, ...extraHops.map((hop) => hop.provider_id)];
      options.extraHops = extraHops;
    }
  }
  return options;
}
