import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal, UiPanel, UiTextAreaField } from '@/components/ui/primitives';
import type { UiAssetPreset } from '@/features/canvas/uiAssets/types';
import { buildUiAssetPrompt } from '@/features/canvas/uiAssets/builtInUiAssetPresets';

function formatSizeText(size: { width: number; height: number }): string {
  return `${size.width}×${size.height}`;
}

function resolveRequestPixelsText(requestSize: string | undefined, aspectRatio: string): string {
  const sizeToPixels: Record<string, number> = { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 4096 };
  const pixels = requestSize ? sizeToPixels[requestSize] : null;
  if (!pixels) {
    return requestSize ?? '-';
  }
  const [wText, hText] = aspectRatio.split(':');
  const w = Number.parseFloat(wText);
  const h = Number.parseFloat(hText);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return requestSize ?? '-';
  }
  const height = Math.max(1, Math.round(pixels * (h / w)));
  return `${requestSize} (${pixels}x${height})`;
}

interface UiAssetPromptDialogProps {
  isOpen: boolean;
  preset: UiAssetPreset | null;
  onClose: () => void;
  onConfirm: (subject: string, prompt: string, preset: UiAssetPreset) => void;
}

export function UiAssetPromptDialog({ isOpen, preset, onClose, onConfirm }: UiAssetPromptDialogProps) {
  const { t } = useTranslation();
  const [subject, setSubject] = useState('');
  const subjectRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setSubject('');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timer = setTimeout(() => {
      subjectRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const promptPreview = useMemo(() => {
    if (!preset) {
      return '';
    }
    const trimmed = subject.trim();
    if (!trimmed) {
      return buildUiAssetPrompt(preset, t('uiAsset.dialog.subjectPlaceholder'));
    }
    return buildUiAssetPrompt(preset, trimmed);
  }, [preset, subject, t]);

  const canConfirm = Boolean(preset) && subject.trim().length > 0;

  return (
    <UiModal
      isOpen={isOpen}
      title={t('uiAsset.dialog.title')}
      onClose={onClose}
      footer={
        <>
          <UiButton type="button" variant="muted" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!canConfirm || !preset}
            onClick={() => {
              if (!preset) {
                return;
              }
              const trimmed = subject.trim();
              if (!trimmed) {
                return;
              }
              const prompt = buildUiAssetPrompt(preset, trimmed);
              onConfirm(trimmed, prompt, preset);
            }}
          >
            {t('uiAsset.dialog.generate')}
          </UiButton>
        </>
      }
      widthClassName="max-w-3xl"
    >
      {preset ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.assetType')}</div>
              <div className="text-right text-text-dark">{t(`uiAsset.category.${preset.categoryId}`)}</div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.spec')}</div>
              <div className="text-right text-text-dark">{t(preset.labelKey)}</div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.targetSize')}</div>
              <div className="text-right text-text-dark">{formatSizeText(preset.targetSize)}</div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.modelAspectRatio')}</div>
              <div className="text-right text-text-dark">{preset.modelConfig.aspectRatio}</div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.requestSize')}</div>
              <div className="text-right text-text-dark">
                {resolveRequestPixelsText(preset.modelConfig.requestSize, preset.modelConfig.aspectRatio)}
              </div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.transparentBackground')}</div>
              <div className="text-right text-text-dark">
                {preset.postprocess.transparentBackground ? t('common.yes') : t('common.no')}
              </div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.nineSlice')}</div>
              <div className="text-right text-text-dark">
                {preset.postprocess.nineSlice?.enabled ? t('common.yes') : t('common.no')}
              </div>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="text-text-muted">{t('uiAsset.dialog.variants')}</div>
              <div className="text-right text-text-dark">
                {preset.variants && preset.variants.length > 0 ? preset.variants.join(', ') : '-'}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm text-text-dark">{t('uiAsset.dialog.subject')}</div>
            <UiTextAreaField
              ref={subjectRef}
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              placeholder={t('uiAsset.dialog.subjectPlaceholder')}
              className="min-h-[88px]"
            />
          </div>

          <div className="space-y-2">
            <div className="text-xs text-text-muted">{t('uiAsset.dialog.promptPreview')}</div>
            <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
                {promptPreview}
              </pre>
            </UiPanel>
          </div>

          <div className="space-y-2">
            <div className="text-xs text-text-muted">{t('uiAsset.dialog.negativePrompt')}</div>
            <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
                {preset.negativePrompt || '-'}
              </pre>
            </UiPanel>
          </div>
        </div>
      ) : null}
    </UiModal>
  );
}

