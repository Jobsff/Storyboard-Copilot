import type { ModelProviderDefinition } from '../types';

export const provider: ModelProviderDefinition = {
  id: 'ollama',
  name: 'Ollama',
  label: 'Ollama',
  // 渠道情报一行定位（源：docs/settings/provider-guide.md）
  advice: { zh: '本地部署，隐私优先，零 API 费用', en: 'Local deployment, privacy-first, zero API cost' },
};
