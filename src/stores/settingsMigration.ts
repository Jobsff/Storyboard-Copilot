import {
  DEFAULT_GRSAI_CREDIT_TIER_ID,
  PRICE_DISPLAY_CURRENCY_MODES,
  type GrsaiCreditTierId,
  type PriceDisplayCurrencyMode,
} from '@/features/canvas/pricing/types';

/**
 * settingsStore 持久化迁移的纯函数层：不依赖 zustand / 浏览器环境，可被单测直接导入。
 * settingsStore 只保留 state 形状、setters 与 persist 配置。
 */

export type ProviderApiKeys = Record<string, string>;

export type UiRadiusPreset = 'compact' | 'default' | 'large';
export type ThemeTonePreset = 'neutral' | 'warm' | 'cool';
export type CanvasEdgeRoutingMode = 'spline' | 'orthogonal' | 'smartOrthogonal';

/** 智能出图模式：auto=默认展示智能出图；expert=专家模式（真实渠道手动选择）。 */
export type ImageGenMode = 'auto' | 'expert';
/** 智能出图质量档位（与 Rust chain.rs 的 quality 对齐）。 */
export type ImageQualityMode = 'standard' | 'pro';

/** 公司 OSS 资产归档配置（v22）：密钥存 localStorage（前端是唯一真源），运行时注入 Rust。 */
export interface OssArchiveSettings {
  /** 关闭后出图不再归档（默认开启）。 */
  enabled: boolean;
  accessKey: string;
  secretKey: string;
}

/** v22：ossArchive 归一化——形状非法 / 字段缺失一律回落默认；
 * enabled 语义 = 非**显式 false** 一律默认开（尊重老用户显式关闭）。 */
export function normalizeOssArchive(input: unknown): OssArchiveSettings {
  const defaults: OssArchiveSettings = { enabled: true, accessKey: '', secretKey: '' };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return defaults;
  }
  const raw = input as { enabled?: unknown; accessKey?: unknown; secretKey?: unknown };
  return {
    enabled: raw.enabled !== false,
    accessKey: typeof raw.accessKey === 'string' ? raw.accessKey.trim() : '',
    secretKey: typeof raw.secretKey === 'string' ? raw.secretKey.trim() : '',
  };
}

export const DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL = 'nano-banana-pro';

/** 与 Rust ai_generation_history 的 mode 字段语义对齐（manual/auto）。 */
export type GenerationModeSetting = 'auto' | 'manual';

const HEX_COLOR_PATTERN = /^#?[0-9a-fA-F]{6}$/;

export function normalizeHexColor(input: string): string {
  const trimmed = input.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    return '#3B82F6';
  }
  return trimmed.startsWith('#') ? trimmed.toUpperCase() : `#${trimmed.toUpperCase()}`;
}

export function normalizeApiKey(input: string): string {
  return input.trim();
}

export function normalizeImageGenMode(
  input: ImageGenMode | string | null | undefined
): ImageGenMode {
  return input === 'expert' ? 'expert' : 'auto';
}

export function normalizeImageQuality(
  input: ImageQualityMode | string | null | undefined
): ImageQualityMode {
  return input === 'pro' ? 'pro' : 'standard';
}

export function normalizePriceDisplayCurrencyMode(
  input: PriceDisplayCurrencyMode | string | null | undefined
): PriceDisplayCurrencyMode {
  return PRICE_DISPLAY_CURRENCY_MODES.includes(input as PriceDisplayCurrencyMode)
    ? (input as PriceDisplayCurrencyMode)
    : 'auto';
}

export function normalizeUsdToCnyRate(input: number | string | null | undefined): number {
  const numeric = typeof input === 'number' ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 7.2;
  }

  return Math.min(100, Math.max(0.01, Math.round(numeric * 100) / 100));
}

export function normalizeGrsaiCreditTierId(
  input: GrsaiCreditTierId | string | null | undefined
): GrsaiCreditTierId {
  switch (input) {
    case 'tier-10':
    case 'tier-20':
    case 'tier-49':
    case 'tier-99':
    case 'tier-499':
    case 'tier-999':
      return input;
    default:
      return DEFAULT_GRSAI_CREDIT_TIER_ID;
  }
}

export function normalizeGrsaiNanoBananaProModel(input: string | null | undefined): string {
  const trimmed = (input ?? '').trim().toLowerCase();
  if (trimmed === DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL || trimmed.startsWith('nano-banana-pro-')) {
    return trimmed;
  }
  return DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL;
}

export function normalizeCanvasEdgeRoutingMode(
  input: CanvasEdgeRoutingMode | string | null | undefined
): CanvasEdgeRoutingMode {
  if (input === 'orthogonal' || input === 'smartOrthogonal' || input === 'spline') {
    return input;
  }
  return 'spline';
}

export function normalizeApiKeys(input: ProviderApiKeys | null | undefined): ProviderApiKeys {
  if (!input) {
    return {};
  }

  return Object.entries(input).reduce<ProviderApiKeys>((acc, [providerId, key]) => {
    const normalizedProviderId = providerId.trim();
    if (!normalizedProviderId) {
      return acc;
    }

    acc[normalizedProviderId] = normalizeApiKey(key);
    return acc;
  }, {});
}

/** A user-defined NEWAPI-compatible (OpenAI-compatible) endpoint. */
export interface CustomEndpoint {
  /** Internal routing id, e.g. `newapi_<hash>`. Must start with `newapi_`. */
  id: string;
  /** User-facing display name, e.g. "小胡API". */
  name: string;
  /** Base URL, e.g. https://picture.aifast.site */
  baseUrl: string;
  /** Raw model names selected by the user (without the `${id}/` prefix). */
  selectedModels: string[];
  /** 开启后，已勾选且与内置链同名的模型作为追加档进入智能出图降级链（默认关）。 */
  joinChain: boolean;
}

/** aifast：预置 NEWAPI 槽位的内置中转商（base 固定，不可删除）。 */
export const AIFAST_PROVIDER_ID = 'aifast';
export const AIFAST_BASE_URL = 'https://picture.aifast.site';

/** Generate a unique routing id for a custom endpoint. */
export function generateCustomEndpointId(): string {
  // 8 hex chars from a random source; prefixed with `newapi_` for routing.
  const random = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const stamp = Date.now().toString(16).slice(-4);
  return `newapi_${stamp}${random}`.slice(0, 20);
}

export function normalizeCustomEndpoint(input: unknown): CustomEndpoint | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id.startsWith('newapi_')) return null;
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
  // Allow an empty name while the user is editing (clearing the input box);
  // a display fallback to the id is applied in the UI, not stored here.
  const name = typeof raw.name === 'string' ? raw.name : '';
  const models = Array.isArray(raw.selectedModels)
    ? raw.selectedModels.filter((m): m is string => typeof m === 'string' && m.trim().length > 0)
    : [];
  return {
    id,
    name,
    baseUrl,
    selectedModels: Array.from(new Set(models)),
    // v20 新字段：老数据缺省 = 关（红线：开关全关时链行为与 v0.3.0 一致）。
    joinChain: raw.joinChain === true,
  };
}

export function normalizeCustomEndpoints(input: unknown): CustomEndpoint[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: CustomEndpoint[] = [];
  for (const item of input) {
    const normalized = normalizeCustomEndpoint(item);
    if (normalized && seen.add(normalized.id)) {
      result.push(normalized);
    }
  }
  return result;
}

/**
 * settings-storage 的 migrate 纯函数（当前 version 22）。
 * 语义：老用户已有字段原样保留（含 lastUsedImageModel——不强制迁移到智能出图），
 * 仅对缺失/非法字段补默认值。
 * v20 曾引入 aifastModels（运行时勾选），v21 改静态清单后**读取即丢弃**；
 * aifastJoinChain 保留。v22 新增 ossArchive（公司 OSS 资产归档）。
 */
export function migratePersistedSettings(persistedState: unknown): Record<string, unknown> {
  const state = (persistedState ?? {}) as {
    apiKey?: string;
    apiKeys?: ProviderApiKeys;
    ignoreAtTagWhenCopyingAndGenerating?: boolean;
    grsaiNanoBananaProModel?: string;
    hideProviderGuidePopover?: boolean;
    canvasEdgeRoutingMode?: CanvasEdgeRoutingMode | string;
    autoCheckAppUpdateOnLaunch?: boolean;
    enableUpdateDialog?: boolean;
    enableStoryboardGenGridPreviewShortcut?: boolean;
    showStoryboardGenAdvancedRatioControls?: boolean;
    storyboardGenAutoInferEmptyFrame?: boolean;
    showNodePrice?: boolean;
    priceDisplayCurrencyMode?: PriceDisplayCurrencyMode | string;
    usdToCnyRate?: number | string;
    preferDiscountedPrice?: boolean;
    grsaiCreditTierId?: GrsaiCreditTierId | string;
    customEndpoints?: unknown;
    imageGenMode?: ImageGenMode | string;
    imageQuality?: ImageQualityMode | string;
    autoProbeOnLaunch?: boolean;
    aifastJoinChain?: boolean;
    ossArchive?: unknown;
  };

  const migratedApiKeys = normalizeApiKeys(state.apiKeys);
  if (migratedApiKeys['666api']) {
    const existingKey = migratedApiKeys['666api'];
    migratedApiKeys['666api_claude'] = existingKey;
    migratedApiKeys['666api_gpt'] = existingKey;
    migratedApiKeys['666api_gemini'] = existingKey;
    migratedApiKeys['666api_default'] = existingKey;
    delete migratedApiKeys['666api'];
  }
  // Migrate juyouapi group keys to single key
  if (!migratedApiKeys['juyouapi']) {
    const singleKey =
      migratedApiKeys['juyouapi_default'] ||
      migratedApiKeys['juyouapi_gemini'] ||
      migratedApiKeys['juyouapi_gpt'] ||
      migratedApiKeys['juyouapi_claude'];
    if (singleKey) {
      migratedApiKeys['juyouapi'] = singleKey;
    }
  }
  delete migratedApiKeys['juyouapi_default'];
  delete migratedApiKeys['juyouapi_gemini'];
  delete migratedApiKeys['juyouapi_gpt'];
  delete migratedApiKeys['juyouapi_claude'];
  const ignoreAtTagWhenCopyingAndGenerating =
    state.ignoreAtTagWhenCopyingAndGenerating ?? true;

  // v18/v19/v20/v21/v22 新增字段：缺失或非法时补默认值，不覆盖老用户显式配置。
  // backendSyncErrors 是运行时字段，rehydrate 时强制清空（陈旧失败项不可信）。
  // v21：aifastModels 改静态清单，迁移时读取即丢弃（不在输出中保留）。
  // v22：ossArchive（公司 OSS 资产归档），enabled 默认开。
  const migratedDefaults = {
    imageGenMode: normalizeImageGenMode(state.imageGenMode),
    imageQuality: normalizeImageQuality(state.imageQuality),
    autoProbeOnLaunch: state.autoProbeOnLaunch ?? true,
    backendSyncErrors: [] as string[],
    aifastJoinChain: state.aifastJoinChain === true,
    ossArchive: normalizeOssArchive(state.ossArchive),
  };

  /** 已退役字段的剥离表：spread 输入前剔除，防止旧键回流进新 state。 */
  const RETIRED_KEYS = ['aifastModels'] as const;

  function stripRetiredFields(input: unknown): Record<string, unknown> {
    const rest = { ...(input as Record<string, unknown>) };
    for (const key of RETIRED_KEYS) {
      delete rest[key];
    }
    return rest;
  }

  if (Object.keys(migratedApiKeys).length > 0) {
    return {
      ...stripRetiredFields(persistedState),
      isHydrated: true,
      apiKeys: migratedApiKeys,
      ignoreAtTagWhenCopyingAndGenerating,
      grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
        state.grsaiNanoBananaProModel
      ),
      hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
      canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
      autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
      enableUpdateDialog: state.enableUpdateDialog ?? true,
      enableStoryboardGenGridPreviewShortcut:
        state.enableStoryboardGenGridPreviewShortcut ?? false,
      showStoryboardGenAdvancedRatioControls:
        state.showStoryboardGenAdvancedRatioControls ?? false,
      storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
      showNodePrice: state.showNodePrice ?? true,
      priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
        state.priceDisplayCurrencyMode
      ),
      usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
      preferDiscountedPrice: state.preferDiscountedPrice ?? false,
      grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
      juyouapiBaseUrl: (state as { juyouapiBaseUrl?: string }).juyouapiBaseUrl ?? '',
      ollamaBaseUrl: (state as { ollamaBaseUrl?: string }).ollamaBaseUrl ?? 'http://localhost:11434',
      ollamaModel: (state as { ollamaModel?: string }).ollamaModel ?? '',
      aiAssistantProvider: (state as { aiAssistantProvider?: string }).aiAssistantProvider ?? '666api',
      aiAssistantModel: (state as { aiAssistantModel?: string }).aiAssistantModel ?? '',
      lastUsedImageModel: (state as { lastUsedImageModel?: string }).lastUsedImageModel ?? '',
      customEndpoints: normalizeCustomEndpoints(state.customEndpoints),
      ...migratedDefaults,
    };
  }

  return {
    ...stripRetiredFields(persistedState),
    isHydrated: true,
    apiKeys: state.apiKey ? { ppio: normalizeApiKey(state.apiKey) } : {},
    ignoreAtTagWhenCopyingAndGenerating,
    grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(
      state.grsaiNanoBananaProModel
    ),
    hideProviderGuidePopover: state.hideProviderGuidePopover ?? false,
    canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(state.canvasEdgeRoutingMode),
    autoCheckAppUpdateOnLaunch: state.autoCheckAppUpdateOnLaunch ?? true,
    enableUpdateDialog: state.enableUpdateDialog ?? true,
    enableStoryboardGenGridPreviewShortcut:
      state.enableStoryboardGenGridPreviewShortcut ?? false,
    showStoryboardGenAdvancedRatioControls:
      state.showStoryboardGenAdvancedRatioControls ?? false,
    storyboardGenAutoInferEmptyFrame: state.storyboardGenAutoInferEmptyFrame ?? true,
    showNodePrice: state.showNodePrice ?? true,
    priceDisplayCurrencyMode: normalizePriceDisplayCurrencyMode(
      state.priceDisplayCurrencyMode
    ),
    usdToCnyRate: normalizeUsdToCnyRate(state.usdToCnyRate),
    preferDiscountedPrice: state.preferDiscountedPrice ?? false,
    grsaiCreditTierId: normalizeGrsaiCreditTierId(state.grsaiCreditTierId),
    ollamaBaseUrl: (state as { ollamaBaseUrl?: string }).ollamaBaseUrl ?? 'http://localhost:11434',
    ollamaModel: (state as { ollamaModel?: string }).ollamaModel ?? '',
    aiAssistantProvider: (state as { aiAssistantProvider?: string }).aiAssistantProvider ?? '666api',
    lastUsedImageModel: (state as { lastUsedImageModel?: string }).lastUsedImageModel ?? '',
    customEndpoints: normalizeCustomEndpoints(state.customEndpoints),
    ...migratedDefaults,
  };
}
