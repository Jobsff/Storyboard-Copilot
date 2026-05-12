import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Application } from '@pixi/app';
import { Assets } from '@pixi/assets';
import '@pixi-spine/loader-uni';
import { TextureAtlas } from '@pixi-spine/base';
import { Spine } from 'pixi-spine';

import { CANVAS_NODE_TYPES, type SpineNodeData } from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { persistSpinePackageFiles } from '@/commands/assets';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { useCanvasStore } from '@/stores/canvasStore';
import { UiButton, UiSelect } from '@/components/ui';

type SpineNodeProps = NodeProps & {
  id: string;
  data: SpineNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 560;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 480;

export const SpineNode = memo(function SpineNode({ id, data, selected, width, height }: SpineNodeProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const title = useMemo(() => resolveNodeDisplayName(CANVAS_NODE_TYPES.spine, data), [data]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pixiAppRef = useRef<Application | null>(null);
  const spineRef = useRef<Spine | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [availableAnimations, setAvailableAnimations] = useState<string[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  const fitToContainer = useCallback(() => {
    const container = containerRef.current;
    const spine = spineRef.current;
    if (!container || !spine) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const bounds = spine.getLocalBounds();
    if (!bounds.width || !bounds.height) {
      return;
    }

    const scale = Math.min((width * 0.985) / bounds.width, (height * 0.985) / bounds.height);
    spine.scale.set(scale);
    spine.pivot.set(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    spine.position.set(width / 2, height / 2);
  }, []);

  const handleImport = useCallback(async () => {
    if (!isTauri()) {
      await showErrorDialog(t('spine.importRequiresTauri'), t('spine.importFailedTitle'));
      return;
    }

    try {
      setIsImporting(true);
      const selection = await open({
        multiple: true,
        filters: [
          {
            name: t('spine.fileType'),
            extensions: ['json', 'atlas', 'png'],
          },
        ],
      });

      const selectedPaths = Array.isArray(selection) ? selection : selection ? [selection] : [];
      if (selectedPaths.length === 0) {
        return;
      }

      const jsonCandidates = selectedPaths.filter((path) => path.toLowerCase().endsWith('.json'));
      const atlasCandidates = selectedPaths.filter((path) => path.toLowerCase().endsWith('.atlas'));
      const pngCandidates = selectedPaths.filter((path) => path.toLowerCase().endsWith('.png'));

      if (jsonCandidates.length !== 1 || atlasCandidates.length !== 1 || pngCandidates.length < 1) {
        await showErrorDialog(t('spine.invalidSelection'), t('spine.importFailedTitle'));
        return;
      }

      const atlasText = await fetch(convertFileSrc(atlasCandidates[0])).then((res) => res.text());
      const atlasPages = extractAtlasPageNames(atlasText);
      const atlasPageSizes = extractAtlasPageSizes(atlasText);
      const pngNameSet = new Set(pngCandidates.map((path) => (path.split(/[\\/]/).pop() ?? '').toLowerCase()));
      const missingPages = atlasPages.filter((name) => !pngNameSet.has(name.toLowerCase()));
      if (missingPages.length > 0) {
        await showErrorDialog(
          t('spine.missingTextures', { count: missingPages.length }),
          t('spine.importFailedTitle'),
          missingPages.join('\n')
        );
        return;
      }

      for (const pageName of atlasPages) {
        const declaredSize = atlasPageSizes.get(pageName);
        if (!declaredSize) {
          continue;
        }
        const imagePath = pngCandidates.find((path) => (path.split(/[\\/]/).pop() ?? '') === pageName);
        if (!imagePath) {
          continue;
        }
        const actualSize = await loadImageSize(convertFileSrc(imagePath));
        if (!actualSize) {
          continue;
        }
        if (actualSize.width !== declaredSize.width || actualSize.height !== declaredSize.height) {
          await showErrorDialog(
            t('spine.atlasImageSizeMismatch'),
            t('spine.importFailedTitle'),
            `${pageName}\nAtlas: ${declaredSize.width}x${declaredSize.height}\nImage: ${actualSize.width}x${actualSize.height}`
          );
          return;
        }
      }

      const persisted = await persistSpinePackageFiles(selectedPaths);
      const jsonName = jsonCandidates[0].split(/[\\/]/).pop() ?? '';
      const atlasName = atlasCandidates[0].split(/[\\/]/).pop() ?? '';
      const texturePaths = (atlasPages.length > 0
        ? atlasPages
        : pngCandidates.map((path) => path.split(/[\\/]/).pop() ?? '')
      )
        .map((name) => persisted.files[name])
        .filter((path): path is string => typeof path === 'string' && path.length > 0);

      updateNodeData(id, {
        spineJsonPath: persisted.files[jsonName] ?? null,
        spineAtlasPath: persisted.files[atlasName] ?? null,
        spineTexturePaths: texturePaths,
        spineAnimation: null,
        spineSkin: null,
        error: null,
      });
    } catch (error) {
      const content = resolveErrorContent(error, t('spine.importFailed'));
      await showErrorDialog(content.message, t('spine.importFailedTitle'), content.details);
    } finally {
      setIsImporting(false);
    }
  }, [id, t, updateNodeData]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    if (!isTauri() || !data.spineJsonPath || !data.spineAtlasPath) {
      return;
    }

    let cancelled = false;

    const destroy = () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      spineRef.current?.destroy({ children: true, texture: false, baseTexture: false });
      spineRef.current = null;
      pixiAppRef.current?.destroy(true);
      pixiAppRef.current = null;
      container.replaceChildren();
    };

    destroy();

    const run = async () => {
      const app = new Application({
        backgroundAlpha: 0,
        antialias: true,
        resizeTo: container,
      });
      pixiAppRef.current = app;
      container.appendChild(app.view as HTMLCanvasElement);

      try {
        const jsonUrl = convertFileSrc(data.spineJsonPath!);
        const atlasUrl = convertFileSrc(data.spineAtlasPath!);

        const atlasText = await fetch(atlasUrl).then((res) => res.text());
        const atlasPages = extractAtlasPageNames(atlasText);
        const texturePathByName = new Map<string, string>();
        for (const texturePath of data.spineTexturePaths) {
          const name = texturePath.split(/[\\/]/).pop() ?? '';
          if (name) {
            texturePathByName.set(name, texturePath);
          }
        }

        const texturesByName: Record<string, unknown> = {};
        const preloadTargets = atlasPages.length > 0 ? atlasPages : Array.from(texturePathByName.keys());
        for (const pageName of preloadTargets) {
          const path = texturePathByName.get(pageName);
          if (!path) {
            continue;
          }
          const url = convertFileSrc(path);
          texturesByName[pageName] = await Assets.load(url);
        }

        const spineAtlas = await buildSpineAtlas(atlasText, texturesByName);
        const resource = (await Assets.load({
          src: jsonUrl,
          data: {
            spineAtlas,
          },
        })) as unknown as { spineData?: unknown };

        if (cancelled) {
          app.destroy(true);
          return;
        }

        const spineData = (resource as { spineData?: unknown } | null)?.spineData;
        if (!spineData) {
          throw new Error('Failed to load spine data');
        }

        const spine = new Spine(spineData as never);
        spineRef.current = spine;
        app.stage.addChild(spine);
        spine.update(0);
        spine.updateTransform();
        if (data.error) {
          updateNodeData(id, { error: null });
        }

        const animationNames = (spine.spineData as { animations?: { name: string }[] } | undefined)?.animations?.map(
          (animation) => animation.name
        ) ?? [];
        setAvailableAnimations(animationNames);

        const desiredAnimation = data.spineAnimation ?? animationNames[0] ?? null;
        if (desiredAnimation && desiredAnimation !== data.spineAnimation) {
          updateNodeData(id, { spineAnimation: desiredAnimation });
        }

        if (desiredAnimation) {
          spine.state.setAnimation(0, desiredAnimation, data.loop);
        }
        spine.state.timeScale = data.timeScale;

        fitToContainer();
        requestAnimationFrame(() => fitToContainer());
        requestAnimationFrame(() => fitToContainer());
        resizeObserverRef.current = new ResizeObserver(() => {
          fitToContainer();
        });
        resizeObserverRef.current.observe(container);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateNodeData(id, { error: message });
      }
    };

    run();

    return () => {
      cancelled = true;
      destroy();
    };
  }, [
    data.loop,
    data.spineAnimation,
    data.spineAtlasPath,
    data.spineJsonPath,
    data.timeScale,
    fitToContainer,
    id,
    updateNodeData,
  ]);

  const handleAnimationChange = useCallback(
    (nextAnimation: string) => {
      updateNodeData(id, { spineAnimation: nextAnimation });
      const spine = spineRef.current;
      if (spine) {
        spine.state.setAnimation(0, nextAnimation, data.loop);
      }
    },
    [data.loop, id, updateNodeData]
  );

  return (
    <div
      className={`
        group relative h-full w-full overflow-visible rounded-[var(--node-radius)] border bg-surface-dark
        ${selected
          ? 'border-accent shadow-[0_0_0_1px_rgba(59,130,246,0.32)]'
          : 'border-[rgba(15,23,42,0.22)] hover:border-[rgba(15,23,42,0.34)] dark:border-[rgba(255,255,255,0.22)] dark:hover:border-[rgba(255,255,255,0.34)]'}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        titleText={title}
        titleClassName="inline-block max-w-[260px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] bg-bg-dark">
        <div className="flex items-center justify-between gap-2 border-b border-border-dark bg-surface-dark/40 px-2 py-2">
          <div className="flex items-center gap-2">
            <UiButton variant="muted" size="sm" onClick={handleImport} disabled={isImporting}>
              {isImporting ? t('spine.importing') : t('spine.import')}
            </UiButton>
            {availableAnimations.length > 0 && (
              <UiSelect
                value={data.spineAnimation ?? availableAnimations[0] ?? ''}
                onChange={(e) => handleAnimationChange(e.target.value)}
              >
                {availableAnimations.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </UiSelect>
            )}
          </div>
        </div>

        <div ref={containerRef} className="min-h-0 flex-1" />

        {typeof data.error === 'string' && data.error.trim().length > 0 && (
          <div className="border-t border-border-dark bg-surface-dark/55 px-2 py-1 text-xs text-text-muted">
            {data.error}
          </div>
        )}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-accent"
      />
      <NodeResizeHandle minWidth={MIN_WIDTH} minHeight={MIN_HEIGHT} maxWidth={1400} maxHeight={1400} />
    </div>
  );
});

SpineNode.displayName = 'SpineNode';

function extractAtlasPageNames(atlasText: string): string[] {
  const lines = atlasText.split(/\r?\n/);
  const pages: string[] = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const name = lines[i].trim();
    if (!name || name.includes(':')) {
      continue;
    }

    const nextLine = lines[i + 1]?.trim() ?? '';
    const lower = name.toLowerCase();
    const isImage = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp');
    if (!isImage) {
      continue;
    }

    if (!nextLine.startsWith('size:')) {
      continue;
    }

    pages.push(name.split(/[\\/]/).pop() ?? name);
  }
  return Array.from(new Set(pages));
}

function extractAtlasPageSizes(atlasText: string): Map<string, { width: number; height: number }> {
  const lines = atlasText.split(/\r?\n/);
  const result = new Map<string, { width: number; height: number }>();
  for (let i = 0; i < lines.length - 1; i += 1) {
    const pageName = lines[i].trim();
    if (!pageName || pageName.includes(':')) {
      continue;
    }
    const sizeLine = lines[i + 1]?.trim() ?? '';
    if (!sizeLine.startsWith('size:')) {
      continue;
    }
    const match = sizeLine.match(/size:\s*(\d+)\s*,\s*(\d+)/);
    if (!match) {
      continue;
    }
    const width = Number.parseInt(match[1], 10);
    const height = Number.parseInt(match[2], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      continue;
    }
    result.set(pageName.split(/[\\/]/).pop() ?? pageName, { width, height });
  }
  return result;
}

function loadImageSize(url: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function buildSpineAtlas(atlasText: string, texturesByName: Record<string, unknown>): Promise<TextureAtlas> {
  return new Promise((resolve, reject) => {
    new TextureAtlas(
      atlasText,
      (line, callback) => {
        const key = line.split(/[\\/]/).pop() ?? line;
        const texture = texturesByName[key];
        if (!texture) {
          callback(null as never);
          return;
        }
        const baseTexture = (texture as { baseTexture?: unknown } | null)?.baseTexture;
        callback((baseTexture ?? texture) as never);
      },
      (newAtlas) => {
        if (!newAtlas) {
          reject(new Error('Failed to parse spine atlas'));
          return;
        }
        resolve(newAtlas);
      }
    );
  });
}
