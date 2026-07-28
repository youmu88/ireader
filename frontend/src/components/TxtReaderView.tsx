/**
 * TxtReaderView —— TXT 阅读渲染组件
 *
 * 从 ReaderPage 剥离的 TXT 渲染逻辑（Phase 2.6）：
 *   - 分页模式：CSS multi-column + 横向滚动，DOM 测量页数
 *   - 滚动模式：纵向滚动 + 进度追踪
 *   - TTS 分段高亮
 *   - 搜索结果高亮
 *   - 章节边界事件（翻到末尾/开头通知父组件）
 */
import React, { useCallback, useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';

// ── 类型 ─────────────────────────────────────────────────

export interface TxtReaderViewProps {
  content: string;
  chapterTitle: string;
  readingMode: 'scroll' | 'paginated';
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  /** TTS 分段文本（用于高亮） */
  ttsSegments: string[] | null;
  /** 当前 TTS 播放分段索引 */
  activeSegmentIndex: number;
  /** 搜索结果 */
  searchResults: Array<{ index: number; text: string; offset: number }>;
  /** 滚动/翻页进度回调（ratio 0~1） */
  onProgress?: (ratio: number) => void;
  /** 章节边界回调 */
  onBoundary?: (dir: 'next' | 'prev') => void;
  /** 页码信息回调 */
  onPageInfo?: (page: number, totalPages: number) => void;
  /** 初始滚动恢复比例（0~1，用于进度恢复） */
  initialScrollRatio?: number | null;
  /** 是否正在翻页动画中 */
  isPageTurning?: boolean;
}

export interface TxtReaderViewHandle {
  /** 获取滚动容器 DOM */
  getScrollContainer: () => HTMLDivElement | null;
  /** 获取内容容器 DOM */
  getContentContainer: () => HTMLDivElement | null;
  /** 执行翻页（供键盘/手势调用） */
  performPageTurn: (direction: 'prev' | 'next') => Promise<void>;
  /** 获取当前滚动比例 */
  getScrollRatio: () => number;
}

// ── 工具 ─────────────────────────────────────────────────

const FONT_MAP: Record<string, string> = {
  sans: 'system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Noto Serif SC", serif',
  mono: '"JetBrains Mono", "Fira Code", monospace',
};

/** 高亮渲染：将文本按 TTS 分段 + 搜索结果渲染为带标记的 React 节点 */
function renderHighlightedContent(
  content: string,
  ttsSegments: string[] | null,
  activeSegmentIndex: number,
  searchResults: Array<{ index: number; text: string; offset: number }>,
): React.ReactNode {
  // 无 TTS 分段时：纯文本 + 搜索高亮
  if (!ttsSegments || ttsSegments.length === 0) {
    if (searchResults.length === 0) return content;
    // 搜索高亮
    const parts: React.ReactNode[] = [];
    let lastIdx = 0;
    const sorted = [...searchResults].sort((a, b) => a.offset - b.offset);
    for (const r of sorted) {
      if (r.offset < lastIdx) continue;
      if (r.offset > lastIdx) parts.push(content.slice(lastIdx, r.offset));
      parts.push(
        <mark key={r.index} className="bg-yellow-200 dark:bg-yellow-700 rounded px-0.5">
          {content.slice(r.offset, r.offset + r.text.length)}
        </mark>,
      );
      lastIdx = r.offset + r.text.length;
    }
    if (lastIdx < content.length) parts.push(content.slice(lastIdx));
    return parts;
  }

  // TTS 分段高亮
  return ttsSegments.map((seg, idx) => (
    <span
      key={idx}
      data-tts-segment={idx === activeSegmentIndex ? 'active' : undefined}
      className={idx === activeSegmentIndex ? 'bg-blue-100 dark:bg-blue-900/40 rounded' : undefined}
    >
      {seg}
    </span>
  ));
}

// ── 组件 ─────────────────────────────────────────────────

const TxtReaderView = forwardRef<TxtReaderViewHandle, TxtReaderViewProps>(function TxtReaderView(
  props,
  ref,
) {
  const {
    content,
    chapterTitle,
    readingMode,
    fontSize,
    lineHeight,
    letterSpacing,
    fontFamily,
    ttsSegments,
    activeSegmentIndex,
    searchResults,
    onProgress,
    onBoundary,
    onPageInfo,
    initialScrollRatio,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const scrollSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPageTurningRef = useRef(false);

  // ── 暴露命令式 API ─────────────────────────────────────

  const performPageTurn = useCallback(async (direction: 'prev' | 'next') => {
    const container = scrollRef.current;
    if (!container || readingMode !== 'paginated') return;

    isPageTurningRef.current = true;
    try {
      const pageWidth = Math.max(1, container.clientWidth);
      const pages = Math.max(1, Math.ceil(container.scrollWidth / pageWidth));
      const current = Math.max(0, Math.min(pages - 1, Math.round(container.scrollLeft / pageWidth)));
      const target = direction === 'next' ? current + 1 : current - 1;

      if (target >= 0 && target < pages) {
        container.scrollTo({ left: target * pageWidth, behavior: 'smooth' });
        setPageIndex(target);
        const ratio = pages > 1 ? target / (pages - 1) : 0;
        onProgress?.(ratio);
        onPageInfo?.(target, pages);
        await new Promise<void>((resolve) => setTimeout(resolve, 280));
        return;
      }

      // 到达边界 → 通知父组件
      onBoundary?.(direction === 'next' ? 'next' : 'prev');
    } finally {
      isPageTurningRef.current = false;
    }
  }, [readingMode, onProgress, onBoundary, onPageInfo]);

  useImperativeHandle(ref, () => ({
    getScrollContainer: () => scrollRef.current,
    getContentContainer: () => contentRef.current,
    performPageTurn,
    getScrollRatio: () => {
      const el = scrollRef.current;
      if (!el || el.scrollHeight <= el.clientHeight) return 0;
      return el.scrollTop / (el.scrollHeight - el.clientHeight);
    },
  }), [performPageTurn]);

  // ── 分页模式：测量页数 ─────────────────────────────────

  useEffect(() => {
    if (readingMode !== 'paginated') {
      setTotalPages(1);
      setPageIndex(0);
      return;
    }
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const pw = el.clientWidth || 1;
      const total = Math.max(1, Math.ceil(el.scrollWidth / pw));
      setTotalPages(total);
      onPageInfo?.(0, total);
      // 恢复位置
      if (initialScrollRatio != null && initialScrollRatio > 0) {
        el.scrollLeft = initialScrollRatio * Math.max(0, el.scrollWidth - pw);
        const page = Math.round(initialScrollRatio * (total - 1));
        setPageIndex(page);
        onPageInfo?.(page, total);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [content, readingMode, fontSize, lineHeight, initialScrollRatio, onPageInfo]);

  // ── 滚动模式：进度追踪 ─────────────────────────────────

  const handleScroll = useCallback(() => {
    if (readingMode !== 'scroll') return;
    if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    scrollSaveTimer.current = setTimeout(() => {
      const el = scrollRef.current;
      if (!el || el.scrollHeight <= el.clientHeight) return;
      const ratio = el.scrollTop / (el.scrollHeight - el.clientHeight);
      onProgress?.(ratio);
    }, 1000);
  }, [readingMode, onProgress]);

  useEffect(() => {
    if (readingMode !== 'scroll') return;
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', handleScroll);
      if (scrollSaveTimer.current) clearTimeout(scrollSaveTimer.current);
    };
  }, [readingMode, content, handleScroll]);

  // ── 滚动位置恢复 ─────────────────────────────────────

  useEffect(() => {
    if (initialScrollRatio == null || initialScrollRatio <= 0) return;
    if (readingMode !== 'scroll') return;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (el && el.scrollHeight > el.clientHeight) {
        el.scrollTop = initialScrollRatio * (el.scrollHeight - el.clientHeight);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [content, initialScrollRatio, readingMode]);

  // ── TTS 高亮自动滚动 ─────────────────────────────────

  useEffect(() => {
    if (activeSegmentIndex < 0 || readingMode !== 'scroll') return;
    const el = scrollRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      const highlighted = el.querySelector('[data-tts-segment="active"]');
      if (highlighted) {
        highlighted.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
  }, [activeSegmentIndex, readingMode]);

  // ── 渲染 ─────────────────────────────────────────────

  const fontStack = FONT_MAP[fontFamily] || FONT_MAP.sans;

  return (
    <div
      ref={scrollRef}
      className={`flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto ${
        readingMode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'
      }`}
      data-l-spacing={letterSpacing}
      style={readingMode === 'paginated' ? { overscrollBehavior: 'none' } : undefined}
    >
      {chapterTitle && (
        <div className="mb-4">
          <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">{chapterTitle}</h2>
        </div>
      )}

      <div
        ref={contentRef}
        className={`text-gray-800 dark:text-gray-200 whitespace-pre-wrap ${
          readingMode === 'paginated' ? 'flex-1 overflow-hidden' : ''
        }`}
        style={{
          fontSize: `${fontSize}px`,
          lineHeight: lineHeight,
          letterSpacing: `${letterSpacing}em`,
          fontFamily: fontStack,
          ...(readingMode === 'paginated'
            ? {
                columnWidth: '100%',
                columnGap: '0px',
                columnFill: 'auto' as const,
                height: '100%',
                overflowX: 'auto',
                scrollSnapType: 'x proximity',
                scrollBehavior: 'smooth',
              }
            : {}),
        }}
      >
        {renderHighlightedContent(content, ttsSegments, activeSegmentIndex, searchResults)}
      </div>

      {/* 分页模式页码指示 */}
      {readingMode === 'paginated' && totalPages > 1 && (
        <div className="text-center text-xs py-1 shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {pageIndex + 1} / {totalPages}
        </div>
      )}
    </div>
  );
});

export default TxtReaderView;
