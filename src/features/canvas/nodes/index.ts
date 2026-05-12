import type { NodeTypes } from '@xyflow/react';

import { GroupNode } from './GroupNode';
import { ImageEditNode } from './ImageEditNode';
import { ImageNode } from './ImageNode';
import { StoryboardGenNode } from './StoryboardGenNode';
import { StoryboardNode } from './StoryboardNode';
import { SpineNode } from './SpineNode';
import { TextAnnotationNode } from './TextAnnotationNode';
import { UploadNode } from './UploadNode';
import { VideoEditNode } from './VideoEditNode';
import { VideoNode } from './VideoNode';

export const nodeTypes: NodeTypes = {
  exportImageNode: ImageNode,
  exportVideoNode: VideoNode,
  groupNode: GroupNode,
  imageNode: ImageEditNode,
  imageAutoPromptNode: ImageEditNode,
  imageAutoPromptZhNode: ImageEditNode,
  imageAutoPromptJsonNode: ImageEditNode,
  spineNode: SpineNode,
  storyboardGenNode: StoryboardGenNode,
  storyboardNode: StoryboardNode,
  textAnnotationNode: TextAnnotationNode,
  uploadNode: UploadNode,
  videoNode: VideoEditNode,
};

export { GroupNode, ImageEditNode, ImageNode, SpineNode, StoryboardGenNode, StoryboardNode, TextAnnotationNode, UploadNode, VideoEditNode, VideoNode };
