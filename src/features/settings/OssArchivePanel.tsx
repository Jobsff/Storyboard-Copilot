import { useCallback, useState } from 'react';
import { Eye, EyeOff, PlugZap } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { testOssArchive } from '@/commands/ai';
import { useSettingsStore } from '@/stores/settingsStore';
import { UiCheckbox } from '@/components/ui';

/**
 * 资产归档面板（批次11）：公司 OSS 出图自动归档的凭据配置 + 连通性测试。
 * 密钥改写即时落 store（localStorage 唯一真源），App.tsx 订阅变化注入 Rust；
 * 测试按钮直接用当前输入值（未保存也可测）。归档失败不影响出图（铁律写进说明文案）。
 */
export function OssArchivePanel() {
  const { t } = useTranslation();
  const ossArchive = useSettingsStore((state) => state.ossArchive);
  const setOssArchive = useSettingsStore((state) => state.setOssArchive);

  const [revealed, setRevealed] = useState({ accessKey: false, secretKey: false });
  const [testStatus, setTestStatus] = useState<'' | 'loading' | 'ok' | 'error'>('');
  const [testMessage, setTestMessage] = useState('');

  const handleTest = useCallback(async () => {
    setTestStatus('loading');
    setTestMessage('');
    try {
      const message = await testOssArchive(
        ossArchive.accessKey.trim() || undefined,
        ossArchive.secretKey.trim() || undefined
      );
      setTestStatus('ok');
      setTestMessage(message);
    } catch (error) {
      setTestStatus('error');
      setTestMessage(error instanceof Error ? error.message : String(error));
    }
  }, [ossArchive.accessKey, ossArchive.secretKey]);

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4">
      <div className="mx-auto max-w-[560px] space-y-4">
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border-dark bg-bg-dark px-4 py-3">
          <UiCheckbox
            checked={ossArchive.enabled}
            onCheckedChange={(checked) => setOssArchive({ enabled: checked })}
            className="mt-0.5 shrink-0"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-text-dark">
              {t('settings.archive.enabled')}
            </span>
            <span className="mt-0.5 block text-xs leading-4 text-text-muted">
              {t('settings.archive.enabledDesc')}
            </span>
          </span>
        </label>

        <div className="rounded-lg border border-border-dark bg-bg-dark p-4 space-y-3">
          <div>
            <div className="mb-1 text-xs font-medium text-text-muted">
              {t('settings.archive.accessKey')}
            </div>
            <div className="relative">
              <input
                type={revealed.accessKey ? 'text' : 'password'}
                value={ossArchive.accessKey}
                onChange={(event) => setOssArchive({ accessKey: event.target.value })}
                placeholder="LTAI..."
                autoComplete="off"
                className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 pr-10 text-sm text-text-dark placeholder:text-text-muted"
              />
              <button
                type="button"
                onClick={() => setRevealed((prev) => ({ ...prev, accessKey: !prev.accessKey }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-bg-dark"
              >
                {revealed.accessKey ? (
                  <EyeOff className="h-4 w-4 text-text-muted" />
                ) : (
                  <Eye className="h-4 w-4 text-text-muted" />
                )}
              </button>
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs font-medium text-text-muted">
              {t('settings.archive.secretKey')}
            </div>
            <div className="relative">
              <input
                type={revealed.secretKey ? 'text' : 'password'}
                value={ossArchive.secretKey}
                onChange={(event) => setOssArchive({ secretKey: event.target.value })}
                placeholder="****************"
                autoComplete="off"
                className="w-full rounded border border-border-dark bg-surface-dark px-3 py-2 pr-10 text-sm text-text-dark placeholder:text-text-muted"
              />
              <button
                type="button"
                onClick={() => setRevealed((prev) => ({ ...prev, secretKey: !prev.secretKey }))}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-bg-dark"
              >
                {revealed.secretKey ? (
                  <EyeOff className="h-4 w-4 text-text-muted" />
                ) : (
                  <Eye className="h-4 w-4 text-text-muted" />
                )}
              </button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleTest()}
              disabled={testStatus === 'loading'}
              className="inline-flex h-8 items-center gap-1.5 rounded border border-border-dark bg-surface-dark px-3 text-xs text-text-dark transition-colors hover:bg-bg-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PlugZap className={`h-3.5 w-3.5 ${testStatus === 'loading' ? 'animate-pulse' : ''}`} />
              {testStatus === 'loading'
                ? t('settings.archive.testing')
                : t('settings.archive.testConnection')}
            </button>
            {testMessage && (
              <span
                className={`min-w-0 flex-1 truncate text-xs ${
                  testStatus === 'error' ? 'text-red-400' : 'text-emerald-400'
                }`}
                title={testMessage}
              >
                {testMessage}
              </span>
            )}
          </div>
        </div>

        <p className="text-[11px] leading-4 text-text-muted/70">
          {t('settings.archive.note')}
        </p>
      </div>
    </div>
  );
}
