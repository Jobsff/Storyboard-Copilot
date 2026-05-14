import {
  generateImage,
  getGenerateImageJob,
  getGenerateVideoJob,
  reversePrompt,
  setApiKey,
  submitGenerateImageJob,
  submitGenerateVideoJob,
} from '@/commands/ai';
import { imageUrlToDataUrl, persistImageLocally } from '@/features/canvas/application/imageData';

import type {
  AiGateway,
  GenerateImagePayload,
  GenerateVideoPayload,
  ReversePromptPayload,
} from '../application/ports';

async function normalizeReferenceImages(payload: GenerateImagePayload): Promise<string[] | undefined> {
  const isKieModel = payload.model.startsWith('kie/');
  const isFalModel = payload.model.startsWith('fal/');
  return payload.referenceImages
    ? await Promise.all(
      payload.referenceImages.map(async (imageUrl) =>
        isKieModel || isFalModel
          ? await imageUrlToDataUrl(imageUrl)
          : await persistImageLocally(imageUrl)
      )
    )
    : undefined;
}

async function normalizeVideoReferenceImages(payload: GenerateVideoPayload): Promise<string[] | undefined> {
  return payload.referenceImages
    ? await Promise.all(payload.referenceImages.map(async (imageUrl) => await imageUrlToDataUrl(imageUrl)))
    : undefined;
}

export const tauriAiGateway: AiGateway = {
  setApiKey,
  generateImage: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);

    return await generateImage({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    });
  },
  submitGenerateImageJob: async (payload: GenerateImagePayload) => {
    const normalizedReferenceImages = await normalizeReferenceImages(payload);
    return await submitGenerateImageJob({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.size,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: payload.extraParams,
    });
  },
  getGenerateImageJob,
  submitGenerateVideoJob: async (payload: GenerateVideoPayload) => {
    const normalizedReferenceImages = await normalizeVideoReferenceImages(payload);
    return await submitGenerateVideoJob({
      prompt: payload.prompt,
      model: payload.model,
      size: payload.quality,
      aspect_ratio: payload.aspectRatio,
      reference_images: normalizedReferenceImages,
      extra_params: {
        ...(payload.extraParams ?? {}),
        durationSeconds: payload.durationSeconds,
        quality: payload.quality,
      },
    });
  },
  getGenerateVideoJob,
  reversePrompt: async (provider: string, payload: ReversePromptPayload) => {
    const normalizedImage = await persistImageLocally(payload.image);
    return await reversePrompt({
      provider,
      image: normalizedImage,
      language: payload.language,
      format: payload.format,
      model: payload.model,
    });
  },
};
