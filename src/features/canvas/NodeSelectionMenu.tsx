import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Upload, Sparkles, LayoutGrid, Type, Video, ChevronRight, Wand2 } from 'lucide-react';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { MenuIconKey } from '@/features/canvas/domain/nodeRegistry';
import { builtInStyleCategories, builtInStylePresets } from '@/features/canvas/styles/builtInStyles';
import { builtInUiAssetCategories, builtInUiAssetPresets } from '@/features/canvas/uiAssets/builtInUiAssetPresets';
import { builtInGameAssetCategories, builtInGameAssetTemplates } from '@/features/canvas/gameAssets/builtInGameAssetTemplates';

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  onSelect: (type: CanvasNodeType) => void;
  onSelectStyle?: (styleId: string) => void;
  onSelectGameAssetTemplate?: (templateId: string) => void;
  onSelectUiAssetPreset?: (presetId: string) => void;
  onSelectPromptEngineer?: () => void;
  onClose: () => void;
}

const iconMap: Record<MenuIconKey, typeof Upload> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
  video: Video,
  wand: Wand2,
};

export function NodeSelectionMenu({
  position,
  allowedTypes,
  onSelect,
  onSelectStyle,
  onSelectGameAssetTemplate,
  onSelectUiAssetPreset,
  onSelectPromptEngineer,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  const gameAssetButtonRef = useRef<HTMLButtonElement>(null);
  const uiAssetButtonRef = useRef<HTMLButtonElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const [isGameAssetMenuOpen, setIsGameAssetMenuOpen] = useState(false);
  const [isUiAssetMenuOpen, setIsUiAssetMenuOpen] = useState(false);
  const styleMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styleMenuRef = useRef<HTMLDivElement | null>(null);
  const [styleMenuTop, setStyleMenuTop] = useState<number | null>(null);
  const gameAssetMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameAssetMenuRef = useRef<HTMLDivElement | null>(null);
  const [gameAssetMenuTop, setGameAssetMenuTop] = useState<number | null>(null);
  const [gameAssetActiveCategoryId, setGameAssetActiveCategoryId] = useState<string | null>(null);
  const uiAssetMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uiAssetMenuRef = useRef<HTMLDivElement | null>(null);
  const [uiAssetMenuTop, setUiAssetMenuTop] = useState<number | null>(null);
  const [uiAssetActiveCategoryId, setUiAssetActiveCategoryId] = useState<string | null>(null);

  const allowedTypeSet = useMemo(
    () => (allowedTypes ? new Set(allowedTypes) : null),
    [allowedTypes]
  );

  const menuItems = useMemo(() => {
    const candidates = !allowedTypeSet || !allowedTypes
      ? nodeCatalog.getMenuDefinitions()
      : Array.from(new Set(allowedTypes)).map((type) => nodeCatalog.getDefinition(type));

    const dedupedByLabel = new Map<string, (typeof candidates)[number]>();
    for (const definition of candidates) {
      const existing = dedupedByLabel.get(definition.menuLabelKey);
      if (!existing) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
        continue;
      }

      // Prefer user-visible definitions when multiple internal node types share the same label.
      if (!existing.visibleInMenu && definition.visibleInMenu) {
        dedupedByLabel.set(definition.menuLabelKey, definition);
      }
    }

    return Array.from(dedupedByLabel.values());
  }, [allowedTypeSet, allowedTypes]);

  const canShowStyleEntry = !allowedTypeSet && !allowedTypes && Boolean(onSelectStyle);
  const canShowGameAssetEntry = !allowedTypeSet && !allowedTypes && Boolean(onSelectGameAssetTemplate);
  const canShowUiAssetEntry = !allowedTypeSet && !allowedTypes && Boolean(onSelectUiAssetPreset);
  const canShowPromptEngineerEntry = !allowedTypeSet && !allowedTypes && Boolean(onSelectPromptEngineer);

  const styleGroups = useMemo(() => {
    if (!canShowStyleEntry) {
      return [];
    }

    const byCategory = new Map(
      builtInStyleCategories.map((category) => [category.id, { category, items: [] as typeof builtInStylePresets }])
    );

    for (const preset of builtInStylePresets) {
      const group = byCategory.get(preset.categoryId);
      if (!group) {
        continue;
      }
      group.items.push(preset);
    }

    return Array.from(byCategory.values()).filter((group) => group.items.length > 0);
  }, [canShowStyleEntry]);

  const uiAssetGroups = useMemo(() => {
    if (!canShowUiAssetEntry) {
      return [];
    }

    const byCategory = new Map(
      builtInUiAssetCategories.map((category) => [category.id, { category, items: [] as typeof builtInUiAssetPresets }])
    );

    for (const preset of builtInUiAssetPresets) {
      const group = byCategory.get(preset.categoryId);
      if (!group) {
        continue;
      }
      group.items.push(preset);
    }

    return Array.from(byCategory.values()).filter((group) => group.items.length > 0);
  }, [canShowUiAssetEntry]);

  const gameAssetGroups = useMemo(() => {
    if (!canShowGameAssetEntry) {
      return [];
    }

    const byCategory = new Map(
      builtInGameAssetCategories.map((category) => [category.id, { category, items: [] as typeof builtInGameAssetTemplates }])
    );

    for (const template of builtInGameAssetTemplates) {
      const group = byCategory.get(template.categoryId);
      if (!group) {
        continue;
      }
      group.items.push(template);
    }

    return Array.from(byCategory.values()).filter((group) => group.items.length > 0);
  }, [canShowGameAssetEntry]);

  useEffect(() => {
    requestAnimationFrame(() => {
      setIsVisible(true);
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsVisible(false);
    setTimeout(onClose, UI_POPOVER_TRANSITION_MS);
  }, [onClose]);

  const scheduleCloseStyleMenu = useCallback(() => {
    if (styleMenuCloseTimerRef.current) {
      clearTimeout(styleMenuCloseTimerRef.current);
    }
    styleMenuCloseTimerRef.current = setTimeout(() => {
      setIsStyleMenuOpen(false);
      styleMenuCloseTimerRef.current = null;
    }, 120);
  }, []);

  const scheduleCloseUiAssetMenu = useCallback(() => {
    if (uiAssetMenuCloseTimerRef.current) {
      clearTimeout(uiAssetMenuCloseTimerRef.current);
    }
    uiAssetMenuCloseTimerRef.current = setTimeout(() => {
      setIsUiAssetMenuOpen(false);
      uiAssetMenuCloseTimerRef.current = null;
    }, 120);
  }, []);

  const scheduleCloseGameAssetMenu = useCallback(() => {
    if (gameAssetMenuCloseTimerRef.current) {
      clearTimeout(gameAssetMenuCloseTimerRef.current);
    }
    gameAssetMenuCloseTimerRef.current = setTimeout(() => {
      setIsGameAssetMenuOpen(false);
      gameAssetMenuCloseTimerRef.current = null;
    }, 120);
  }, []);

  const cancelCloseStyleMenu = useCallback(() => {
    if (!styleMenuCloseTimerRef.current) {
      return;
    }
    clearTimeout(styleMenuCloseTimerRef.current);
    styleMenuCloseTimerRef.current = null;
  }, []);

  const cancelCloseUiAssetMenu = useCallback(() => {
    if (!uiAssetMenuCloseTimerRef.current) {
      return;
    }
    clearTimeout(uiAssetMenuCloseTimerRef.current);
    uiAssetMenuCloseTimerRef.current = null;
  }, []);

  const cancelCloseGameAssetMenu = useCallback(() => {
    if (!gameAssetMenuCloseTimerRef.current) {
      return;
    }
    clearTimeout(gameAssetMenuCloseTimerRef.current);
    gameAssetMenuCloseTimerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (styleMenuCloseTimerRef.current) {
        clearTimeout(styleMenuCloseTimerRef.current);
      }
      if (gameAssetMenuCloseTimerRef.current) {
        clearTimeout(gameAssetMenuCloseTimerRef.current);
      }
      if (uiAssetMenuCloseTimerRef.current) {
        clearTimeout(uiAssetMenuCloseTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isStyleMenuOpen) {
      setStyleMenuTop(null);
      return;
    }
    if (!styleButtonRef.current) {
      return;
    }
    setStyleMenuTop(styleButtonRef.current.offsetTop);
  }, [isStyleMenuOpen]);

  useEffect(() => {
    if (!isUiAssetMenuOpen) {
      setUiAssetMenuTop(null);
      return;
    }
    if (!uiAssetButtonRef.current) {
      return;
    }
    setUiAssetMenuTop(uiAssetButtonRef.current.offsetTop);
  }, [isUiAssetMenuOpen]);

  useEffect(() => {
    if (!isGameAssetMenuOpen) {
      setGameAssetMenuTop(null);
      return;
    }
    if (!gameAssetButtonRef.current) {
      return;
    }
    setGameAssetMenuTop(gameAssetButtonRef.current.offsetTop);
  }, [isGameAssetMenuOpen]);

  useEffect(() => {
    if (!isUiAssetMenuOpen) {
      setUiAssetActiveCategoryId(null);
      return;
    }
    if (uiAssetGroups.length === 0) {
      setUiAssetActiveCategoryId(null);
      return;
    }
    setUiAssetActiveCategoryId((prev) => prev ?? uiAssetGroups[0].category.id);
  }, [isUiAssetMenuOpen, uiAssetGroups]);

  useEffect(() => {
    if (!isGameAssetMenuOpen) {
      setGameAssetActiveCategoryId(null);
      return;
    }
    if (gameAssetGroups.length === 0) {
      setGameAssetActiveCategoryId(null);
      return;
    }
    setGameAssetActiveCategoryId((prev) => prev ?? gameAssetGroups[0].category.id);
  }, [isGameAssetMenuOpen, gameAssetGroups]);

  useLayoutEffect(() => {
    if (!isStyleMenuOpen) {
      return;
    }
    if (!styleMenuRef.current || !menuRef.current || typeof styleMenuTop !== 'number') {
      return;
    }

    const wrapperRect = menuRef.current.getBoundingClientRect();
    const menuHeight = styleMenuRef.current.offsetHeight;
    const margin = 8;

    let nextTop = styleMenuTop;
    let absoluteTop = wrapperRect.top + nextTop;
    const bottomOverflow = absoluteTop + menuHeight + margin - window.innerHeight;
    if (bottomOverflow > 0) {
      nextTop = Math.max(0, nextTop - bottomOverflow);
      absoluteTop = wrapperRect.top + nextTop;
    }

    const topOverflow = margin - absoluteTop;
    if (topOverflow > 0) {
      nextTop = Math.max(0, nextTop + topOverflow);
    }

    if (nextTop !== styleMenuTop) {
      setStyleMenuTop(nextTop);
    }
  }, [isStyleMenuOpen, styleMenuTop, styleGroups.length]);

  useLayoutEffect(() => {
    if (!isUiAssetMenuOpen) {
      return;
    }
    if (!uiAssetMenuRef.current || !menuRef.current || typeof uiAssetMenuTop !== 'number') {
      return;
    }

    const wrapperRect = menuRef.current.getBoundingClientRect();
    const menuHeight = uiAssetMenuRef.current.offsetHeight;
    const margin = 8;

    let nextTop = uiAssetMenuTop;
    let absoluteTop = wrapperRect.top + nextTop;
    const bottomOverflow = absoluteTop + menuHeight + margin - window.innerHeight;
    if (bottomOverflow > 0) {
      nextTop = Math.max(0, nextTop - bottomOverflow);
      absoluteTop = wrapperRect.top + nextTop;
    }

    const topOverflow = margin - absoluteTop;
    if (topOverflow > 0) {
      nextTop = Math.max(0, nextTop + topOverflow);
    }

    if (nextTop !== uiAssetMenuTop) {
      setUiAssetMenuTop(nextTop);
    }
  }, [isUiAssetMenuOpen, uiAssetMenuTop, uiAssetGroups.length]);

  useLayoutEffect(() => {
    if (!isGameAssetMenuOpen) {
      return;
    }
    if (!gameAssetMenuRef.current || !menuRef.current || typeof gameAssetMenuTop !== 'number') {
      return;
    }

    const wrapperRect = menuRef.current.getBoundingClientRect();
    const menuHeight = gameAssetMenuRef.current.offsetHeight;
    const margin = 8;

    let nextTop = gameAssetMenuTop;
    let absoluteTop = wrapperRect.top + nextTop;
    const bottomOverflow = absoluteTop + menuHeight + margin - window.innerHeight;
    if (bottomOverflow > 0) {
      nextTop = Math.max(0, nextTop - bottomOverflow);
      absoluteTop = wrapperRect.top + nextTop;
    }

    const topOverflow = margin - absoluteTop;
    if (topOverflow > 0) {
      nextTop = Math.max(0, nextTop + topOverflow);
    }

    if (nextTop !== gameAssetMenuTop) {
      setGameAssetMenuTop(nextTop);
    }
  }, [isGameAssetMenuOpen, gameAssetMenuTop, gameAssetGroups.length]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      handleClose();
    };

    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [handleClose]);

  return (
    <div ref={menuRef} className="absolute z-50" style={{ left: position.x, top: position.y }}>
      <div
        className={`
          min-w-[220px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
          transition-opacity duration-150
          ${isVisible ? 'opacity-100' : 'opacity-0'}
        `}
        onMouseLeave={() => {
          if (isStyleMenuOpen) {
            scheduleCloseStyleMenu();
          }
          if (isGameAssetMenuOpen) {
            scheduleCloseGameAssetMenu();
          }
          if (isUiAssetMenuOpen) {
            scheduleCloseUiAssetMenu();
          }
        }}
      >
        {menuItems.map((item, index) => {
          const Icon = iconMap[item.menuIcon] ?? Image;
          return (
            <button
              key={item.type}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
              style={{ transitionDelay: isVisible ? `${index * 30}ms` : '0ms' }}
              onClick={() => {
                handleClose();
                setTimeout(() => onSelect(item.type), UI_POPOVER_TRANSITION_MS + 10);
              }}
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
                <Icon className="h-4 w-4 text-accent" />
              </div>
              <span className="text-sm text-text-dark">{t(item.menuLabelKey)}</span>
            </button>
          );
        })}

        {canShowPromptEngineerEntry && (
          <button
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            onClick={() => {
              handleClose();
              setTimeout(() => onSelectPromptEngineer?.(), UI_POPOVER_TRANSITION_MS + 10);
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
              <Wand2 className="h-4 w-4 text-accent" />
            </div>
            <span className="text-sm text-text-dark">{t('promptCraft.menu')}</span>
          </button>
        )}

        {canShowGameAssetEntry && (
          <button
            ref={gameAssetButtonRef}
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            onMouseEnter={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsGameAssetMenuOpen(true);
            }}
            onFocus={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsGameAssetMenuOpen(true);
            }}
            onClick={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsGameAssetMenuOpen((prev) => !prev);
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
              <LayoutGrid className="h-4 w-4 text-accent" />
            </div>
            <span className="text-sm text-text-dark">{t('gameAsset.menu')}</span>
            <div className="ml-auto text-text-muted">
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        )}

        {canShowStyleEntry && (
          <button
            ref={styleButtonRef}
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            onMouseEnter={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsStyleMenuOpen(true);
            }}
            onFocus={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsStyleMenuOpen(true);
            }}
            onClick={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen(false);
              setIsStyleMenuOpen((prev) => !prev);
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
              <Sparkles className="h-4 w-4 text-accent" />
            </div>
            <span className="text-sm text-text-dark">{t('style.menu')}</span>
            <div className="ml-auto text-text-muted">
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        )}

        {canShowUiAssetEntry && (
          <button
            ref={uiAssetButtonRef}
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            onMouseEnter={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen(true);
            }}
            onFocus={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen(true);
            }}
            onClick={() => {
              cancelCloseStyleMenu();
              cancelCloseGameAssetMenu();
              cancelCloseUiAssetMenu();
              setIsStyleMenuOpen(false);
              setIsGameAssetMenuOpen(false);
              setIsUiAssetMenuOpen((prev) => !prev);
            }}
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-bg-dark">
              <LayoutGrid className="h-4 w-4 text-accent" />
            </div>
            <span className="text-sm text-text-dark">{t('uiAsset.menu')}</span>
            <div className="ml-auto text-text-muted">
              <ChevronRight className="h-4 w-4" />
            </div>
          </button>
        )}
      </div>

      {canShowStyleEntry && isStyleMenuOpen && styleButtonRef.current && (
        <div
          ref={styleMenuRef}
          className={`
            absolute left-full min-w-[280px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
            transition-opacity duration-150
            ${isVisible ? 'opacity-100' : 'opacity-0'}
          `}
          style={{ top: styleMenuTop ?? styleButtonRef.current.offsetTop }}
          onMouseEnter={() => {
            cancelCloseStyleMenu();
          }}
          onMouseLeave={() => {
            scheduleCloseStyleMenu();
          }}
        >
          <div className="max-h-[420px] ui-scrollbar overflow-auto py-1">
            {styleGroups.map((group) => (
              <div key={group.category.id} className="py-1">
                <div className="px-3 py-1 text-xs text-text-muted">{t(group.category.labelKey)}</div>
                {group.items.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-dark"
                    onClick={() => {
                      if (!onSelectStyle) {
                        return;
                      }
                      handleClose();
                      setTimeout(() => onSelectStyle(preset.id), UI_POPOVER_TRANSITION_MS + 10);
                    }}
                  >
                    <span className="text-text-dark">{t(preset.labelKey)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {canShowGameAssetEntry && isGameAssetMenuOpen && gameAssetButtonRef.current && (
        <div
          ref={gameAssetMenuRef}
          className={`
            absolute left-full min-w-[260px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
            transition-opacity duration-150
            ${isVisible ? 'opacity-100' : 'opacity-0'}
          `}
          style={{ top: gameAssetMenuTop ?? gameAssetButtonRef.current.offsetTop }}
          onMouseEnter={() => {
            cancelCloseGameAssetMenu();
          }}
          onMouseLeave={() => {
            scheduleCloseGameAssetMenu();
          }}
        >
          <div className="flex max-h-[420px]">
            <div className="min-w-[180px] border-r border-border-dark ui-scrollbar overflow-auto py-1">
              {gameAssetGroups.map((group) => (
                <button
                  key={group.category.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-dark ${gameAssetActiveCategoryId === group.category.id ? 'bg-bg-dark/60' : ''}`}
                  onMouseEnter={() => {
                    setGameAssetActiveCategoryId(group.category.id);
                  }}
                  onFocus={() => {
                    setGameAssetActiveCategoryId(group.category.id);
                  }}
                >
                  <span className="text-text-dark">{t(group.category.labelKey)}</span>
                  <div className="ml-auto text-text-muted">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </button>
              ))}
            </div>

            <div className="min-w-[320px] ui-scrollbar overflow-auto py-1">
              {gameAssetGroups
                .filter((group) => group.category.id === gameAssetActiveCategoryId)
                .flatMap((group) => group.items)
                .map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-dark"
                    onClick={() => {
                      if (!onSelectGameAssetTemplate) {
                        return;
                      }
                      handleClose();
                      setTimeout(
                        () => onSelectGameAssetTemplate(template.id),
                        UI_POPOVER_TRANSITION_MS + 10
                      );
                    }}
                  >
                    <span className="text-text-dark">{t(template.labelKey)}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {canShowUiAssetEntry && isUiAssetMenuOpen && uiAssetButtonRef.current && (
        <div
          ref={uiAssetMenuRef}
          className={`
            absolute left-full min-w-[260px] overflow-hidden rounded-lg border border-border-dark bg-surface-dark shadow-xl
            transition-opacity duration-150
            ${isVisible ? 'opacity-100' : 'opacity-0'}
          `}
          style={{ top: uiAssetMenuTop ?? uiAssetButtonRef.current.offsetTop }}
          onMouseEnter={() => {
            cancelCloseUiAssetMenu();
          }}
          onMouseLeave={() => {
            scheduleCloseUiAssetMenu();
          }}
        >
          <div className="flex max-h-[420px]">
            <div className="min-w-[180px] border-r border-border-dark ui-scrollbar overflow-auto py-1">
              {uiAssetGroups.map((group) => (
                <button
                  key={group.category.id}
                  type="button"
                  className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-dark ${uiAssetActiveCategoryId === group.category.id ? 'bg-bg-dark/60' : ''}`}
                  onMouseEnter={() => {
                    setUiAssetActiveCategoryId(group.category.id);
                  }}
                  onFocus={() => {
                    setUiAssetActiveCategoryId(group.category.id);
                  }}
                >
                  <span className="text-text-dark">{t(group.category.labelKey)}</span>
                  <div className="ml-auto text-text-muted">
                    <ChevronRight className="h-4 w-4" />
                  </div>
                </button>
              ))}
            </div>

            <div className="min-w-[300px] ui-scrollbar overflow-auto py-1">
              {uiAssetGroups
                .filter((group) => group.category.id === uiAssetActiveCategoryId)
                .flatMap((group) => group.items)
                .map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-dark"
                    onClick={() => {
                      if (!onSelectUiAssetPreset) {
                        return;
                      }
                      handleClose();
                      setTimeout(
                        () => onSelectUiAssetPreset(preset.id),
                        UI_POPOVER_TRANSITION_MS + 10
                      );
                    }}
                  >
                    <span className="text-text-dark">{t(preset.labelKey)}</span>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
