import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_GRSAI_CREDIT_TIER_ID,
  type GrsaiCreditTierId,
  type PriceDisplayCurrencyMode,
} from '@/features/canvas/pricing/types';

import {
  DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
  migratePersistedSettings,
  normalizeApiKey,
  normalizeCanvasEdgeRoutingMode,
  normalizeCustomEndpoint,
  normalizeGrsaiCreditTierId,
  normalizeGrsaiNanoBananaProModel,
  normalizeHexColor,
  normalizeImageGenMode,
  normalizeImageQuality,
  normalizeOssArchive,
  normalizePriceDisplayCurrencyMode,
  normalizeUsdToCnyRate,
  type CanvasEdgeRoutingMode,
  type CustomEndpoint,
  type ImageGenMode,
  type ImageQualityMode,
  type OssArchiveSettings,
  type ProviderApiKeys,
  type ThemeTonePreset,
  type UiRadiusPreset,
} from './settingsMigration';

// Re-export public types/utilities so existing `@/stores/settingsStore` imports keep working.
export {
  AIFAST_BASE_URL,
  AIFAST_PROVIDER_ID,
  DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
  generateCustomEndpointId,
} from './settingsMigration';
export type {
  CanvasEdgeRoutingMode,
  CustomEndpoint,
  ImageGenMode,
  ImageQualityMode,
  OssArchiveSettings,
  ProviderApiKeys,
  ThemeTonePreset,
  UiRadiusPreset,
} from './settingsMigration';

export interface SettingsState {
  isHydrated: boolean;
  apiKeys: ProviderApiKeys;
  juyouapiBaseUrl: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  aiAssistantProvider: string;
  aiAssistantModel: string;
  lastUsedImageModel: string;
  grsaiNanoBananaProModel: string;
  hideProviderGuidePopover: boolean;
  downloadPresetPaths: string[];
  useUploadFilenameAsNodeTitle: boolean;
  storyboardGenKeepStyleConsistent: boolean;
  storyboardGenDisableTextInImage: boolean;
  storyboardGenAutoInferEmptyFrame: boolean;
  ignoreAtTagWhenCopyingAndGenerating: boolean;
  enableStoryboardGenGridPreviewShortcut: boolean;
  showStoryboardGenAdvancedRatioControls: boolean;
  showNodePrice: boolean;
  priceDisplayCurrencyMode: PriceDisplayCurrencyMode;
  usdToCnyRate: number;
  preferDiscountedPrice: boolean;
  grsaiCreditTierId: GrsaiCreditTierId;
  uiRadiusPreset: UiRadiusPreset;
  themeTonePreset: ThemeTonePreset;
  accentColor: string;
  canvasEdgeRoutingMode: CanvasEdgeRoutingMode;
  autoCheckAppUpdateOnLaunch: boolean;
  enableUpdateDialog: boolean;
  customEndpoints: CustomEndpoint[];
  /** aifast 是否加入智能出图降级链（v20 引入；v21 起模型改静态清单，仅留此开关）。 */
  aifastJoinChain: boolean;
  /** 智能出图模式：auto=默认智能出图；expert=专家模式（批次5 设置页接 UI）。 */
  imageGenMode: ImageGenMode;
  /** 智能出图默认质量档（批次5 设置页接 UI）。 */
  imageQuality: ImageQualityMode;
  /** 启动时渠道探活开关（批次6 使用）。 */
  autoProbeOnLaunch: boolean;
  /** 后端同步失败项（批次5：juyouapi/ollama/customEndpoint 推送失败收集，仅设置页可见）。 */
  backendSyncErrors: string[];
  /** 公司 OSS 资产归档（v22）：出图后自动上传，密钥仅存 localStorage（前端唯一真源）。 */
  ossArchive: OssArchiveSettings;
  setHydrated: (hydrated: boolean) => void;
  setProviderApiKey: (providerId: string, key: string) => void;
  setJuyouapiBaseUrl: (url: string) => void;
  setOllamaBaseUrl: (url: string) => void;
  setOllamaModel: (model: string) => void;
  setAiAssistantProvider: (provider: string) => void;
  setAiAssistantModel: (model: string) => void;
  setLastUsedImageModel: (model: string) => void;
  setGrsaiNanoBananaProModel: (model: string) => void;
  setHideProviderGuidePopover: (hide: boolean) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
  setUseUploadFilenameAsNodeTitle: (enabled: boolean) => void;
  setStoryboardGenKeepStyleConsistent: (enabled: boolean) => void;
  setStoryboardGenDisableTextInImage: (enabled: boolean) => void;
  setStoryboardGenAutoInferEmptyFrame: (enabled: boolean) => void;
  setIgnoreAtTagWhenCopyingAndGenerating: (enabled: boolean) => void;
  setEnableStoryboardGenGridPreviewShortcut: (enabled: boolean) => void;
  setShowStoryboardGenAdvancedRatioControls: (enabled: boolean) => void;
  setShowNodePrice: (enabled: boolean) => void;
  setPriceDisplayCurrencyMode: (mode: PriceDisplayCurrencyMode) => void;
  setUsdToCnyRate: (rate: number) => void;
  setPreferDiscountedPrice: (enabled: boolean) => void;
  setGrsaiCreditTierId: (tierId: GrsaiCreditTierId) => void;
  setUiRadiusPreset: (preset: UiRadiusPreset) => void;
  setThemeTonePreset: (preset: ThemeTonePreset) => void;
  setAccentColor: (color: string) => void;
  setCanvasEdgeRoutingMode: (mode: CanvasEdgeRoutingMode) => void;
  setAutoCheckAppUpdateOnLaunch: (enabled: boolean) => void;
  setEnableUpdateDialog: (enabled: boolean) => void;
  addCustomEndpoint: (endpoint: CustomEndpoint) => void;
  updateCustomEndpoint: (id: string, patch: Partial<Omit<CustomEndpoint, 'id'>>) => void;
  removeCustomEndpoint: (id: string) => void;
  setCustomEndpointModels: (id: string, models: string[]) => void;
  setAifastJoinChain: (enabled: boolean) => void;
  setImageGenMode: (mode: ImageGenMode) => void;
  setImageQuality: (quality: ImageQualityMode) => void;
  setAutoProbeOnLaunch: (enabled: boolean) => void;
  setBackendSyncErrors: (errors: string[]) => void;
  setOssArchive: (patch: Partial<OssArchiveSettings>) => void;
}

/**
 * 把设置同步到 Rust 后端（juyouapi/ollama baseUrl、自定义 NEWAPI 接口注册）。
 * 返回失败项描述列表（空数组 = 全部成功）；静默失败可见化（批次5）的数据源。
 * API key 不在此批量同步——沿用"提交前按需注入"的既有语义。
 */
export async function syncBackendSettings(state: {
  juyouapiBaseUrl?: string;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  customEndpoints?: CustomEndpoint[];
  apiKeys?: ProviderApiKeys;
}): Promise<string[]> {
  const failures: string[] = [];
  let commands: typeof import('@/commands/ai');
  try {
    commands = await import('@/commands/ai');
  } catch {
    return ['ai'];
  }

  const baseUrl = state.juyouapiBaseUrl?.trim();
  if (baseUrl) {
    await commands.setJuyouapiBaseUrl(baseUrl).catch(() => {
      failures.push('juyouapi');
    });
  }

  const ollamaBaseUrl = state.ollamaBaseUrl?.trim();
  const ollamaModel = state.ollamaModel?.trim();
  if (ollamaBaseUrl || ollamaModel) {
    if (ollamaBaseUrl) {
      await commands.setOllamaBaseUrl(ollamaBaseUrl).catch(() => {
        failures.push('ollama');
      });
    }
    if (ollamaModel) {
      await commands.setOllamaModel(ollamaModel).catch(() => {
        failures.push('ollama');
      });
    }
  }

  const endpoints = state.customEndpoints ?? [];
  const apiKeys = state.apiKeys ?? {};
  for (const endpoint of endpoints) {
    const key = apiKeys[endpoint.id] ?? '';
    await commands.registerCustomEndpoint(endpoint.id, endpoint.baseUrl, key).catch(() => {
      failures.push(endpoint.name || endpoint.id);
    });
  }
  return failures;
}

// Persist middleware types these as strings in state literals; pricing value imports are above.

export function hasConfiguredApiKey(apiKeys: ProviderApiKeys): boolean {
  return getConfiguredApiKeyCount(apiKeys) > 0;
}

export function getConfiguredApiKeyCount(
  apiKeys: ProviderApiKeys,
  providerIds?: readonly string[]
): number {
  const keysToCount = providerIds
    ? providerIds.map((providerId) => apiKeys[providerId] ?? '')
    : Object.values(apiKeys);

  return keysToCount.reduce((count, key) => {
    return normalizeApiKey(key).length > 0 ? count + 1 : count;
  }, 0);
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      isHydrated: false,
      apiKeys: {},
      juyouapiBaseUrl: '',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: '',
      aiAssistantProvider: '666api',
      aiAssistantModel: '',
      lastUsedImageModel: '',
      grsaiNanoBananaProModel: DEFAULT_GRSAI_NANO_BANANA_PRO_MODEL,
      hideProviderGuidePopover: false,
      downloadPresetPaths: [],
      useUploadFilenameAsNodeTitle: true,
      storyboardGenKeepStyleConsistent: true,
      storyboardGenDisableTextInImage: true,
      storyboardGenAutoInferEmptyFrame: true,
      ignoreAtTagWhenCopyingAndGenerating: true,
      enableStoryboardGenGridPreviewShortcut: false,
      showStoryboardGenAdvancedRatioControls: false,
      showNodePrice: true,
      priceDisplayCurrencyMode: 'auto',
      usdToCnyRate: 7.2,
      preferDiscountedPrice: false,
      grsaiCreditTierId: DEFAULT_GRSAI_CREDIT_TIER_ID,
      uiRadiusPreset: 'default',
      themeTonePreset: 'neutral',
      accentColor: '#3B82F6',
      canvasEdgeRoutingMode: 'spline',
      autoCheckAppUpdateOnLaunch: true,
      enableUpdateDialog: true,
      customEndpoints: [],
      aifastJoinChain: false,
      imageGenMode: 'auto',
      imageQuality: 'standard',
      autoProbeOnLaunch: true,
      backendSyncErrors: [],
      ossArchive: { enabled: true, accessKey: '', secretKey: '' },
      setHydrated: (hydrated) => set({ isHydrated: hydrated }),
      setProviderApiKey: (providerId, key) =>
        set((state) => ({
          apiKeys: {
            ...state.apiKeys,
            [providerId]: normalizeApiKey(key),
          },
        })),
      setJuyouapiBaseUrl: (url) => set({ juyouapiBaseUrl: url.trim() }),
      setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url.trim() }),
      setOllamaModel: (model) => set({ ollamaModel: model.trim() }),
      setAiAssistantProvider: (provider) => set({ aiAssistantProvider: provider }),
      setAiAssistantModel: (model) => set({ aiAssistantModel: model.trim() }),
      setLastUsedImageModel: (model) => set({ lastUsedImageModel: model }),
      setGrsaiNanoBananaProModel: (model) =>
        set({
          grsaiNanoBananaProModel: normalizeGrsaiNanoBananaProModel(model),
        }),
      setHideProviderGuidePopover: (hide) => set({ hideProviderGuidePopover: hide }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
      setUseUploadFilenameAsNodeTitle: (enabled) => set({ useUploadFilenameAsNodeTitle: enabled }),
      setStoryboardGenKeepStyleConsistent: (enabled) =>
        set({ storyboardGenKeepStyleConsistent: enabled }),
      setStoryboardGenDisableTextInImage: (enabled) =>
        set({ storyboardGenDisableTextInImage: enabled }),
      setStoryboardGenAutoInferEmptyFrame: (enabled) =>
        set({ storyboardGenAutoInferEmptyFrame: enabled }),
      setIgnoreAtTagWhenCopyingAndGenerating: (enabled) =>
        set({ ignoreAtTagWhenCopyingAndGenerating: enabled }),
      setEnableStoryboardGenGridPreviewShortcut: (enabled) =>
        set({ enableStoryboardGenGridPreviewShortcut: enabled }),
      setShowStoryboardGenAdvancedRatioControls: (enabled) =>
        set({ showStoryboardGenAdvancedRatioControls: enabled }),
      setShowNodePrice: (enabled) => set({ showNodePrice: enabled }),
      setPriceDisplayCurrencyMode: (priceDisplayCurrencyMode) =>
        set({
          priceDisplayCurrencyMode:
            normalizePriceDisplayCurrencyMode(priceDisplayCurrencyMode),
        }),
      setUsdToCnyRate: (usdToCnyRate) =>
        set({ usdToCnyRate: normalizeUsdToCnyRate(usdToCnyRate) }),
      setPreferDiscountedPrice: (enabled) => set({ preferDiscountedPrice: enabled }),
      setGrsaiCreditTierId: (grsaiCreditTierId) =>
        set({ grsaiCreditTierId: normalizeGrsaiCreditTierId(grsaiCreditTierId) }),
      setUiRadiusPreset: (uiRadiusPreset) => set({ uiRadiusPreset }),
      setThemeTonePreset: (themeTonePreset) => set({ themeTonePreset }),
      setAccentColor: (color) => set({ accentColor: normalizeHexColor(color) }),
      setCanvasEdgeRoutingMode: (canvasEdgeRoutingMode) =>
        set({ canvasEdgeRoutingMode: normalizeCanvasEdgeRoutingMode(canvasEdgeRoutingMode) }),
      setAutoCheckAppUpdateOnLaunch: (enabled) => set({ autoCheckAppUpdateOnLaunch: enabled }),
      setEnableUpdateDialog: (enabled) => set({ enableUpdateDialog: enabled }),
      addCustomEndpoint: (endpoint) =>
        set((state) => {
          if (state.customEndpoints.some((item) => item.id === endpoint.id)) {
            return state;
          }
          const normalized = normalizeCustomEndpoint(endpoint);
          if (!normalized) return state;
          return { customEndpoints: [...state.customEndpoints, normalized] };
        }),
      updateCustomEndpoint: (id, patch) =>
        set((state) => ({
          customEndpoints: state.customEndpoints.map((item) => {
            if (item.id !== id) return item;
            const normalized = normalizeCustomEndpoint({ ...item, ...patch, id });
            return normalized ?? item;
          }),
        })),
      removeCustomEndpoint: (id) =>
        set((state) => ({
          customEndpoints: state.customEndpoints.filter((item) => item.id !== id),
        })),
      setCustomEndpointModels: (id, models) =>
        set((state) => ({
          customEndpoints: state.customEndpoints.map((item) =>
            item.id === id
              ? { ...item, selectedModels: Array.from(new Set(models)) }
              : item
          ),
        })),
      setAifastJoinChain: (enabled) => set({ aifastJoinChain: enabled }),
      setImageGenMode: (imageGenMode) => set({ imageGenMode: normalizeImageGenMode(imageGenMode) }),
      setImageQuality: (imageQuality) =>
        set({ imageQuality: normalizeImageQuality(imageQuality) }),
      setAutoProbeOnLaunch: (enabled) => set({ autoProbeOnLaunch: enabled }),
      setBackendSyncErrors: (backendSyncErrors) => set({ backendSyncErrors }),
      setOssArchive: (patch) =>
        set((state) => ({
          ossArchive: normalizeOssArchive({ ...state.ossArchive, ...patch }),
        })),
    }),
    {
      name: 'settings-storage',
      version: 22,
      onRehydrateStorage: () => {
        return (state, error) => {
          if (error) {
            console.error('failed to hydrate settings storage', error);
          }
          state?.setHydrated(true);
          // 设置 → Rust 后端同步（baseUrl/自定义接口）。失败不再静默吞掉：
          // 收集进 backendSyncErrors，设置页黄条可见 + 可重试（批次5）。
          void syncBackendSettings({
            juyouapiBaseUrl: state?.juyouapiBaseUrl,
            ollamaBaseUrl: state?.ollamaBaseUrl,
            ollamaModel: state?.ollamaModel,
            customEndpoints: state?.customEndpoints,
            apiKeys: state?.apiKeys,
          }).then((failures) => {
            useSettingsStore.getState().setBackendSyncErrors(failures);
          });
        };
      },
      migrate: migratePersistedSettings,
    }
  )
);
