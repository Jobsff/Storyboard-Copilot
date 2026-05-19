import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ImageDown, Crop, PenTool, Grid3x3, ArrowLeft } from 'lucide-react';
import { ImageResizeTool } from './ImageResizeTool';
import { ImageCropTool } from './ImageCropTool';
import { ImageAnnotateTool } from './ImageAnnotateTool';
import { ImageSplitTool } from './ImageSplitTool';

type ToolId = 'imageResize' | 'imageCrop' | 'imageAnnotate' | 'imageSplit' | null;

interface ToolDef {
  id: ToolId;
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}

const TOOLS: ToolDef[] = [
  { id: 'imageResize', icon: <ImageDown className="w-8 h-8" />, titleKey: 'imageTool.resizeTitle', descKey: 'imageTool.resizeDesc' },
  { id: 'imageCrop', icon: <Crop className="w-8 h-8" />, titleKey: 'imageTool.cropTitle', descKey: 'imageTool.cropDesc' },
  { id: 'imageAnnotate', icon: <PenTool className="w-8 h-8" />, titleKey: 'imageTool.annotateTitle', descKey: 'imageTool.annotateDesc' },
  { id: 'imageSplit', icon: <Grid3x3 className="w-8 h-8" />, titleKey: 'imageTool.splitTitle', descKey: 'imageTool.splitDesc' },
];

const TOOL_COMPONENTS: Record<string, React.ComponentType> = {
  imageResize: ImageResizeTool,
  imageCrop: ImageCropTool,
  imageAnnotate: ImageAnnotateTool,
  imageSplit: ImageSplitTool,
};

export function ImageToolPage() {
  const { t } = useTranslation();
  const [activeTool, setActiveTool] = useState<ToolId>(null);

  if (activeTool) {
    const ToolComponent = TOOL_COMPONENTS[activeTool];
    return (
      <div className="ui-scrollbar h-full w-full overflow-auto p-8">
        <div className="max-w-5xl mx-auto">
          <button
            type="button"
            onClick={() => setActiveTool(null)}
            className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text-dark mb-6 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('imageTool.backToToolbox')}
          </button>
          <ToolComponent />
        </div>
      </div>
    );
  }

  return (
    <div className="ui-scrollbar h-full w-full overflow-auto p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-text-dark mb-8">{t('imageTool.title')}</h1>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => setActiveTool(tool.id)}
              className="flex flex-col items-center gap-3 p-6 rounded-xl border border-border-dark bg-surface-dark hover:border-accent/50 hover:shadow-lg transition-all group"
            >
              <div className="text-text-muted group-hover:text-accent transition-colors">
                {tool.icon}
              </div>
              <div className="text-sm font-medium text-text-dark">{t(tool.titleKey)}</div>
              <div className="text-xs text-text-muted text-center">{t(tool.descKey)}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
