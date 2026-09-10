/**
 * aifast 固定模型清单（批次9：静态写死，去掉获取勾选）。
 * 源：image-studio 技能 .env 实测注释（企业渠道，7 个开箱即用）。
 * 2026-09-11 真实 key smoke 实证修正（批次9 补丁）：gpt-image-2 经 /v1/images/generations
 * 返回 503 model_not_found（上游 /v1/models 列表与可调性一一对应）→ 移除；
 * gemini-3.1-flash-image（无后缀）经 chat-completions 实测 200 出图 → 复活加回。
 * 排列顺序即任务书指定顺序（token 线排首位；flash 组内 preview 系 → 无后缀 → lite）；
 * 实际展示顺序由 registry/UI 排序决定。定价不设（宁缺毋错）。
 */
export const AIFAST_MODEL_NAMES = [
  'gemini-3-pro-image-preview-token',
  'gemini-3-pro-image-preview',
  'gemini-3-pro-image-preview-hy',
  'gemini-3.1-flash-image-preview-token',
  'gemini-3.1-flash-image-preview-hy',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-lite-image',
] as const;

export type AifastModelName = (typeof AIFAST_MODEL_NAMES)[number];
