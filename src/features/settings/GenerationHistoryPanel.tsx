import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  listGenerationHistory,
  type GenerationHistoryEntry,
} from '@/commands/ai';
import { normalizeErrorClass } from '@/features/canvas/application/errorAdvice';

/**
 * 生成记录面板（渠道可靠性升级 · 模块 D UI 收尾）。
 * 最近 N 条生成台账（成功+失败）：时间/渠道·模型/模式/耗时/状态/错误分类；
 * 失败行展开显示错误摘要与链轨迹。纯元数据（media 7 天清理不影响台账）。
 * 数据按需拉取：打开面板时 fetch 一次 + 手动刷新，不轮询。
 */

const DEFAULT_HISTORY_LIMIT = 100;

function formatDateTime(timestampMs: number): string {
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(durationMs: number | null | undefined): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return '-';
  }
  const seconds = durationMs / 1000;
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m${String(restSeconds).padStart(2, '0')}s`;
}

function parseAttempts(raw: string | null | undefined): Array<{
  provider_id: string;
  model: string;
  error_class?: string | null;
  error?: string | null;
  display_name?: string | null;
}> {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function GenerationHistoryPanel() {
  const { t, i18n } = useTranslation();
  const [entries, setEntries] = useState<GenerationHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  const isZh = i18n.language.startsWith('zh');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const rows = await listGenerationHistory(DEFAULT_HISTORY_LIMIT);
      setEntries(rows);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const providerLabel = useCallback((providerId: string) => {
    // 链渠道 id → 展示名（GRSAI/666API/巨游API/KIE）；自定义渠道原样。
    const labels: Record<string, string> = {
      grsai: 'GRSAI',
      '666api': '666API',
      juyouapi: isZh ? '巨游API' : 'JuyouAPI',
      kie: 'KIE',
      aifast: 'aifast',
      agnes: 'Agnes AI',
      ollama: 'Ollama',
    };
    return labels[providerId] ?? providerId;
  }, [isZh]);

  const errorClassLabel = useCallback((errorClass: string | null | undefined): string => {
    const normalized = normalizeErrorClass(errorClass);
    if (!normalized || normalized === 'unknown') {
      return normalized === 'unknown' ? t('errorAdvice.classLabel.unknown') : '-';
    }
    return t(`errorAdvice.classLabel.${normalized}`);
  }, [t]);

  const footerNote = useMemo(() => t('settings.history.footerNote'), [t]);

  // 复制 OSS 归档直链（批次11）：navigator.clipboard 先例见 GlobalErrorDialog。
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const handleCopyLink = useCallback(async (jobId: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedJobId(jobId);
      window.setTimeout(() => setCopiedJobId((current) => (current === jobId ? null : current)), 1200);
    } catch (error) {
      console.error('Failed to copy OSS link', error);
    }
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {t('settings.history.summary', { count: entries.length })}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex h-7 items-center gap-1.5 rounded border border-border-dark bg-surface-dark px-2.5 text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('settings.history.refresh')}
        </button>
      </div>

      {loadError && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {loadError}
        </div>
      )}

      {entries.length === 0 && !loading && !loadError && (
        <div className="rounded-lg border border-dashed border-border-dark p-6 text-center text-sm text-text-muted">
          {t('settings.history.empty')}
        </div>
      )}

      <div className="space-y-2">
        {entries.map((entry) => {
          const isFailed = entry.status === 'failed';
          const expanded = expandedJobId === entry.job_id;
          const attempts = expanded ? parseAttempts(entry.attempts_json) : [];
          return (
            <div
              key={entry.job_id}
              className={`rounded-lg border bg-bg-dark ${isFailed ? 'border-red-500/30' : 'border-border-dark'}`}
            >
              {/* 行容器用 div role=button：行内还有「复制链接」真按钮，避免 button 嵌套 button。 */}
              <div
                role="button"
                tabIndex={isFailed ? 0 : -1}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-xs ${isFailed ? 'cursor-pointer' : 'cursor-default'}`}
                onClick={() => {
                  if (!isFailed) {
                    return;
                  }
                  setExpandedJobId(expanded ? null : entry.job_id);
                }}
                onKeyDown={(event) => {
                  if (!isFailed || !(event.key === 'Enter' || event.key === ' ')) {
                    return;
                  }
                  event.preventDefault();
                  setExpandedJobId(expanded ? null : entry.job_id);
                }}
              >
                {isFailed ? (
                  expanded
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-red-300" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-red-300" />
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                <span className="w-[112px] shrink-0 text-text-muted">
                  {formatDateTime(entry.created_at)}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-dark">
                  {providerLabel(entry.provider_id)}
                  <span className="text-text-muted"> · </span>
                  {entry.model}
                </span>
                <span className="w-[64px] shrink-0 text-text-muted">
                  {entry.mode === 'auto' ? t('settings.history.modeAuto') : t('settings.history.modeManual')}
                </span>
                <span className="w-[52px] shrink-0 text-text-muted">
                  {formatDuration(entry.duration_ms)}
                </span>
                <span
                  className={`w-[92px] shrink-0 truncate ${isFailed ? 'text-red-300' : 'text-emerald-300'}`}
                >
                  {isFailed ? t('settings.history.statusFailed') : t('settings.history.statusSucceeded')}
                </span>
                <span className="flex w-[72px] shrink-0 items-center justify-end gap-1 truncate text-text-muted">
                  <span className="truncate">
                    {isFailed ? errorClassLabel(entry.error_class) : ''}
                  </span>
                  {entry.ossUrl && (
                    <button
                      type="button"
                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-border-dark bg-surface-dark px-1.5 text-[11px] text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
                      title={t('settings.history.copyLink')}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleCopyLink(entry.job_id, entry.ossUrl as string);
                      }}
                    >
                      <Link2 className="h-3 w-3" />
                      {copiedJobId === entry.job_id
                        ? t('settings.history.linkCopied')
                        : t('settings.history.copyLink')}
                    </button>
                  )}
                </span>
              </div>

              {isFailed && expanded && (
                <div className="space-y-2 border-t border-border-dark px-3 py-2 text-xs text-text-muted">
                  {entry.prompt && (
                    <div className="break-words">
                      <span className="text-text-muted/80">{t('settings.history.promptLabel')}: </span>
                      <span className="text-text-dark">{entry.prompt}</span>
                    </div>
                  )}
                  {attempts.length > 0 ? (
                    <div className="space-y-1">
                      <div>{t('settings.history.chainTrajectory')}</div>
                      {attempts.map((attempt, index) => (
                        <div key={`${attempt.provider_id}-${index}`} className="break-words pl-2">
                          <span className="text-text-dark">
                            {attempt.display_name || providerLabel(attempt.provider_id)}·{attempt.model}
                          </span>
                          <span>（{errorClassLabel(attempt.error_class ?? null)}）</span>
                          {attempt.error && <span>：{attempt.error}</span>}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="break-words">{t('settings.history.noTrajectory')}</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] leading-4 text-text-muted/70">{footerNote}</p>
    </div>
  );
}
