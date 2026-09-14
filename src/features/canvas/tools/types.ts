import type { CanvasNode, NodeToolType } from '../domain/canvasNodes';
import type { ToolProcessorResult } from '../application/ports';

export type ToolOptionPrimitive = string | number | boolean;
export type ToolOptions = Record<string, ToolOptionPrimitive>;

interface ToolFieldBase {
  key: string;
  label: string;
  labelKey?: string;
}

export interface ToolTextField extends ToolFieldBase {
  type: 'text';
  placeholder?: string;
  placeholderKey?: string;
}

export interface ToolNumberField extends ToolFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
}

export interface ToolSelectField extends ToolFieldBase {
  type: 'select';
  options: Array<{
    label: string;
    labelKey?: string;
    value: string;
  }>;
}

export interface ToolColorField extends ToolFieldBase {
  type: 'color';
}

export type ToolFieldSchema =
  | ToolTextField
  | ToolNumberField
  | ToolSelectField
  | ToolColorField;

export interface ToolExecutionContext {
  processTool: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export type ToolIconKey = 'crop' | 'annotate' | 'split' | 'scale' | 'matting' | 'aiMatting' | 'aiBirefMatting';
export type ToolEditorKind = 'form' | 'crop' | 'annotate' | 'split' | 'matting' | 'aiMatting';

export interface CanvasToolPlugin {
  type: NodeToolType;
  label: string;
  icon: ToolIconKey;
  /** 编辑器插槽；immediate 工具（点击即执行，如 AI 去底）无编辑器，省略本字段。 */
  editor?: ToolEditorKind;
  /** true = 工具条按钮点击直接执行（loading 转圈，结果落新节点），不开工具对话框。 */
  immediate?: boolean;
  supportsNode: (node: CanvasNode) => boolean;
  createInitialOptions: (node: CanvasNode) => ToolOptions;
  fields: ToolFieldSchema[];
  /** 可选：按当前 options 判定是否允许应用（如 matting 未取色时禁用应用按钮）。 */
  isApplyEnabled?: (options: ToolOptions) => boolean;
  execute: (
    sourceImageUrl: string,
    options: ToolOptions,
    context: ToolExecutionContext
  ) => Promise<ToolProcessorResult>;
}
