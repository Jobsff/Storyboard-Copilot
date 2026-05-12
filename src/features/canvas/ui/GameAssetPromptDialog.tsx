import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal, UiPanel } from '@/components/ui/primitives';
import type { BuiltInGameAssetTemplate } from '@/features/canvas/gameAssets/builtInGameAssetTemplates';
import { buildGameAssetPrompt } from '@/features/canvas/gameAssets/builtInGameAssetTemplates';

interface GameAssetPromptDialogProps {
  isOpen: boolean;
  template: BuiltInGameAssetTemplate | null;
  onClose: () => void;
  onConfirm: (prompt: string, template: BuiltInGameAssetTemplate) => void;
}

export function GameAssetPromptDialog({
  isOpen,
  template,
  onClose,
  onConfirm,
}: GameAssetPromptDialogProps) {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timer = setTimeout(() => {
      wrapperRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const promptPreview = useMemo(() => {
    if (!template) {
      return '';
    }
    return buildGameAssetPrompt(template);
  }, [template]);

  return (
    <UiModal
      isOpen={isOpen}
      title={template ? t(template.labelKey) : t('gameAsset.dialog.title')}
      onClose={onClose}
      footer={
        <>
          <UiButton type="button" variant="muted" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!template}
            onClick={() => {
              if (!template) {
                return;
              }
              onConfirm(buildGameAssetPrompt(template), template);
            }}
          >
            {t('gameAsset.dialog.create')}
          </UiButton>
        </>
      }
      widthClassName="max-w-3xl"
    >
      <div ref={wrapperRef} tabIndex={-1} className="space-y-2 outline-none">
        <div className="text-xs text-text-muted">{t('gameAsset.dialog.preview')}</div>
        <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
          <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
            {promptPreview}
          </pre>
        </UiPanel>
      </div>
    </UiModal>
  );
}

