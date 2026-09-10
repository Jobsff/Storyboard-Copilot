import type { ModelProviderDefinition } from '../types';

export const provider: ModelProviderDefinition = {
  id: 'juyouapi',
  name: '巨游API',
  label: '巨游API',
  // 渠道情报一行定位（源：docs/settings/provider-guide.md）
  advice: { zh: '与 666API 同协议的备用网关', en: 'Backup gateway with the same protocol as 666API' },
};
