/**
 * 启动期模块图冒烟测试（批次8 黑屏回归锁）。
 *
 * 背景：registry.ts 曾在模块求值期调用 compareProvidersByDisplayOrder 排序，
 * 而其引用的 PROVIDER_ORDER_INDEX 声明在调用点之后（const 不提升，函数提升），
 * 生产 bundle 抛 "Cannot access ... before initialization" 导致 React 无法挂载（黑屏）。
 * 单测此前只覆盖纯函数模块、从未执行 registry 模块图，故未拦住。
 * 本测试在 node 环境真实执行完整模块图（vitest 原生支持 import.meta.glob），
 * 任何顶层求值期异常都会在此红灯，而不是到用户桌面上黑屏。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const localStorageStub = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  };
})();

describe('registry 模块图启动冒烟', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', localStorageStub);
  });

  it('registry 模块图可在无浏览器环境完整求值（不抛 TDZ/启动异常）', async () => {
    const registry = await import('../registry');
    expect(registry.DEFAULT_IMAGE_MODEL_ID).toBe('auto/standard');
  });

  it('渠道展示顺序：grsai 打头，其后 aifast → 666api → 巨游 → agnes → ollama', async () => {
    const registry = await import('../registry');
    const ids = registry.listModelProviders().map((provider) => provider.id);
    expect(ids.indexOf('grsai')).toBe(0);
    expect(ids.indexOf('aifast')).toBe(1);
    expect(ids.indexOf('666api')).toBe(2);
    expect(ids.indexOf('juyouapi')).toBe(3);
    expect(ids.indexOf('agnes')).toBe(4);
    expect(ids.indexOf('ollama')).toBe(5);
  });
});
