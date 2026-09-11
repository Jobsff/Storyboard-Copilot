import { describe, expect, it } from 'vitest';

import {
  OSS_PROJECT_EXTRA_PARAM_KEY,
  resolveOssProjectParam,
  sanitizeOssProjectName,
} from '@/features/canvas/infrastructure/ossProjectName';

/**
 * 批次11：OSS 归档目录工程名清洗（与 Rust oss_store::sanitize_project_name 同规则）。
 */

describe('ossProjectName', () => {
  it('中文工程名原样保留', () => {
    expect(sanitizeOssProjectName('游戏A')).toBe('游戏A');
  });

  it('斜杠替换为连字符', () => {
    expect(sanitizeOssProjectName('游戏/A')).toBe('游戏-A');
  });

  it('去首尾空白与点号', () => {
    expect(sanitizeOssProjectName('  我的项目 . ')).toBe('我的项目');
    expect(sanitizeOssProjectName('..点号工程..')).toBe('点号工程');
  });

  it('空值 / 空白 / 纯点号 → 无工程上下文（不塞 key，Rust 兜底未分类）', () => {
    expect(resolveOssProjectParam(undefined)).toBeUndefined();
    expect(resolveOssProjectParam(null)).toBeUndefined();
    expect(resolveOssProjectParam('')).toBeUndefined();
    expect(resolveOssProjectParam('   ')).toBeUndefined();
    expect(resolveOssProjectParam(' . ')).toBeUndefined();
  });

  it('正常工程名产出 oss_project 参数', () => {
    expect(resolveOssProjectParam('游戏A')).toBe('游戏A');
    expect(OSS_PROJECT_EXTRA_PARAM_KEY).toBe('oss_project');
  });
});
