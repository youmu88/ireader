/**
 * ReaderMenuBar — 阅读器底部菜单栏（自顶栏迁移，仅保留底部）
 *
 * 顺序：‹ 返回书库 | 目录 | 书名（居中截断） | 书签 · 搜索 · aA
 * 颜色随阅读主题（chromeBackground/chromeColor 由 ReaderPage 按主题注入）。
 * 书签/搜索按钮仅在提供对应回调时渲染（向后兼容）。
 */

import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface ReaderMenuBarProps {
  title: string;
  chromeBackground: string;
  chromeColor: string;
  onBack: () => void;
  onOpenToc: () => void;
  onOpenFontSettings: () => void;
  /** 当前页是否已加书签（控制图标实心/空心） */
  bookmarked?: boolean;
  onToggleBookmark?: () => void;
  onOpenSearch?: () => void;
  /** 全屏状态（Fullscreen API 生效中）与切换回调（可选，不传则不渲染按钮） */
  fullscreenActive?: boolean;
  onToggleFullscreen?: () => void;
}

const BookmarkIcon = ({ filled }: { filled: boolean }) =>
  filled ? (
    <svg width="18" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.9L5 21V4a1 1 0 0 1 1-1z" />
    </svg>
  ) : (
    <svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.9L5 21V4a1 1 0 0 1 1-1z" />
    </svg>
  );

export function ReaderMenuBar({
  title,
  chromeBackground,
  chromeColor,
  onBack,
  onOpenToc,
  onOpenFontSettings,
  bookmarked = false,
  onToggleBookmark,
  onOpenSearch,
  fullscreenActive = false,
  onToggleFullscreen,
}: ReaderMenuBarProps) {
  return (
    <div
      data-testid="reader-menu-bar"
      className="flex items-center h-14 px-2 backdrop-blur-xl border-t"
      style={{ background: chromeBackground, color: chromeColor, borderColor: 'rgba(128,128,128,0.25)' }}
    >
      <Button
        variant="ghost"
        onClick={onBack}
        className="!h-auto !px-2 !py-1.5 !rounded-lg !gap-0.5 text-[15px] !text-current active:opacity-40 transition-opacity"
      >
        <svg width="11" height="18" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 2 L2 10 L10 18" />
        </svg>
        书库
      </Button>
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
        {onToggleBookmark && (
          <IconButton
            variant="ghost"
            onClick={onToggleBookmark}
            aria-label={bookmarked ? '移除书签' : '添加书签'}
            aria-pressed={bookmarked}
            className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
          >
            <BookmarkIcon filled={bookmarked} />
          </IconButton>
        )}
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
        {onToggleFullscreen && (
          <IconButton
            variant="ghost"
            onClick={onToggleFullscreen}
            aria-label={fullscreenActive ? '退出全屏' : '全屏'}
            className="!w-auto !h-auto !p-2.5 !rounded-lg !text-current active:opacity-40 transition-opacity"
          >
            {fullscreenActive ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3" />
                <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            )}
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
