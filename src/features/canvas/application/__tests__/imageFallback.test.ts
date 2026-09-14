import { describe, expect, it } from 'vitest';

import { buildAutoImageFallback, CHAIN_MEMBER_MODEL_NAMES } from '../imageFallback';
import {
  AUTO_GPT_PRO_IMAGE_MODEL_ID,
  AUTO_GPT_STANDARD_IMAGE_MODEL_ID,
  AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID,
  AUTO_PRO_IMAGE_MODEL_ID,
  AUTO_STANDARD_IMAGE_MODEL_ID,
  resolveAutoImageQuality,
} from '../../models/image/auto/autoCapabilities';

describe('resolveAutoImageQuality 五值映射', () => {
  it('精确映射五个 auto 模型 id', () => {
    expect(resolveAutoImageQuality(AUTO_STANDARD_IMAGE_MODEL_ID)).toBe('standard');
    expect(resolveAutoImageQuality(AUTO_PRO_IMAGE_MODEL_ID)).toBe('pro');
    expect(resolveAutoImageQuality(AUTO_GPT_STANDARD_IMAGE_MODEL_ID)).toBe('gpt-standard');
    expect(resolveAutoImageQuality(AUTO_GPT_PRO_IMAGE_MODEL_ID)).toBe('gpt-pro');
    expect(resolveAutoImageQuality(AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID)).toBe('gpt-transparent');
  });

  it('未知值兜底 standard', () => {
    expect(resolveAutoImageQuality('auto/unknown')).toBe('standard');
    expect(resolveAutoImageQuality('')).toBe('standard');
    expect(resolveAutoImageQuality('grsai/nano-banana-2')).toBe('standard');
  });
});

describe('CHAIN_MEMBER_MODEL_NAMES（批次13 R5）', () => {
  it('包含 GPT 系三个新链成员裸模型名', () => {
    expect(CHAIN_MEMBER_MODEL_NAMES.has('gpt-image-2')).toBe(true);
    expect(CHAIN_MEMBER_MODEL_NAMES.has('gpt-image-2.5-flare')).toBe(true);
    expect(CHAIN_MEMBER_MODEL_NAMES.has('gpt-image-2.5-sunburst')).toBe(true);
  });
});

describe('buildAutoImageFallback 空链防护档位化（批次13 R3）', () => {
  it('只配 kie key → GPT 三档位全部 null（kie 不在 GPT 链渠道内）', () => {
    const apiKeys = { kie: 'test-key' };
    expect(buildAutoImageFallback(AUTO_GPT_STANDARD_IMAGE_MODEL_ID, apiKeys)).toBeNull();
    expect(buildAutoImageFallback(AUTO_GPT_PRO_IMAGE_MODEL_ID, apiKeys)).toBeNull();
    expect(buildAutoImageFallback(AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID, apiKeys)).toBeNull();
  });

  it('只配 grsai key → GPT 全档位非 null', () => {
    const apiKeys = { grsai: 'test-key' };
    for (const modelId of [
      AUTO_GPT_STANDARD_IMAGE_MODEL_ID,
      AUTO_GPT_PRO_IMAGE_MODEL_ID,
      AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID,
    ]) {
      const fallback = buildAutoImageFallback(modelId, apiKeys);
      expect(fallback).not.toBeNull();
      expect(fallback?.availableProviders).toEqual(['grsai']);
    }
  });

  it('gpt-standard / gpt-pro 只认 grsai（666api/juyouapi 有 key 也不入交）', () => {
    const apiKeys = { '666api_default': 'test-key', juyouapi: 'test-key' };
    expect(buildAutoImageFallback(AUTO_GPT_STANDARD_IMAGE_MODEL_ID, apiKeys)).toBeNull();
    expect(buildAutoImageFallback(AUTO_GPT_PRO_IMAGE_MODEL_ID, apiKeys)).toBeNull();
    // gpt-transparent 三渠道：666api/juyouapi 有 key 即可成链
    const fallback = buildAutoImageFallback(AUTO_GPT_TRANSPARENT_IMAGE_MODEL_ID, apiKeys);
    expect(fallback).not.toBeNull();
    expect(fallback?.availableProviders).toEqual(['666api', 'juyouapi']);
    expect(fallback?.quality).toBe('gpt-transparent');
  });

  it('Gemini 档位行为不变：五渠道全集求交（只配 kie 也非 null）', () => {
    const apiKeys = { kie: 'test-key' };
    const fallback = buildAutoImageFallback(AUTO_STANDARD_IMAGE_MODEL_ID, apiKeys);
    expect(fallback).not.toBeNull();
    expect(fallback?.quality).toBe('standard');
    expect(fallback?.availableProviders).toEqual(['kie']);
  });

  it('Gemini 档位五渠道顺序保持 CHAIN_PROVIDER_IDS 原序', () => {
    const apiKeys = {
      kie: 'k',
      juyouapi: 'k',
      grsai: 'k',
      aifast: 'k',
      '666api_default': 'k',
    };
    const fallback = buildAutoImageFallback(AUTO_PRO_IMAGE_MODEL_ID, apiKeys);
    expect(fallback?.quality).toBe('pro');
    expect(fallback?.availableProviders).toEqual(['grsai', 'aifast', '666api', 'juyouapi', 'kie']);
  });
});
