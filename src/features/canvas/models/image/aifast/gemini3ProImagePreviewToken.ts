import { createAifastGeminiModel } from './factory';

export const imageModel = createAifastGeminiModel(
  'gemini-3-pro-image-preview-token',
  'Gemini 3 Pro Image · token 线',
  'aifast 企业渠道 Gemini 3 Pro（token 计费线，实测稳定）',
);
