import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { craftImagePrompt } from '@/commands/ai';
import { UiButton, UiModal, UiPanel, UiSelect, UiTextAreaField } from '@/components/ui/primitives';
import { PROMPT_CRAFT_CATEGORIES, type PromptCraftCategoryId } from '@/features/canvas/application/promptCraft';

interface PromptEngineerDialogProps {
  isOpen: boolean;
  apiKey: string;
  onClose: () => void;
  onConfirm: (prompt: string) => void;
}

const DEFAULT_CATEGORY_ID: PromptCraftCategoryId = 'general';

export function PromptEngineerDialog({
  isOpen,
  apiKey,
  onClose,
  onConfirm,
}: PromptEngineerDialogProps) {
  const { t } = useTranslation();
  const [category, setCategory] = useState<PromptCraftCategoryId>(DEFAULT_CATEGORY_ID);
  const [userInput, setUserInput] = useState('');
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [isCrafting, setIsCrafting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setUserInput('');
    setGeneratedPrompt('');
    setError(null);
    setIsCrafting(false);
    setCategory(DEFAULT_CATEGORY_ID);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const canCraft = userInput.trim().length > 0 && !isCrafting && apiKey.length > 0;
  const canGenerate = generatedPrompt.trim().length > 0;

  const handleCraft = async () => {
    const trimmed = userInput.trim();
    if (!trimmed) {
      return;
    }
    setIsCrafting(true);
    setError(null);
    setGeneratedPrompt('');
    try {
      const result = await craftImagePrompt({
        provider: '666api',
        apiKey,
        userInput: trimmed,
        category: category === 'general' ? undefined : category,
      });
      setGeneratedPrompt(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setIsCrafting(false);
    }
  };

  const categoryOptions = useMemo(
    () =>
      PROMPT_CRAFT_CATEGORIES.map((cat) => ({
        value: cat.id,
        label: t(cat.labelKey),
      })),
    [t]
  );

  return (
    <UiModal
      isOpen={isOpen}
      title={t('promptCraft.dialog.title')}
      onClose={onClose}
      footer={
        <>
          <UiButton type="button" variant="muted" onClick={onClose}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            type="button"
            variant="primary"
            disabled={!canGenerate}
            onClick={() => {
              const trimmed = generatedPrompt.trim();
              if (!trimmed) {
                return;
              }
              onConfirm(trimmed);
            }}
          >
            {t('promptCraft.dialog.generate')}
          </UiButton>
        </>
      }
      widthClassName="max-w-4xl"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-sm text-text-dark">{t('promptCraft.dialog.category')}</div>
            <UiSelect
              aria-label={t('promptCraft.dialog.category')}
              value={category}
              onChange={(event) => setCategory(event.target.value as PromptCraftCategoryId)}
              className="h-8 w-[140px] rounded-lg text-sm"
            >
              {categoryOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </UiSelect>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm text-text-dark">{t('promptCraft.dialog.userInput')}</div>
          <UiTextAreaField
            ref={inputRef}
            value={userInput}
            onChange={(event) => setUserInput(event.target.value)}
            placeholder={t('promptCraft.dialog.userInputPlaceholder')}
            className="min-h-[72px]"
          />
        </div>

        <div className="flex items-center gap-3">
          <UiButton
            type="button"
            variant="primary"
            disabled={!canCraft}
            onClick={handleCraft}
            className="gap-2"
          >
            {isCrafting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('promptCraft.dialog.crafting')}
              </>
            ) : (
              t('promptCraft.dialog.craft')
            )}
          </UiButton>
          {generatedPrompt && !isCrafting && (
            <UiButton
              type="button"
              variant="muted"
              disabled={!canCraft}
              onClick={handleCraft}
              className="gap-2"
            >
              {t('promptCraft.dialog.regenerate')}
            </UiButton>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <div className="text-xs text-text-muted">{t('promptCraft.dialog.preview')}</div>
          {generatedPrompt ? (
            <UiTextAreaField
              value={generatedPrompt}
              onChange={(event) => setGeneratedPrompt(event.target.value)}
              className="min-h-[120px] font-mono text-xs"
            />
          ) : (
            <UiPanel className="rounded-lg bg-bg-dark/50 px-3 py-2">
              <p className="text-xs text-text-muted">
                {t('promptCraft.dialog.emptyHint')}
              </p>
            </UiPanel>
          )}
        </div>
      </div>
    </UiModal>
  );
}
