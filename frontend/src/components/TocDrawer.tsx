/**
 * TocDrawer — 章节目录抽屉组件（Phase 6.4）
 *
 * 职责：展示章节列表、高亮当前章节、支持 EPUB 重新解析
 */
import { useEffect, useRef } from 'react';

export interface TocChapter {
  id: string;
  title: string;
  order: number;
}

export interface TocDrawerProps {
  chapters: TocChapter[];
  currentChapterId?: string;
  onNavigate: (chapter: TocChapter) => void;
  /** EPUB 格式时显示刷新章节按钮 */
  bookFormat?: 'epub' | 'txt';
  onReparse?: () => void;
  isReparsing?: boolean;
}

export function TocDrawer({
  chapters,
  currentChapterId,
  onNavigate,
  bookFormat,
  onReparse,
  isReparsing = false,
}: TocDrawerProps) {
  const activeItemRef = useRef<HTMLDivElement>(null);

  // 打开时自动滚动到当前章节
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [currentChapterId]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="w-64 sm:w-72 overflow-y-auto absolute sm:relative z-30 inset-y-0 left-0 shadow-lg sm:shadow-none"
      style={{ background: 'var(--color-bg-card)', borderRight: '0.5px solid var(--color-border)' }}
    >
      <div className="p-3 font-semibold text-sm flex items-center justify-between" style={{ borderBottom: '0.5px solid var(--color-border)' }}>
        <span>章节目录</span>
        {bookFormat === 'epub' && onReparse && (
          <button
            onClick={onReparse}
            disabled={isReparsing}
            className="text-xs px-2 py-1 rounded-md font-normal transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed tap-active"
            style={{
              background: 'var(--color-bg-alt)',
              color: 'var(--color-text-secondary)',
            }}
            title="重新解析书籍章节（旧书目录刷新）"
          >
            {isReparsing ? (
              <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />刷新中</span>
            ) : (
              <span className="inline-flex items-center gap-1"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>刷新章节</span>
            )}
          </button>
        )}
      </div>
      {chapters.map((ch) => {
        const isActive = currentChapterId === ch.id;
        return (
          <div key={ch.id} ref={isActive ? activeItemRef : null} className="relative">
            {isActive && (
              <div className="absolute left-0 top-0 bottom-0 w-1 rounded-r-sm" style={{ background: 'var(--color-primary)' }} />
            )}
            <button
              onClick={() => onNavigate(ch)}
              className={`w-full text-left px-3 py-2.5 text-sm transition-all duration-150 truncate ${
                isActive
                  ? 'font-bold text-base'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700/50 text-gray-700 dark:text-gray-300'
              }`}
              style={isActive ? {
                background: 'var(--color-primary-subtle)',
                color: 'var(--color-primary)',
                paddingLeft: '1rem',
              } : {}}
            >
              <span className={isActive ? 'flex items-center gap-2' : ''}>
                {isActive && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" className="shrink-0">
                    <polygon points="5 3 19 12 5 21 5 3"/>
                  </svg>
                )}
                <span>{ch.title}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
