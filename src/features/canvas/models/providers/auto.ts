import type { ModelProviderDefinition } from '../types';
import { AUTO_PROVIDER_ID } from '../image/auto/autoCapabilities';

/**
 * 智能出图（虚拟供应商）：仅作为 auto/standard、auto/pro 两个虚拟模型的归属 tab，
 * 不对应任何真实渠道；实际渠道在提交时由降级链按可用 key 现算。
 */
export const provider: ModelProviderDefinition = {
  id: AUTO_PROVIDER_ID,
  name: '智能出图',
  label: '智能出图',
  // 渠道情报一行定位（源：docs/settings/provider-guide.md）
  advice: { zh: '自动避开故障渠道，价格优先选路', en: 'Auto-avoids failing channels with price-first routing' },
};
