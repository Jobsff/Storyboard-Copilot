import { describe, expect, it } from 'vitest';

import {
  classifyErrorClass,
  normalizeErrorClass,
  resolveErrorAdvice,
  resolveProviderRechargeUrl,
} from '../errorAdvice';

describe('classifyErrorClass · 与 Rust error_classify 对齐的关键词兜底', () => {
  it('timeout 规则（含中文"超时"）', () => {
    expect(classifyErrorClass('operation timed out')).toBe('timeout');
    expect(classifyErrorClass('request timeout after 300s')).toBe('timeout');
    expect(classifyErrorClass('渠道响应超时（已等待 10 分钟）')).toBe('timeout');
  });

  it('channel_down 规则', () => {
    expect(classifyErrorClass('error trying to connect: dns error')).toBe('channel_down');
    expect(classifyErrorClass('KIE createTask failed 502 Bad Gateway')).toBe('channel_down');
    expect(classifyErrorClass('upstream service unavailable')).toBe('channel_down');
  });

  it('auth 规则', () => {
    expect(classifyErrorClass('OpenAI API error: 401 Unauthorized')).toBe('auth');
    expect(classifyErrorClass('invalid api key provided')).toBe('auth');
  });

  it('quota 规则', () => {
    expect(classifyErrorClass('429 Too Many Requests')).toBe('quota');
    expect(classifyErrorClass('账户余额不足')).toBe('quota');
  });

  it('content_filter 规则', () => {
    expect(classifyErrorClass('request blocked by content policy')).toBe('content_filter');
    expect(classifyErrorClass('提示包含敏感内容')).toBe('content_filter');
  });

  it('数字状态码优先于 5xx 判定（与 Rust 短路序一致）', () => {
    expect(classifyErrorClass('402 payment required')).toBe('quota');
    expect(classifyErrorClass('HTTP 403 forbidden by upstream')).toBe('auth');
  });

  it('未知与空串归 unknown', () => {
    expect(classifyErrorClass('something odd happened')).toBe('unknown');
    expect(classifyErrorClass('')).toBe('unknown');
  });
});

describe('resolveErrorAdvice · class -> 行动建议', () => {
  it('显式 error_class 优先，不做关键词推断', () => {
    const advice = resolveErrorAdvice({ errorClass: 'auth', message: '渠道响应超时' });
    expect(advice.errorClass).toBe('auth');
    expect(advice.titleKey).toBe('errorAdvice.title.auth');
  });

  it('error_class 缺失时用关键词兜底', () => {
    const advice = resolveErrorAdvice({ message: '生成超时（任务已运行超过 15 分钟）' });
    expect(advice.errorClass).toBe('timeout');
    expect(advice.titleKey).toBe('errorAdvice.title.timeout');
  });

  it('timeout：链内与单点文案不同', () => {
    const chain = resolveErrorAdvice({ errorClass: 'timeout', isChain: true });
    const single = resolveErrorAdvice({ errorClass: 'timeout', isChain: false });
    expect(chain.bodyKey).toBe('errorAdvice.body.timeoutChain');
    expect(single.bodyKey).toBe('errorAdvice.body.timeoutSingle');
  });

  it('auth：带打开设置动作', () => {
    const advice = resolveErrorAdvice({ errorClass: 'auth' });
    expect(advice.actions).toEqual([
      { kind: 'openSettings', labelKey: 'errorAdvice.action.openSettings' },
    ]);
  });

  it('quota：有渠道时给充值链接，无渠道时退化为设置入口', () => {
    const withProvider = resolveErrorAdvice({ errorClass: 'quota', providerId: '666api' });
    expect(withProvider.actions[0]).toEqual({
      kind: 'openUrl',
      labelKey: 'errorAdvice.action.recharge',
      url: 'https://www.666api.ai',
    });

    const withoutProvider = resolveErrorAdvice({ errorClass: 'quota' });
    expect(withoutProvider.actions.some((action) => action.kind === 'openUrl')).toBe(false);
    expect(withoutProvider.actions.some((action) => action.kind === 'openSettings')).toBe(true);
  });

  it('content_filter：仅当调用方可重试时给 [重试] 动作', () => {
    const retryable = resolveErrorAdvice({ errorClass: 'content_filter', canRetry: true });
    expect(retryable.actions.some((action) => action.kind === 'retry')).toBe(true);
    const nonRetryable = resolveErrorAdvice({ errorClass: 'content_filter' });
    expect(nonRetryable.actions).toEqual([]);
  });

  it('channel_down / unknown：channel_down 给 [检测所有渠道]，unknown 纯文案', () => {
    const channelDown = resolveErrorAdvice({ errorClass: 'channel_down' });
    expect(channelDown.actions).toEqual([
      { kind: 'probeChannels', labelKey: 'errorAdvice.action.probeChannels' },
    ]);
    expect(channelDown.bodyKey).toBe('errorAdvice.body.channelDown');
    expect(resolveErrorAdvice({ errorClass: 'unknown' }).titleKey).toBe(
      'errorAdvice.title.unknown'
    );
    expect(resolveErrorAdvice({ errorClass: 'unknown' }).actions).toEqual([]);
  });

  it('timeout：带 [检测所有渠道]；canRetry 时追加 [重试]', () => {
    const base = resolveErrorAdvice({ errorClass: 'timeout', isChain: true });
    expect(base.actions).toEqual([
      { kind: 'probeChannels', labelKey: 'errorAdvice.action.probeChannels' },
    ]);
    const retryable = resolveErrorAdvice({ errorClass: 'timeout', canRetry: true });
    expect(retryable.actions).toEqual([
      { kind: 'probeChannels', labelKey: 'errorAdvice.action.probeChannels' },
      { kind: 'retry', labelKey: 'errorAdvice.action.retry' },
    ]);
  });

  it('非法 error_class 值按缺失处理', () => {
    expect(normalizeErrorClass('weird')).toBeNull();
    const advice = resolveErrorAdvice({ errorClass: 'weird', message: '402 payment required' });
    expect(advice.errorClass).toBe('quota');
  });
});

describe('resolveProviderRechargeUrl · 四链渠道充值链接', () => {
  it('覆盖 666api / grsai / juyouapi / kie', () => {
    expect(resolveProviderRechargeUrl('666api')).toMatch(/^https?:\/\//);
    expect(resolveProviderRechargeUrl('grsai')).toMatch(/^https?:\/\//);
    expect(resolveProviderRechargeUrl('juyouapi')).toMatch(/^https?:\/\//);
    expect(resolveProviderRechargeUrl('kie')).toMatch(/^https?:\/\//);
  });

  it('未知渠道返回 undefined', () => {
    expect(resolveProviderRechargeUrl('newapi_xyz')).toBeUndefined();
    expect(resolveProviderRechargeUrl(null)).toBeUndefined();
  });
});
