import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UiButton, UiModal, UiPanel, UiTextAreaField } from '@/components/ui/primitives';
import type { BuiltInStylePreset } from '@/features/canvas/styles/builtInStyles';
import { buildStylePrompt } from '@/features/canvas/styles/builtInStyles';

interface StylePromptDialogProps {
  isOpen: boolean;
  preset: BuiltInStylePreset | null;
  onClose: () => void;
  onConfirm: (subject: string, prompt: string, preset: BuiltInStylePreset) => void;
}

export function StylePromptDialog({ isOpen, preset, onClose, onConfirm }: StylePromptDialogProps) {
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
      return preset.template.split('{subject}').join(t('style.dialog.subjectPlaceholder'));
    }
    return buildStylePrompt(preset, trimmed);
  }, [preset, subject, t]);

  const canConfirm = Boolean(preset) && subject.trim().length > 0;

  return (
    <UiModal
      isOpen={isOpen}
      title={preset ? t(preset.labelKey) : t('style.dialog.title')}
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
              const prompt = buildStylePrompt(preset, trimmed);
              onConfirm(trimmed, prompt, preset);
            }}
          >
            {t('style.dialog.create')}
          </UiButton>
        </>
      }
      widthClassName="max-w-3xl"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-sm text-text-dark">{t('style.dialog.subject')}</div>
          <UiTextAreaField
            ref={subjectRef}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder={t('style.dialog.subjectPlaceholder')}
            className="min-h-[88px]"
          />
        </div>
        <div className="space-y-2">
          <div className="text-xs text-text-muted">{t('style.dialog.preview')}</div>
          <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
            <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-text-dark">
              {promptPreview}
            </pre>
          </UiPanel>
        </div>
      </div>
    </UiModal>
  );
}
