/**
 * WxReaderView —— 微信读书风格沉浸式阅读组件（视觉骨架）
 *
 * 设计要点（对齐微信读书体验）：
 *  - 全屏沉浸正文滚动区，无常驻工具栏
 *  - 轻触正文中途唤出/隐去顶栏章节条 + 底部进度条
 *  - 顶部章节名 + 底部进度线（随滚动更新）
 *  - 章末衔接视觉占位（滚动到底由 onBoundary 通知父级加载下一章）
 *
 * props 与 TxtReaderView 对齐，便于 ReaderPage 后续替换联调。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface WxReaderViewProps {
  content: string;
  chapterTitle: string;
  readingMode: 'scroll' | 'paginated';
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  ttsSegments: string[] | null;
  activeSegmentIndex: number;
  searchResults: Array<{ index: number; text: string; offset: number }>;
  onProgress?: (ratio: number) => void;
  onBoundary?: (dir: 'next' | 'prev') => void;
  onPageInfo?: (page: number, totalPages: number) => void;
  initialScrollRatio?: number | null;
  isPageTurning?: boolean;
}

const FONT_MAP: Record<string, string> = {
  sans: 'system-ui, -apple-system, sans-serif',
  serif: 'Georgia, "Noto Serif SC", serif',
  mono: '"JetBrains Mono", "Fira Code", monospace',
};

/** 轻触唤出工具栏的判定：点击位置在可视区中间 60% 区域（避免误触上下工具条） */
function isCenterTap(clientY: number, height: number): boolean {
  return clientY > height * 0.15 && clientY < height * 0.85;
}

export function WxReaderView({
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
  isPageTurning,
}: WxReaderViewProps) {
  // 菜单（顶栏+底部条）显隐
  const [menuVisible, setMenuVisible] = useState(true);
  const [ratio, setRatio] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef(false);

  // 高亮渲染（纯文本 + 可选分段/搜索标记）
  function renderBody(): React.ReactNode {
    // 搜索命中的段落高亮（骨架阶段：命中段落右侧加标记点）
    const hasSearch = searchResults.length > 0;
    if (!ttsSegments || ttsSegments.length === 0) {
      return content.split('\n\n').map((para, i) => (
        <p key={i} className="wx-para mb-4" style={{ marginBottom: '1.2em' }}>
          {para}
          {hasSearch && searchResults.some(s => para.includes(s.text)) && (
            <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full align-middle" style={{ background: 'var(--color-primary)' }} />
          )}
        </p>
      ));
    }
    // 有 TTS 分段：逐段渲染（骨架阶段简单回退）
    return content.split('\n\n').map((para, i) => (
      <p key={i} className="wx-para mb-4" style={{ marginBottom: '1.2em' }}>
        <span data-tts-segment={i} data-active={i === activeSegmentIndex ? 'true' : 'false'}>{para}</span>
      </p>
    ));
  }

  // 滚动进度上报
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    const r = max > 0 ? el.scrollTop / max : 0;
    setRatio(r);
    onProgress?.(r);
    // 滚动到底 → 通知父级加载下一章
    if (max > 0 && el.scrollTop >= max - 4) {
      onBoundary?.('next');
    }
  }, [onProgress, onBoundary]);

  // 进度恢复（只应用一次）
  useEffect(() => {
    if (readingMode !== 'scroll') return;
    if (initialScrollRatio == null || initialScrollRatio <= 0) return;
    if (restoredRef.current) return;
    const el = scrollRef.current;
    if (!el || el.scrollHeight <= el.clientHeight) return;
    restoredRef.current = true;
    el.scrollTop = initialScrollRatio * (el.scrollHeight - el.clientHeight);
    handleScroll();
  }, [content, initialScrollRatio, readingMode, handleScroll]);

  // 轻触正文中间唤出/隐去工具栏
  const handleBodyClick = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    // 高度兜底：jsdom/异常时 clientHeight 可能为 0，退回窗口高度
    const h = (el?.clientHeight ?? 0) || window.innerHeight;
    if (isCenterTap(e.clientY, h)) {
      setMenuVisible(v => !v);
    }
  };

  // 滚动监听
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  return (
    <div
      className="wx-reader flex flex-col h-full relative overflow-hidden"
      data-testid="wx-body"
      onClick={handleBodyClick}
      style={{ background: 'var(--color-bg)', color: 'var(--color-text)' }}
    >
      {/* 顶部章节名条（菜单可见时显示） */}
      <div
        data-testid="wx-topbar"
        className={`absolute top-0 left-0 right-0 z-10 flex items-center justify-center px-4 pt-[calc(env(safe-area-inset-top,0px)+10px)] pb-3 transition-opacity duration-200 ${
          menuVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          background: 'linear-gradient(to bottom, var(--color-bg) 0%, transparent 100%)',
        }}
      >
        <span className="text-sm font-medium tracking-wide" style={{ color: 'var(--color-text)' }}>
          {chapterTitle}
        </span>
        <span className="ml-1 text-xs" style={{ color: 'var(--color-text-muted)' }}>▾</span>
      </div>

      {/* 沉浸式正文滚动区 */}
      <div
        ref={scrollRef}
        className={`wx-content flex-1 overflow-y-auto px-6 pt-16 pb-28 transition-opacity ${isPageTurning ? 'opacity-60' : ''}`}
        style={{
          fontFamily: FONT_MAP[fontFamily] || FONT_MAP.sans,
          fontSize: `${fontSize}px`,
          lineHeight,
          letterSpacing: `${letterSpacing}px`,
          color: 'var(--color-text)',
          WebkitFontSmoothing: 'antialiased',
        }}
      >
        {renderBody()}

        {/* 章末衔接占位：滚动到底触发 onBoundary('next')，此处给父级提示 */}
        <div data-testid="wx-chapter-end" className="mt-8 flex flex-col items-center gap-2 opacity-60">
          <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>—— 本章完 ——</div>
          <div className="text-xs" style={{ color: 'var(--color-primary)' }}>点击继续阅读下一章</div>
        </div>
      </div>

      {/* 底部进度条（菜单可见时） */}
      <div
        data-testid="wx-bottombar"
        className={`absolute bottom-0 left-0 right-0 z-10 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pt-3 transition-opacity duration-200 ${
          menuVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        style={{ background: 'linear-gradient(to top, var(--color-bg) 0%, transparent 100%)' }}
      >
        <div className="flex items-center gap-3">
          <div
            data-testid="wx-progress"
            className="flex-1 h-0.5 rounded-full overflow-hidden"
            style={{ background: 'var(--color-border)' }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-150"
              style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%`, background: 'var(--color-primary)' }}
            />
          </div>
          <span className="text-xs shrink-0 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
            {Math.round(ratio * 100)}%
          </span>
        </div>
      </div>

      {/* 初次渲染后上报页数（兼容 onPageInfo） */}
      <Observer onPageInfo={onPageInfo} />
    </div>
  );
}

/** 小助手：内容挂载后上报页码信息（滚动模式为 1 屏，供父级兜底） */
function Observer({ onPageInfo }: { onPageInfo?: (page: number, totalPages: number) => void }) {
  useEffect(() => {
    onPageInfo?.(0, 1);
  }, [onPageInfo]);
  return null;
}

export default WxReaderView;
