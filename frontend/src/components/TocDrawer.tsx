/**
 * TocDrawer — 章节目录抽屉组件（Phase 6.4 + 虚拟滚动优化）
 *
 * 职责：展示章节列表、高亮当前章节、支持 EPUB 重新解析
 * 性能：章节数 >200 时启用虚拟滚动（仅渲染可视区域 ±buffer）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/Button';

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

const ITEM_HEIGHT = 42; // 每个章节项的固定高度（px）
const VIRTUAL_THRESHOLD = 200; // 超过此数量启用虚拟滚动
const BUFFER_COUNT = 5; // 可视区域上下额外渲染的条目数

export function TocDrawer({
  chapters,
  currentChapterId,
  onNavigate,
  bookFormat,
  onReparse,
  isReparsing = false,
}: TocDrawerProps) {
  const activeItemRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const useVirtual = chapters.length > VIRTUAL_THRESHOLD;

  // ── 虚拟滚动状态 ──
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  // 测量容器高度
  useEffect(() => {
    if (!useVirtual || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current;
    const ro = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height));
    ro.observe(el);
    setContainerHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [useVirtual]);

  // 计算可视窗口范围
  const { startIndex, endIndex, offsetY } = useMemo(() => {
    if (!useVirtual) return { startIndex: 0, endIndex: chapters.length, offsetY: 0 };
    const start = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - BUFFER_COUNT);
    const visibleCount = Math.ceil(containerHeight / ITEM_HEIGHT) + BUFFER_COUNT * 2;
    const end = Math.min(chapters.length, start + visibleCount);
    return { startIndex: start, endIndex: end, offsetY: start * ITEM_HEIGHT };
  }, [useVirtual, scrollTop, containerHeight, chapters.length]);

  const visibleChapters = useVirtual ? chapters.slice(startIndex, endIndex) : chapters;
  const totalHeight = chapters.length * ITEM_HEIGHT;

  // 打开时自动滚动到当前章节
  useEffect(() => {
    if (useVirtual && scrollContainerRef.current && currentChapterId) {
      const idx = chapters.findIndex(c => c.id === currentChapterId);
      if (idx >= 0) {
        const targetTop = idx * ITEM_HEIGHT - containerHeight / 2 + ITEM_HEIGHT / 2;
        scrollContainerRef.current.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      }
    } else {
      activeItemRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [currentChapterId, useVirtual, chapters, containerHeight]);

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="w-64 sm:w-72 overflow-y-auto absolute sm:relative z-30 inset-y-0 left-0 shadow-lg sm:shadow-none"
      style={{ background: 'var(--color-bg-card)', borderRight: '0.5px solid var(--color-border)' }}
      ref={scrollContainerRef}
      onScroll={useVirtual ? handleScroll : undefined}
    >
      <div className="p-3 font-semibold text-sm flex items-center justify-between" style={{ borderBottom: '0.5px solid var(--color-border)' }}>
        <span>章节目录</span>
        {bookFormat === 'epub' && onReparse && (
          <Button
            onClick={onReparse}
            disabled={isReparsing}
            variant="secondary"
            size="sm"
            loading={isReparsing}
            title="重新解析书籍章节（旧书目录刷新）"
          >
            {isReparsing ? '刷新中' : '刷新章节'}
          </Button>
        )}
      </div>
      {useVirtual ? (
        /* ── 虚拟滚动模式：仅渲染可视区域 ── */
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visibleChapters.map((ch) => {
              const isActive = currentChapterId === ch.id;
              return (
                <div key={ch.id} style={{ height: ITEM_HEIGHT }} className="relative">
                  {isActive && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 rounded-r-sm" style={{ background: 'var(--color-primary)' }} />
                  )}
                  <button
                    onClick={() => onNavigate(ch)}
                    className={`w-full text-left px-3 text-sm transition-all duration-150 truncate ${
                      isActive
                        ? 'font-bold text-base'
                        : 'hover:bg-ios-bg-alt text-ios-text-secondary'
                    }`}
                    style={{ height: ITEM_HEIGHT, ...(isActive ? {
                      background: 'var(--color-primary-subtle)',
                      color: 'var(--color-primary)',
                      paddingLeft: '1rem',
                    } : {}) }}
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
        </div>
      ) : (
        /* ── 普通模式：全量渲染（章节数 ≤200） ── */
        chapters.map((ch) => {
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
                    : 'hover:bg-ios-bg-alt text-ios-text-secondary'
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
        })
      )}
    </div>
  );
}
