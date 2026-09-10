import type { ModelProviderDefinition } from '../types';

export const GRSAI_NANO_BANANA_PRO_MODEL_OPTIONS = [
  'nano-banana-pro',
  'nano-banana-pro-vt',
  'nano-banana-pro-cl',
  'nano-banana-pro-vip',
  'nano-banana-pro-4k-vip',
] as const;

export const provider: ModelProviderDefinition = {
  id: 'grsai',
  name: 'GRSAI',
  label: 'GRSAI',
  // 渠道情报一行定位（源：docs/settings/provider-guide.md）
  advice: { zh: '最便宜；渠道波动时智能出图会自动兜底换渠道', en: 'Cheapest; Smart Generate auto-falls-back to other channels when it fluctuates' },
};

