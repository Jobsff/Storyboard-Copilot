import { openGlobalErrorDialog } from '@/features/app/errorDialogEvents';
import { openSettingsDialog } from '@/features/settings/settingsEvents';

/**
 * 错误行动化（渠道可靠性升级 · 模块 F 前端主体）。
 *
 * - classifyErrorClass：error_class 缺失时（老错误串/本地 invoke 错误）的关键词兜底分类，
 *   规则与 Rust ai/error_classify.rs 逐条对齐（顺序短路，数字码先于 5xx 判定）。
 * - resolveErrorAdvice：class -> { title, body, actions } 人话建议映射（i18n key），
 *   供失败对话框渲染行动按钮；原文始终折叠进「详细信息」，复制报告能力保留。
 * - 关键词规则修改时需同步修改 src-tauri/src/ai/error_classify.rs（双向注释）。
 */

export type ImageErrorClass =
  | 'timeout'
  | 'channel_down'
  | 'auth'
  | 'quota'
  | 'content_filter'
  | 'unknown';

const TIMEOUT_RULES = ['timeout', 'timed out', 'deadline', 'elapsed', '超时'] as const;
const AUTH_RULES = [
  '401',
  '403',
  'unauthorized',
  'forbidden',
  'invalid api key',
  'invalid_api_key',
  'authentication',
] as const;
const QUOTA_RULES = ['402', '429', 'insufficient', 'balance', 'quota', '余额', '额度'] as const;
const CONTENT_FILTER_RULES = [
  'safety',
  'blocked',
  'prohibited',
  'content policy',
  '安全',
  '敏感',
] as const;
const CHANNEL_DOWN_RULES = [
  'connect',
  'dns',
  'connection refused',
  '502',
  '503',
  '504',
  '524',
  '500',
  'internal server error',
  'bad gateway',
  'service unavailable',
  'upstream',
  'network',
] as const;

function matchesAny(lowered: string, rules: readonly string[]): boolean {
  return rules.some((rule) => lowered.includes(rule));
}

/** 与 Rust error_classify 同序短路的轻量兜底分类（仅前端本地错误串使用）。 */
export function classifyErrorClass(message: string): ImageErrorClass {
  const lowered = (message || '').toLowerCase();

  if (matchesAny(lowered, TIMEOUT_RULES)) {
    return 'timeout';
  }
  if (matchesAny(lowered, AUTH_RULES)) {
    return 'auth';
  }
  if (matchesAny(lowered, QUOTA_RULES)) {
    return 'quota';
  }
  if (matchesAny(lowered, CONTENT_FILTER_RULES)) {
    return 'content_filter';
  }
  if (matchesAny(lowered, CHANNEL_DOWN_RULES)) {
    return 'channel_down';
  }
  return 'unknown';
}

/** 渠道 → 充值/控制台链接（源自 docs/settings/provider-guide.md 的渠道情报）。 */
export const PROVIDER_RECHARGE_URLS: Record<string, string> = {
  '666api': 'https://www.666api.ai',
  grsai: 'https://grsai.com',
  juyouapi: 'https://api.juyou.ai',
  kie: 'https://kie.ai',
  ppio: 'https://ppio.com',
  fal: 'https://fal.ai',
  agnes: 'https://agnes-ai.com',
};

export function resolveProviderRechargeUrl(providerId: string | undefined | null): string | undefined {
  if (!providerId) {
    return undefined;
  }
  return PROVIDER_RECHARGE_URLS[providerId];
}

export interface ErrorAdviceAction {
  kind: 'openSettings' | 'openUrl' | 'retry' | 'probeChannels';
  /** i18n key（errorAdvice.action.*）。 */
  labelKey: string;
  /** openUrl 时的目标链接。 */
  url?: string;
}

export interface ErrorAdvice {
  errorClass: ImageErrorClass;
  /** i18n key（errorAdvice.title.*）。 */
  titleKey: string;
  /** i18n key（errorAdvice.body.*）。 */
  bodyKey: string;
  actions: ErrorAdviceAction[];
}

export interface ErrorAdviceContext {
  /** Rust DTO 透出的 error_class；缺失时用 message 关键词兜底。 */
  errorClass?: string | null;
  message?: string | null;
  /** 出错渠道（quota 去充值链接用）。 */
  providerId?: string | null;
  /** 是否链任务（auto/* 模型）：timeout 文案区分链内/单点。 */
  isChain?: boolean;
  /** 调用方能否提供"重试"闭包（ImageEditNode 提交路径可，轮询路径不可）。 */
  canRetry?: boolean;
}

/** 归一 error_class（Rust 枚举名），非法值按缺失处理走关键词兜底。 */
export function normalizeErrorClass(value: string | null | undefined): ImageErrorClass | null {
  switch (value) {
    case 'timeout':
    case 'channel_down':
    case 'auth':
    case 'quota':
    case 'content_filter':
    case 'unknown':
      return value;
    default:
      return null;
  }
}

export function resolveErrorAdvice(context: ErrorAdviceContext): ErrorAdvice {
  const errorClass =
    normalizeErrorClass(context.errorClass) ??
    classifyErrorClass(context.message ?? '');

  const retryAction: ErrorAdviceAction[] = context.canRetry
    ? [{ kind: 'retry', labelKey: 'errorAdvice.action.retry' }]
    : [];
  // 渠道类失败统一给 [检测所有渠道]（模块 C doctor）：触发探测后跳转渠道健康面板。
  const probeAction: ErrorAdviceAction = {
    kind: 'probeChannels',
    labelKey: 'errorAdvice.action.probeChannels',
  };

  switch (errorClass) {
    case 'timeout':
      return {
        errorClass,
        titleKey: 'errorAdvice.title.timeout',
        bodyKey: context.isChain
          ? 'errorAdvice.body.timeoutChain'
          : 'errorAdvice.body.timeoutSingle',
        actions: [probeAction, ...retryAction],
      };
    case 'channel_down':
      return {
        errorClass,
        titleKey: 'errorAdvice.title.channelDown',
        bodyKey: 'errorAdvice.body.channelDown',
        actions: [probeAction],
      };
    case 'auth':
      return {
        errorClass,
        titleKey: 'errorAdvice.title.auth',
        bodyKey: 'errorAdvice.body.auth',
        actions: [{ kind: 'openSettings', labelKey: 'errorAdvice.action.openSettings' }],
      };
    case 'quota': {
      const url = resolveProviderRechargeUrl(context.providerId);
      const actions: ErrorAdviceAction[] = url
        ? [{ kind: 'openUrl', labelKey: 'errorAdvice.action.recharge', url }]
        : [];
      actions.push({ kind: 'openSettings', labelKey: 'errorAdvice.action.openSettings' });
      if (context.canRetry) {
        actions.push({ kind: 'retry', labelKey: 'errorAdvice.action.retry' });
      }
      return {
        errorClass,
        titleKey: 'errorAdvice.title.quota',
        bodyKey: 'errorAdvice.body.quota',
        actions,
      };
    }
    case 'content_filter':
      return {
        errorClass,
        titleKey: 'errorAdvice.title.contentFilter',
        bodyKey: 'errorAdvice.body.contentFilter',
        actions: retryAction,
      };
    case 'unknown':
    default:
      return {
        errorClass: 'unknown',
        titleKey: 'errorAdvice.title.unknown',
        bodyKey: 'errorAdvice.body.unknown',
        actions: [],
      };
  }
}

/** 对话框行动按钮（GlobalErrorDialog 消费；retry 由调用方注入闭包）。 */
export interface GlobalErrorDialogAction {
  label: string;
  variant?: 'primary' | 'muted';
  onClick?: () => void;
  href?: string;
}

/** [检测所有渠道]：触发零费用探测 + 打开渠道健康面板（模块 F ↔ 模块 C 接线）。 */
function handleProbeChannelsAction(): void {
  void (async () => {
    try {
      const { useSettingsStore } = await import('@/stores/settingsStore');
      const { probeAllChannels } = await import('./imageFallback');
      const state = useSettingsStore.getState();
      await probeAllChannels({
        apiKeys: state.apiKeys,
        juyouapiBaseUrl: state.juyouapiBaseUrl,
        ollamaBaseUrl: state.ollamaBaseUrl,
        customEndpoints: state.customEndpoints,
      });
    } catch (error) {
      console.warn('[ErrorAdvice] probe channels failed', error);
    }
    const { openSettingsDialog } = await import('@/features/settings/settingsEvents');
    openSettingsDialog({ category: 'health' });
  })();
}

/** 把 advice 渲染成对话框按钮；translate 由调用方注入，retry 由调用方给闭包。 */
export function buildErrorDialogActions(
  advice: ErrorAdvice,
  options: {
    translate: (key: string) => string;
    onRetry?: () => void;
  }
): GlobalErrorDialogAction[] {
  const actions: Array<GlobalErrorDialogAction | null> = advice.actions.map(
    (action): GlobalErrorDialogAction | null => {
      if (action.kind === 'openSettings') {
        return {
          label: options.translate(action.labelKey),
          variant: 'primary',
          onClick: () => openSettingsDialog({ category: 'providers' }),
        };
      }
      if (action.kind === 'probeChannels') {
        return {
          label: options.translate(action.labelKey),
          variant: 'primary',
          onClick: handleProbeChannelsAction,
        };
      }
      if (action.kind === 'openUrl' && action.url) {
        const url = action.url;
        return {
          label: options.translate(action.labelKey),
          variant: 'primary',
          onClick: () => {
            try {
              window.open(url, '_blank', 'noopener,noreferrer');
            } catch (error) {
              console.warn('[ErrorAdvice] open recharge url failed', error);
            }
          },
        };
      }
      if (action.kind === 'retry' && options.onRetry) {
        return {
          label: options.translate(action.labelKey),
          variant: 'primary',
          onClick: options.onRetry,
        };
      }
      return null;
    }
  );
  return actions.filter((action): action is GlobalErrorDialogAction => action !== null);
}

/** showActionableErrorDialog：人话标题/正文 + 行动按钮；原文与报告折叠进详情/复制。 */
export function showActionableErrorDialog(input: {
  advice: ErrorAdvice;
  translate: (key: string) => string;
  /** 原始错误文本（折叠进详细信息）。 */
  originalMessage: string;
  /** 原有报告文本（[复制详情] 保留原能力）。 */
  reportText?: string;
  onRetry?: () => void;
}): void {
  const original = (input.originalMessage || '').trim();
  const details = [original, input.reportText].filter(Boolean).join('\n\n') || undefined;
  openGlobalErrorDialog({
    title: input.translate(input.advice.titleKey),
    message: input.translate(input.advice.bodyKey),
    details,
    copyText: input.reportText,
    actions: buildErrorDialogActions(input.advice, {
      translate: input.translate,
      onRetry: input.onRetry,
    }),
  });
}
