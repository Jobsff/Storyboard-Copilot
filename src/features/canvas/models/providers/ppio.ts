import type { ModelProviderDefinition } from '../types';

export const provider: ModelProviderDefinition = {
  id: 'ppio',
  name: 'PPIO',
  label: '派欧云',
  // 渠道情报一行定位（源：docs/settings/provider-guide.md）
  advice: { zh: '价格优惠少但稳定，仅支持 Nano Banana 2', en: 'Stable with few discounts; Nano Banana 2 only' },
};
