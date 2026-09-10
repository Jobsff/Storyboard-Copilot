import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AIFAST_MODEL_NAMES } from '../modelNames';
import { provider as aifastProvider } from '../../../providers/aifast';

const localStorageStub = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
})();

/**
 * 批次9：aifast 静态清单回归锁。
 * 锁三件事：清单与静态模型文件一一对应、已下架模型绝不回流、无定价（宁缺毋错）。
 * 批次9 补丁（2026-09-11 真实 key smoke 实证）：下架 gpt-image-2（503 model_not_found），
 * 复活 gemini-3.1-flash-image（无后缀，chat-completions 200 出图）。
 */
describe('aifast 静态清单（批次9）', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageStub);
  });

  it('清单恰好 7 个模型，顺序与任务书一致（token 线排首位，flash 组内 preview 系 → 无后缀 → lite）', () => {
    expect([...AIFAST_MODEL_NAMES]).toEqual([
      'gemini-3-pro-image-preview-token',
      'gemini-3-pro-image-preview',
      'gemini-3-pro-image-preview-hy',
      'gemini-3.1-flash-image-preview-token',
      'gemini-3.1-flash-image-preview-hy',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
    ]);
  });

  it('registry 中 aifast 静态模型与清单一一对应（无缺失、无多余）', async () => {
    const registry = await import('../../../registry');
    const aifastModels = registry
      .listImageModels()
      .filter((model) => model.providerId === 'aifast')
      .map((model) => model.id.split('/')[1]);
    expect([...aifastModels].sort()).toEqual([...AIFAST_MODEL_NAMES].sort());
  });

  it('已下架的 gpt-image-2（503 model_not_found）绝不在 aifast 清单', async () => {
    const registry = await import('../../../registry');
    const ids = registry.listImageModels().map((model) => model.id);
    expect(ids).not.toContain('aifast/gpt-image-2');
  });

  it('aifast 静态模型一律不设定价（宁缺毋错）', async () => {
    const registry = await import('../../../registry');
    const aifastModels = registry.listImageModels().filter((model) => model.providerId === 'aifast');
    expect(aifastModels.length).toBeGreaterThan(0);
    for (const model of aifastModels) {
      expect(model.pricing).toBeUndefined();
    }
  });

  it('provider 定义存在且 id/label 正确（专家模式 Tab 供应商名）', () => {
    expect(aifastProvider.id).toBe('aifast');
    expect(aifastProvider.label).toBe('aifast');
  });
});
