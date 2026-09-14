import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, NODE_TOOL_TYPES, type CanvasNode } from '../../domain/canvasNodes';
import { getNodeToolPlugins, getToolPlugin } from '../registry';

function makeNode(type: string, imageUrl = 'data:image/png;base64,xxx'): CanvasNode {
  return { id: 'n1', type, position: { x: 0, y: 0 }, data: { imageUrl } } as unknown as CanvasNode;
}

describe('AI 去底（BiRefNet）immediate 工具注册', () => {
  it('NODE_TOOL_TYPES.aiBirefMatting 已注册且可取到插件', () => {
    expect(NODE_TOOL_TYPES.aiBirefMatting).toBe('ai-biref-matting');
    const plugin = getToolPlugin(NODE_TOOL_TYPES.aiBirefMatting);
    expect(plugin).not.toBeNull();
    expect(plugin?.label).toBe('AI 去底');
  });

  it('immediate=true 且无编辑器插槽（点击即执行，不开对话框）', () => {
    const plugin = getToolPlugin(NODE_TOOL_TYPES.aiBirefMatting);
    expect(plugin?.immediate).toBe(true);
    expect(plugin?.editor).toBeUndefined();
    expect(plugin?.fields).toEqual([]);
  });

  it('supportsNode：upload/imageEdit/exportImage 有图才出现，无图/其他节点不出现', () => {
    const plugin = getToolPlugin(NODE_TOOL_TYPES.aiBirefMatting);
    expect(plugin?.supportsNode(makeNode(CANVAS_NODE_TYPES.upload))).toBe(true);
    expect(plugin?.supportsNode(makeNode(CANVAS_NODE_TYPES.imageEdit))).toBe(true);
    expect(plugin?.supportsNode(makeNode(CANVAS_NODE_TYPES.exportImage))).toBe(true);
    expect(plugin?.supportsNode(makeNode(CANVAS_NODE_TYPES.upload, ''))).toBe(false);
    expect(plugin?.supportsNode(makeNode(CANVAS_NODE_TYPES.textAnnotation))).toBe(false);
  });

  it('有图节点的工具列表包含 AI 去底（排在 AI 抠图之后）', () => {
    const tools = getNodeToolPlugins(makeNode(CANVAS_NODE_TYPES.upload));
    const types = tools.map((tool) => tool.type);
    expect(types).toContain(NODE_TOOL_TYPES.aiBirefMatting);
    expect(types.indexOf(NODE_TOOL_TYPES.aiBirefMatting)).toBeGreaterThan(
      types.indexOf(NODE_TOOL_TYPES.aiMatting)
    );
  });

  it('execute 透传 processTool（结果落地由工具条/对话框链路承担）', async () => {
    const plugin = getToolPlugin(NODE_TOOL_TYPES.aiBirefMatting);
    const seen: string[] = [];
    const result = await plugin!.execute('data:image/png;base64,src', {}, {
      processTool: async (toolType, imageUrl) => {
        seen.push(`${toolType}|${imageUrl}`);
        return { outputImageUrl: 'data:image/png;base64,rgba' };
      },
    });
    expect(seen).toEqual([`${NODE_TOOL_TYPES.aiBirefMatting}|data:image/png;base64,src`]);
    expect(result.outputImageUrl).toBe('data:image/png;base64,rgba');
  });
});
