import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { UiChipButton } from '@/components/ui';
import { useProjectStore } from '@/stores/projectStore';

/** 巨游资产画廊（批次12）：内嵌公司画廊 Web 页，与桶直链同一资产的浏览入口。 */
const GALLERY_URL = 'https://tu.jyounet.com/';

export function GalleryPage() {
  const { t } = useTranslation();
  const setCurrentPage = useProjectStore((state) => state.setCurrentPage);
  const [isFrameLoaded, setIsFrameLoaded] = useState(false);

  const handleBack = () => {
    // 返回工程：currentProjectId 未清空 → 有工程直接回画布，无工程回项目首页。
    setCurrentPage('projects');
  };

  const handleOpenInBrowser = () => {
    void openUrl(GALLERY_URL);
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-bg-dark">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border-dark bg-surface-dark px-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleBack}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            title={t('gallery.backToWorkspace')}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('gallery.backToWorkspace')}
          </button>
          <span className="text-sm font-semibold text-text-dark">{t('gallery.title')}</span>
        </div>
        <UiChipButton
          type="button"
          className="h-7 rounded-md px-2 text-xs"
          onClick={handleOpenInBrowser}
          title={t('gallery.openInBrowser')}
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {t('gallery.openInBrowser')}
        </UiChipButton>
      </div>

      <div className="relative flex-1">
        {!isFrameLoaded && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-bg-dark">
            <Loader2 className="h-7 w-7 animate-spin text-text-muted" />
          </div>
        )}
        <iframe
          src={GALLERY_URL}
          title={t('gallery.title')}
          className="h-full w-full border-0"
          onLoad={() => setIsFrameLoaded(true)}
        />
      </div>
    </div>
  );
}
