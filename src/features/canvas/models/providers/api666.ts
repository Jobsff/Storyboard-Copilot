import type { ModelProviderDefinition } from '../types';

export const provider: ModelProviderDefinition = {
  id: '666api',
  name: '666API',
  label: '666API',
};

export const API666_KEY_GROUPS = [
  { id: '666api_gemini', label: 'Gemini', labelZh: 'Gemini 模型' },
  { id: '666api_gpt', label: 'GPT', labelZh: 'GPT 模型' },
  { id: '666api_claude', label: 'Claude', labelZh: 'Claude 模型' },
  { id: '666api_default', label: 'Default', labelZh: '默认（其他模型）' },
] as const;

export function resolve666ApiKeyId(model: string): string {
  const name = model.startsWith('666api/') ? model.slice(7) : model;
  if (name.startsWith('gemini-')) return '666api_gemini';
  if (name.startsWith('gpt-')) return '666api_gpt';
  if (name.startsWith('claude-')) return '666api_claude';
  return '666api_default';
}

export function resolve666ApiKey(
  model: string,
  apiKeys: Record<string, string>,
): string | undefined {
  const keyId = resolve666ApiKeyId(model);
  return apiKeys[keyId] || apiKeys['666api_default'] || undefined;
}

export function resolve666ReversePromptKeyId(format?: string, language?: string): string {
  if (format === 'json') return '666api_default';
  if (language === 'en') return '666api_gemini';
  return '666api_default';
}
