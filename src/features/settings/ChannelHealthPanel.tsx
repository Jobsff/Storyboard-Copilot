import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  fetchChannelHealthCached,
  getCachedChannelHealth,
  probeAllChannels,
  PROBE_CHANNEL_ORDER,
} from '@/features/canvas/application/imageFallback';
import type { ChannelProbeResult } from '@/commands/ai';
import { getModelProvider } from '@/features/canvas/models';
import { UiCheckbox } from '@/components/ui';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 渠道健康面板（渠道可靠性升级 · 模块 C doctor UI）。
 * 每渠道一行：状态徽标（绿=ok/黄=reachable/红=down/灰=未配置）+ 渠道名 + 延迟
 * + 一句人话 + 检测时间。[立即重新检测] 触发零费用探测（只拉模型列表，10s/渠道封顶）。
 */

type ProbeRunningState = Record<string, boolean>;

const STATUS_DOT_CLASS: Record<string, string> = {
  ok: 'bg-emerald-400',
  reachable: 'bg-amber-400',
  down: 'bg-red-400',
  unconfigured: 'bg-zinc-500',
};

/**
 * grsai 网关无 /v1/models 的可达明细标记（Rust PROBE_NO_MODEL_LIST_DETAIL 同源，
 * 批次9）：网关形态如此而非故障——绿色专属文案，与真 401/403（key 无效，黄）区分。
 */
const NO_MODEL_LIST_DETAIL_MARKER = 'no model-list endpoint';

function formatRelativeTime(timestampMs: number, isZh: boolean): string {
  const diffMs = Date.now() - timestampMs;
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return '-';
  }
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) {
    return isZh ? '刚刚' : 'just now';
  }
  if (minutes < 60) {
    return isZh ? `${minutes} 分钟前` : `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return isZh ? `${hours} 小时前` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return isZh ? `${days} 天前` : `${days}d ago`;
}

export function ChannelHealthPanel() {
  const { t, i18n } = useTranslation();
  const isZh = i18n.language.startsWith('zh');
  const autoProbeOnLaunch = useSettingsStore((state) => state.autoProbeOnLaunch);
  const setAutoProbeOnLaunch = useSettingsStore((state) => state.setAutoProbeOnLaunch);
  // NEWAPI 接口端点（批次8）：健康面板在 9 个内置渠道行之后逐端点展示。
  const customEndpoints = useSettingsStore((state) => state.customEndpoints);
  const [healthRows, setHealthRows] = useState<ChannelProbeResult[]>(
    () => getCachedChannelHealth() ?? []
  );
  const [loadingList, setLoadingList] = useState(!getCachedChannelHealth());
  const [probing, setProbing] = useState(false);
  const [probingChannels, setProbingChannels] = useState<ProbeRunningState>({});
  const [probeError, setProbeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchChannelHealthCached()
      .then((rows) => {
        if (!cancelled) {
          setHealthRows(rows);
        }
      })
      .catch((error) => {
        console.warn('[ChannelHealth] load health failed', error);
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingList(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleProbe = useCallback(async () => {
    if (probing) {
      return;
    }
    setProbing(true);
    setProbeError(null);
    const state = useSettingsStore.getState();
    const endpointIds = state.customEndpoints
      .filter((endpoint) => endpoint.baseUrl.trim().length > 0)
      .map((endpoint) => endpoint.id);
    setProbingChannels(
      Object.fromEntries([...PROBE_CHANNEL_ORDER, ...endpointIds].map((id) => [id, true]))
    );
    try {
      const rows = await probeAllChannels({
        apiKeys: state.apiKeys,
        juyouapiBaseUrl: state.juyouapiBaseUrl,
        ollamaBaseUrl: state.ollamaBaseUrl,
        customEndpoints: state.customEndpoints,
      });
      setHealthRows(rows);
    } catch (error) {
      setProbeError(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
      setProbingChannels({});
    }
  }, [probing]);

  const healthByProvider = useMemo(() => {
    const map = new Map<string, ChannelProbeResult>();
    healthRows.forEach((row) => map.set(row.provider_id, row));
    return map;
  }, [healthRows]);

  const providerLine = useCallback(
    (providerId: string) => {
      const row = healthByProvider.get(providerId);
      const status = probingChannels[providerId] ? 'probing' : (row?.status ?? 'unknown');
      const label = getModelProvider(providerId).label || getModelProvider(providerId).name;

      let statusText: string;
      let dotClass = STATUS_DOT_CLASS[row?.status ?? ''] ?? 'bg-zinc-600';
      switch (status) {
        case 'probing':
          statusText = t('settings.channelHealth.statusProbing');
          break;
        case 'ok': {
          const chainOk = typeof row?.chain_models_ok === 'number' ? row.chain_models_ok : null;
          statusText = chainOk !== null
            ? t('settings.channelHealth.okWithChain', { count: chainOk ?? 0 })
            : t('settings.channelHealth.ok');
          break;
        }
        case 'reachable': {
          if (row?.detail?.includes(NO_MODEL_LIST_DETAIL_MARKER)) {
            // grsai 形态如此（网关无模型列表接口，非故障）：绿标 + 专属文案（批次9）。
            statusText = t('settings.channelHealth.reachableNoModelList');
            dotClass = STATUS_DOT_CLASS.ok;
            break;
          }
          statusText = t('settings.channelHealth.reachable');
          break;
        }
        case 'down':
          statusText = t('settings.channelHealth.down');
          break;
        case 'unconfigured':
          statusText = t('settings.channelHealth.unconfigured');
          break;
        default:
          statusText = t('settings.channelHealth.neverChecked');
      }

      const latency = typeof row?.latency_ms === 'number' && status === 'ok'
        ? t('settings.channelHealth.latency', { ms: row.latency_ms })
        : '';
      const checkedAt = row?.checked_at
        ? formatRelativeTime(row.checked_at, isZh)
        : '';

      return {
        label,
        status,
        statusText,
        latency,
        checkedAt,
        dotClass,
      };
    },
    [healthByProvider, i18n.language, probingChannels, t]
  );

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
          {t('settings.channelHealth.freeNote')}
        </p>
        <button
          type="button"
          onClick={() => void handleProbe()}
          disabled={probing || loadingList}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded border border-border-dark bg-surface-dark px-2.5 text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${probing ? 'animate-spin' : ''}`} />
          {probing ? t('settings.channelHealth.probing') : t('settings.channelHealth.probeNow')}
        </button>
      </div>

      {probeError && (
        <div className="mb-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {probeError}
        </div>
      )}

      <div className="space-y-2">
        {PROBE_CHANNEL_ORDER.map((providerId) => {
          const line = providerLine(providerId);
          return (
            <div
              key={providerId}
              className="flex items-center gap-3 rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-xs"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${line.dotClass} ${line.status === 'probing' ? 'animate-pulse' : ''}`}
              />
              <span className="w-[92px] shrink-0 truncate text-text-dark">{line.label}</span>
              <span className="min-w-0 flex-1 truncate text-text-muted">{line.statusText}</span>
              <span className="w-[64px] shrink-0 text-right text-text-muted">{line.latency}</span>
              <span className="w-[80px] shrink-0 text-right text-text-muted/70">
                {line.checkedAt}
              </span>
            </div>
          );
        })}
        {/* NEWAPI 接口端点行（批次8）：显示用户起的名字；未配 key / 未探测=灰。
            标签列稍宽，端点名可能比内置渠道名长。 */}
        {customEndpoints.map((endpoint) => {
          const line = providerLine(endpoint.id);
          return (
            <div
              key={endpoint.id}
              className="flex items-center gap-3 rounded-lg border border-border-dark bg-bg-dark px-3 py-2 text-xs"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${line.dotClass} ${line.status === 'probing' ? 'animate-pulse' : ''}`}
              />
              <span className="w-[120px] shrink-0 truncate text-text-dark" title={endpoint.id}>
                {endpoint.name || endpoint.id}
              </span>
              <span className="min-w-0 flex-1 truncate text-text-muted">{line.statusText}</span>
              <span className="w-[64px] shrink-0 text-right text-text-muted">{line.latency}</span>
              <span className="w-[80px] shrink-0 text-right text-text-muted/70">
                {line.checkedAt}
              </span>
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[11px] leading-4 text-text-muted/70">
        {t('settings.channelHealth.footerNote')}
      </p>

      <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-muted">
        <UiCheckbox
          checked={autoProbeOnLaunch}
          onCheckedChange={(checked) => setAutoProbeOnLaunch(checked)}
        />
        {t('settings.channelHealth.autoProbeOnLaunch')}
      </label>
    </div>
  );
}
