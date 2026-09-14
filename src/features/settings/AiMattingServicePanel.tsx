import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { samHealth } from '@/commands/sam';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * AI 抠图服务面板（批次16）：内网 SAM-HQ 服务地址配置 + 连通性测试。
 * 地址改写即时落 store（归一化后），编辑器打开时读取最新值；
 * 服务无鉴权（纯内网），文案里提醒勿暴露公网。
 */
export function AiMattingServicePanel() {
  const { t } = useTranslation();
  const aiMattingBaseUrl = useSettingsStore((state) => state.aiMattingBaseUrl);
  const setAiMattingBaseUrl = useSettingsStore((state) => state.setAiMattingBaseUrl);

  const [draft, setDraft] = useState(aiMattingBaseUrl);
  const [testStatus, setTestStatus] = useState<'' | 'loading' | 'ok' | 'error'>('');
  const [testMessage, setTestMessage] = useState('');
  /** 连通后的小字详情：device + 服务实际支持的模型档（升级后自动多出 vit_l 等）。 */
  const [healthDetail, setHealthDetail] = useState('');

  const handleTest = useCallback(async () => {
    setTestStatus('loading');
    setTestMessage('');
    setHealthDetail('');
    try {
      const health = await samHealth(draft.trim());
      setTestStatus('ok');
      setTestMessage(
        `${t('settings.aiMattingService.testOk')} · ${health.service} v${health.version} · ${health.device}`
      );
      setHealthDetail(
        `${health.device} · ${health.models.join(' / ')} · BiRefNet ${health.birefnet ? '✓' : '✗'} · mask ${health.maskSize}`
      );
    } catch (error) {
      setTestStatus('error');
      setTestMessage(error instanceof Error ? error.message : String(error));
    }
  }, [draft, t]);

  return (
    <div className="px-6 py-4">
      <div className="mx-auto max-w-[560px] space-y-3">
        <div>
          <div className="text-sm font-medium text-text-dark">
            {t('settings.aiMattingService.title')}
          </div>
          <div className="mt-1 text-xs leading-4 text-text-muted">
            {t('settings.aiMattingService.desc')}
          </div>
        </div>
        <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium text-text-muted">
              {t('settings.aiMattingService.baseUrlLabel')}
            </div>
            <input
              type="text"
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={() => setAiMattingBaseUrl(draft)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  setAiMattingBaseUrl(draft);
                }
              }}
              className="w-full rounded-md border border-[rgba(255,255,255,0.14)] bg-bg-dark px-3 py-2 text-sm text-text-dark outline-none focus:border-[rgba(255,255,255,0.32)]"
              placeholder="http://192.168.1.188:8760"
            />
            <div className="mt-1 text-xs text-text-muted">
              {t('settings.aiMattingService.baseUrlHint')}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded-md border border-[rgba(255,255,255,0.18)] px-3 py-1.5 text-xs text-text-dark transition-colors hover:bg-bg-dark"
              onClick={handleTest}
              disabled={testStatus === 'loading'}
            >
              {testStatus === 'loading'
                ? t('settings.aiMattingService.testing')
                : t('settings.aiMattingService.test')}
            </button>
            {testStatus === 'ok' && (
              <span className="text-xs text-emerald-400">{testMessage}</span>
            )}
            {testStatus === 'error' && (
              <span className="min-w-0 truncate text-xs text-red-400" title={testMessage}>
                {t('settings.aiMattingService.testFail')} · {testMessage}
              </span>
            )}
          </div>
          {testStatus === 'ok' && healthDetail && (
            <div className="text-xs text-text-muted">{healthDetail}</div>
          )}
        </div>
      </div>
    </div>
  );
}
