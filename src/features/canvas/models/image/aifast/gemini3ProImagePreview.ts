import { createAifastGeminiModel } from './factory';

export const imageModel = createAifastGeminiModel(
  'gemini-3-pro-image-preview',
  'Gemini 3 Pro Image',
  'aifast 企业渠道 Gemini 3 Pro',
);
