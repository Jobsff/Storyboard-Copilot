import { createAifastGeminiModel } from './factory';

export const imageModel = createAifastGeminiModel(
  'gemini-3.1-flash-lite-image',
  'Gemini 3.1 Flash Lite',
  'aifast 企业渠道 Gemini 3.1 Flash Lite（轻量快速）',
);
