import { useMemo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image, Upload, Sparkles, LayoutGrid, Type, ChevronRight } from 'lucide-react';
import { UI_POPOVER_TRANSITION_MS } from '@/components/ui/motion';

import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import type { MenuIconKey } from '@/features/canvas/domain/nodeRegistry';
import { builtInStyleCategories, builtInStylePresets } from '@/features/canvas/styles/builtInStyles';

interface NodeSelectionMenuProps {
  position: { x: number; y: number };
  allowedTypes?: CanvasNodeType[];
  onSelect: (type: CanvasNodeType) => void;
  onSelectStyle?: (styleId: string) => void;
  onClose: () => void;
}

const iconMap: Record<MenuIconKey, typeof Upload> = {
  upload: Upload,
  sparkles: Sparkles,
  layout: LayoutGrid,
  text: Type,
};

export function NodeSelectionMenu({
  position,
  allowedTypes,
  onSelect,
  onSelectStyle,
  onClose,
}: NodeSelectionMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const styleButtonRef = useRef<HTMLButtonElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isStyleMenuOpen, setIsStyleMenuOpen] = useState(false);
  const styleMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const styleMenuRef = useRef<HTMLDivElement | null>(null);
  const [styleMenuTop, setStyleMenuTop] = useState<number | null>(null);

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

  const cancelCloseStyleMenu = useCallback(() => {
    if (!styleMenuCloseTimerRef.current) {
      return;
    }
    clearTimeout(styleMenuCloseTimerRef.current);
    styleMenuCloseTimerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      if (styleMenuCloseTimerRef.current) {
        clearTimeout(styleMenuCloseTimerRef.current);
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

        {canShowStyleEntry && (
          <button
            ref={styleButtonRef}
            type="button"
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-bg-dark"
            onMouseEnter={() => {
              cancelCloseStyleMenu();
              setIsStyleMenuOpen(true);
            }}
            onFocus={() => {
              cancelCloseStyleMenu();
              setIsStyleMenuOpen(true);
            }}
            onClick={() => {
              cancelCloseStyleMenu();
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
    </div>
  );
}
