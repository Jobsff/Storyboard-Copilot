import type { ModelProviderDefinition } from '../types';

/**
 * aifast：企业级 NEWAPI 中转站（批次8 新增预置槽位；批次9 起模型改静态清单）。
 * base 固定 https://picture.aifast.site（Rust 侧 new_with_config 注册，不可改）；
 * 密钥存通用 apiKeys['aifast']，7 个实测模型开箱即用（models/image/aifast/）。
 */
export const provider: ModelProviderDefinition = {
  id: 'aifast',
  name: 'aifast',
  label: 'aifast',
  advice: {
    zh: '企业级 NEWAPI 中转站，7 个实测模型开箱即用、稳定（价格偏高）',
    en: 'Enterprise-grade NEWAPI gateway: 7 curated models out of the box, stable (pricier)',
  },
};
