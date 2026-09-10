import { createAifastGeminiModel } from './factory';

export const imageModel = createAifastGeminiModel(
  'gemini-3.1-flash-image-preview-token',
  'Gemini 3.1 Flash Image · token 线',
  'aifast 企业渠道 Gemini 3.1 Flash（token 计费线）',
);
