import type {
  ImageModelDefinition,
  ImageModelRuntimeContext,
  ModelProviderDefinition,
  ResolutionOption,
} from './types';
import type { CustomEndpoint } from '@/stores/settingsStore';
import { AUTO_PROVIDER_ID } from './image/auto/autoCapabilities';

/**
 * 渠道展示顺序（批次8）：设置页密钥区 / 专家模式供应商 Tab / 渠道健康面板三处统一。
 * grsai → aifast → 666api → juyouapi → agnes → ollama；
 * 隐藏渠道（kie/ppio/fal）与运行时 NEWAPI 接口（newapi_*）排其后。
 * ⚠️ 必须声明在下方 providers 排序之前：sort 在模块求值期调用 compareProvidersByDisplayOrder，
 * const 不提升，放后面会触发 TDZ（v0.3.1 黑屏事故根因，回归锁见 __tests__/registry.boot.test.ts）。
 */
export const PROVIDER_DISPLAY_ORDER = [
  'grsai',
  'aifast',
  '666api',
  'juyouapi',
  'agnes',
  'ollama',
] as const;

const PROVIDER_ORDER_INDEX = new Map<string, number>(
  PROVIDER_DISPLAY_ORDER.map((id, index) => [id, index])
);

// 负向排除 __tests__：模型扫描 glob 会把目录内测试文件当模型模块打进生产包，
// 其 vitest import 在浏览器里直接炸（v0.3.2 二次黑屏根因）。两处 glob 都必须防。
const providerModules = import.meta.glob<{ provider: ModelProviderDefinition }>(
  ['./providers/*.ts', '!./providers/**/__tests__/**'],
  { eager: true }
);
const modelModules = import.meta.glob<{ imageModel: ImageModelDefinition }>(
  ['./image/**/*.ts', '!./image/**/__tests__/**'],
  { eager: true }
);

const providers: ModelProviderDefinition[] = Object.values(providerModules)
  .map((module) => module.provider)
  .filter((provider): provider is ModelProviderDefinition => Boolean(provider))
  .sort((a, b) => compareProvidersByDisplayOrder(a.id, b.id));

const imageModels: ImageModelDefinition[] = Object.values(modelModules)
  .map((module) => module.imageModel)
  .filter((model): model is ImageModelDefinition => Boolean(model))
  .sort((a, b) => a.id.localeCompare(b.id));

const providerMap = new Map<string, ModelProviderDefinition>(
  providers.map((provider) => [provider.id, provider])
);
const imageModelMap = new Map<string, ImageModelDefinition>(
  imageModels.map((model) => [model.id, model])
);

/**
 * 默认生图模型：智能出图 · 标准（虚拟模型，链模式下由 Rust 侧按可用渠道降级执行）。
 * 老用户的 lastUsedImageModel 原样保留（settingsStore 迁移不强制改写）。
 */
export const DEFAULT_IMAGE_MODEL_ID = 'auto/standard';

const HIDDEN_PROVIDERS = new Set(['kie', 'ppio', 'fal']);

/** auto pinned to top (smart image generation) → display order table → runtime NEWAPI endpoints at the bottom → the rest sorted alphabetically by id. */
export function compareProvidersByDisplayOrder(a: string, b: string): number {
  if (a === AUTO_PROVIDER_ID || b === AUTO_PROVIDER_ID) {
    if (a === b) return 0;
    return a === AUTO_PROVIDER_ID ? -1 : 1;
  }
  const aRuntime = a.startsWith('newapi_') ? 1 : 0;
  const bRuntime = b.startsWith('newapi_') ? 1 : 0;
  if (aRuntime !== bRuntime) return aRuntime - bRuntime;
  const aIndex = PROVIDER_ORDER_INDEX.get(a);
  const bIndex = PROVIDER_ORDER_INDEX.get(b);
  if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
  if (aIndex !== undefined) return -1;
  if (bIndex !== undefined) return 1;
  return a.localeCompare(b);
}

/**
 * 虚拟供应商：只作为智能出图模型的归属 tab（模型列表经 listImageModels 正常返回），
 * 不出现在"渠道供应商"列表（listModelProviders）——设置页密钥配置与 key 统计只面向真实渠道。
 */
const VIRTUAL_PROVIDER_IDS = new Set<string>([AUTO_PROVIDER_ID]);

const imageModelAliasMap = new Map<string, string>([
  ['gemini-3.1-flash', 'ppio/gemini-3.1-flash'],
  ['gemini-3.1-flash-edit', 'ppio/gemini-3.1-flash'],
]);

// --- Runtime custom-endpoint (NEWAPI-compatible) registration -----------------

/**
 * Runtime registry of providers/models contributed by user-defined NEWAPI-compatible
 * endpoints. These are merged with the statically-globbed definitions above.
 */
const runtimeProviders = new Map<string, ModelProviderDefinition>();
const runtimeImageModels = new Map<string, ImageModelDefinition>();
/** Track which runtime models belong to which endpoint id (for clean removal). */
const runtimeModelsByEndpoint = new Map<string, Set<string>>();

const RUNTIME_DEFAULT_ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
];

const RUNTIME_GEMINI_ASPECT_RATIOS = [
  { value: '1:1', label: '1:1' },
  { value: '1:4', label: '1:4' },
  { value: '1:8', label: '1:8' },
  { value: '9:16', label: '9:16' },
  { value: '16:9', label: '16:9' },
  { value: '3:4', label: '3:4' },
  { value: '4:3', label: '4:3' },
  { value: '4:1', label: '4:1' },
  { value: '8:1', label: '8:1' },
  { value: '2:3', label: '2:3' },
  { value: '3:2', label: '3:2' },
  { value: '5:4', label: '5:4' },
  { value: '4:5', label: '4:5' },
  { value: '21:9', label: '21:9' },
];

const RUNTIME_GEMINI_RESOLUTIONS: ResolutionOption[] = [
  { value: '0.5K', label: '0.5K' },
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

const RUNTIME_GPT_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

/**
 * Build a static-ish ImageModelDefinition for a model offered by a custom endpoint.
 * The request format is dispatched by the Rust backend based on the model name
 * (gemini-* -> OpenAI chat completions, gpt-image-* -> images API), so we only need
 * to provide reasonable aspect-ratio / resolution option templates.
 */
function buildRuntimeImageModel(
  endpoint: CustomEndpoint,
  modelName: string
): ImageModelDefinition {
  const id = `${endpoint.id}/${modelName}`;
  const isGemini = modelName.startsWith('gemini-');
  const isGptImage = modelName.startsWith('gpt-image-');

  const aspectRatios = isGemini || isGptImage
    ? RUNTIME_GEMINI_ASPECT_RATIOS
    : RUNTIME_DEFAULT_ASPECT_RATIOS;
  const resolutions = isGptImage
    ? RUNTIME_GPT_RESOLUTIONS
    : RUNTIME_GEMINI_RESOLUTIONS;

  return {
    id,
    mediaType: 'image',
    displayName: modelName,
    providerId: endpoint.id,
    description: `${endpoint.name} · ${modelName}`,
    eta: '1min',
    expectedDurationMs: 80000,
    defaultAspectRatio: '1:1',
    defaultResolution: isGptImage ? '2K' : '1K',
    aspectRatios,
    resolutions,
    resolveRequest: ({ referenceImageCount }) => ({
      requestModel: id,
      modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
    }),
  };
}

/** Register (or refresh) all selected models for a custom endpoint. */
export function registerRuntimeEndpoint(endpoint: CustomEndpoint): void {
  // Remove previously registered models for this endpoint first (refresh case).
  unregisterRuntimeEndpoint(endpoint.id);

  const provider: ModelProviderDefinition = {
    id: endpoint.id,
    name: endpoint.name || endpoint.id,
    label: endpoint.name || endpoint.id,
  };
  runtimeProviders.set(endpoint.id, provider);

  const ownedIds = new Set<string>();
  for (const modelName of endpoint.selectedModels) {
    const model = buildRuntimeImageModel(endpoint, modelName);
    runtimeImageModels.set(model.id, model);
    ownedIds.add(model.id);
  }
  runtimeModelsByEndpoint.set(endpoint.id, ownedIds);
}

/** Remove all models + the provider contributed by a custom endpoint. */
export function unregisterRuntimeEndpoint(endpointId: string): void {
  const ownedIds = runtimeModelsByEndpoint.get(endpointId);
  if (ownedIds) {
    ownedIds.forEach((id) => runtimeImageModels.delete(id));
    runtimeModelsByEndpoint.delete(endpointId);
  }
  runtimeProviders.delete(endpointId);
}

/**
 * Reconcile the runtime registry against the current persisted custom endpoints.
 * Removes endpoints no longer present and (re)registers all current ones. Safe to
 * call repeatedly (idempotent). Should be invoked on app mount and whenever the
 * store's customEndpoints change.
 *
 * 批次9：aifast 改静态清单（models/image/aifast/），运行时注册路径退役——
 * 此函数只管 newapi_* 端点。
 */
export function syncCustomEndpointsFromStore(endpoints: CustomEndpoint[]): void {
  const storeIds = new Set(endpoints.map((e) => e.id));
  // Remove runtime endpoints that are no longer in the store.
  for (const id of Array.from(runtimeModelsByEndpoint.keys())) {
    if (!storeIds.has(id)) {
      unregisterRuntimeEndpoint(id);
    }
  }
  // (Re)register all current endpoints.
  for (const endpoint of endpoints) {
    if (endpoint.baseUrl && endpoint.selectedModels.length > 0) {
      registerRuntimeEndpoint(endpoint);
    }
  }
}

// --- Public API --------------------------------------------------------------

export function listImageModels(): ImageModelDefinition[] {
  const staticModels = imageModels.filter((m) => !HIDDEN_PROVIDERS.has(m.providerId));
  const runtime = Array.from(runtimeImageModels.values());
  return [...staticModels, ...runtime].sort((a, b) => a.id.localeCompare(b.id));
}

export function listModelProviders(): ModelProviderDefinition[] {
  const staticProviders = providers.filter(
    (p) => !HIDDEN_PROVIDERS.has(p.id) && !VIRTUAL_PROVIDER_IDS.has(p.id)
  );
  const runtime = Array.from(runtimeProviders.values());
  return [...staticProviders, ...runtime].sort((a, b) =>
    compareProvidersByDisplayOrder(a.id, b.id)
  );
}

export function getImageModel(modelId: string): ImageModelDefinition {
  const resolvedModelId = imageModelAliasMap.get(modelId) ?? modelId;
  return (
    runtimeImageModels.get(resolvedModelId) ??
    imageModelMap.get(resolvedModelId) ??
    imageModelMap.get(DEFAULT_IMAGE_MODEL_ID)!
  );
}

export function resolveImageModelResolutions(
  model: ImageModelDefinition,
  context: ImageModelRuntimeContext = {}
): ResolutionOption[] {
  const resolvedOptions = model.resolveResolutions?.(context);
  return resolvedOptions && resolvedOptions.length > 0 ? resolvedOptions : model.resolutions;
}

export function resolveImageModelResolution(
  model: ImageModelDefinition,
  requestedResolution: string | undefined,
  context: ImageModelRuntimeContext = {}
): ResolutionOption {
  const resolutionOptions = resolveImageModelResolutions(model, context);

  return (
    (requestedResolution
      ? resolutionOptions.find((item) => item.value === requestedResolution)
      : undefined) ??
    resolutionOptions.find((item) => item.value === model.defaultResolution) ??
    resolutionOptions[0] ??
    model.resolutions[0]
  );
}

export function getModelProvider(providerId: string): ModelProviderDefinition {
  return (
    runtimeProviders.get(providerId) ??
    providerMap.get(providerId) ?? {
      id: 'unknown',
      name: 'Unknown Provider',
      label: 'Unknown',
    }
  );
}
