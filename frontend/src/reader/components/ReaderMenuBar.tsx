/**
 * ReaderMenuBar — 阅读器底部菜单栏（自顶栏迁移，仅保留底部）
 *
 * 顺序：目录 | 书名（居中截断） | 搜索 · aA
 * 颜色随阅读主题（chromeBackground/chromeColor 由 ReaderPage 按主题注入）。
 * 搜索按钮仅在提供对应回调时渲染（向后兼容）。
 * 返回书架/书签/全屏按钮已于 2.51.0 移除（返回靠系统手势/浏览器后退）。
 */

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface ReaderMenuBarProps {
  title: string;
  chromeBackground: string;
  chromeColor: string;
  onOpenToc: () => void;
  onOpenFontSettings: () => void;
  onOpenSearch?: () => void;
}

export function ReaderMenuBar({
  title,
  chromeBackground,
  chromeColor,
  onOpenToc,
  onOpenFontSettings,
  onOpenSearch,
}: ReaderMenuBarProps) {
  return (
    <div
      data-testid="reader-menu-bar"
      className="flex items-center h-14 px-2 backdrop-blur-xl border-t"
      style={{ background: chromeBackground, color: chromeColor, borderColor: 'rgba(128,128,128,0.25)' }}
    >
      <IconButton
        variant="ghost"
        onClick={onOpenToc}
        aria-label="目录"
        className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="16" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </IconButton>
      <p className="flex-1 text-center text-[15px] font-medium truncate px-2">{title}</p>
      <div className="flex items-center">
        {onOpenSearch && (
          <IconButton
            variant="ghost"
            onClick={onOpenSearch}
            aria-label="搜索"
            className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
          </IconButton>
        )}
        <Button
          variant="ghost"
          onClick={onOpenFontSettings}
          aria-label="字体与主题"
          className="!h-auto !px-2.5 !py-2 !rounded-lg !text-current active:opacity-40 transition-opacity text-[17px] leading-none font-medium tracking-tight"
        >
          aA
        </Button>
      </div>
    </div>
  );
}
