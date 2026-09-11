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
import { useProjectStore } from '@/stores/projectStore';
import { OSS_PROJECT_EXTRA_PARAM_KEY, resolveOssProjectParam } from './ossProjectName';

import type {
  AiGateway,
  GenerateImagePayload,
  GenerateVideoPayload,
  ReversePromptPayload,
} from '../application/ports';

/**
 * 公司 OSS 归档（批次11）：提交入口统一注入当前工程名（extra_params.oss_project），
 * 归档按工程名分目录。无工程上下文（Toolbox 页）不塞，Rust 兜底「未分类」。
 */
function withOssProject(
  extraParams: Record<string, unknown> | undefined
): Record<string, unknown> {
  const projectName = useProjectStore.getState().currentProject?.name;
  const ossProject = resolveOssProjectParam(projectName);
  if (!ossProject) {
    return extraParams ?? {};
  }
  return {
    ...(extraParams ?? {}),
    [OSS_PROJECT_EXTRA_PARAM_KEY]: ossProject,
  };
}

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
      extra_params: withOssProject(payload.extraParams),
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
      extra_params: withOssProject(payload.extraParams),
      fallback: payload.fallback
        ? {
          quality: payload.fallback.quality,
          available_providers: payload.fallback.availableProviders,
          extra_hops: payload.fallback.extraHops,
        }
        : undefined,
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
      extra_params: withOssProject({
        ...(payload.extraParams ?? {}),
        durationSeconds: payload.durationSeconds,
        quality: payload.quality,
      }),
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
