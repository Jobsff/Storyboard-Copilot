export const TRANSPARENT_BACKGROUND_EXTRA_PARAM_KEY = 'transparent_background';

const TRANSPARENT_BACKGROUND_PROMPT_HINT =
  '背景要求：输出带有 Alpha 通道的 PNG，背景完全透明（alpha=0）';

export function applyTransparentBackgroundHint(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;

  const normalized = trimmed.toLowerCase();
  if (
    normalized.includes('透明背景') ||
    normalized.includes('alpha=0') ||
    normalized.includes('alpha = 0') ||
    normalized.includes('alpha通道') ||
    normalized.includes('alpha 通道') ||
    normalized.includes('alpha channel') ||
    normalized.includes('带有 alpha 通道') ||
    normalized.includes('transparent background') ||
    normalized.includes('background transparent')
  ) {
    return trimmed;
  }

  return `${trimmed}\n${TRANSPARENT_BACKGROUND_PROMPT_HINT}`;
}
