import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Rendition } from 'epubjs';
import { getToken } from '../services/authService';

interface EpubViewerProps {
  /** 原始 epub 文件 URL（后端 GET /api/books/:id/file 返回） */
  fileUrl: string;
  readingMode: 'scroll' | 'paginated';
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
  lineHeight: number;
  letterSpacing: number;
  /** 初始 CFI（恢复进度用），空则从头开始 */
  initialCfi?: string | null;
  /** 页面/位置变化时回调当前 CFI，用于持久化进度 */
  onLocationChange?: (cfi: string) => void;
  /** 暴露翻页控制给父组件（左右箭头/手势） */
  pageControlRef?: React.MutableRefObject<{ prev: () => void; next: () => void } | null>;
}

const FONT_STACK: Record<'sans' | 'serif' | 'mono', string> = {
  sans: '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  serif: '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
  mono: '"JetBrains Mono", "Fira Code", "Courier New", monospace',
};

const THEME_NAME = 'ireader-theme';

/**
 * 基于 epub.js 的 EPUB 阅读器。
 * 关键特性（根治旧模型三大痛点）：
 *  - 进度用 CFI（relocated 事件），切换模式/刷新严格回同一字，无黑屏无跳变；
 *  - 翻页用 rendition.next()/prev()，基于整书连续 spine，是真正的「逐页」而非「翻节」；
 *  - 模式切换（scroll↔paginated）用同一 rendition.flow()，不重建 DOM，彻底消除黑屏；
 *  - 字体/行距/间距用 themes 实时生效，不重建。
 */
export default function EpubViewer({
  fileUrl,
  readingMode,
  fontSize,
  fontFamily,
  lineHeight,
  letterSpacing,
  initialCfi,
  onLocationChange,
  pageControlRef,
}: EpubViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const initialCfiRef = useRef<string | null>(initialCfi ?? null);
  const onLocRef = useRef(onLocationChange);
  onLocRef.current = onLocationChange;

  // 用 ref 持有最新样式参数，供 rendition 钩子读取，避免重建
  const styleRef = useRef({ fontSize, fontFamily, lineHeight, letterSpacing });
  styleRef.current = { fontSize, fontFamily, lineHeight, letterSpacing };

  // ── 初始化 Book + Rendition（仅一次）──
  useEffect(() => {
    let cancelled = false;
    const el = viewerRef.current;
    if (!el) return;

    setError(null);
    setLoading(true);

    const token = getToken();
    const book = ePub(fileUrl, {
      // 后端 /api/books/:id/file 有 requireAuth（Bearer Token 认证）
      // epub.js 内部用 XHR 加载，不会自动带 axios 拦截器的 token，
      // 故在此从根源注入请求头（标准用法，非绕过）
      requestHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    bookRef.current = book;

    const rendition = book.renderTo(el, {
      width: '100%',
      height: '100%',
      // 默认 manager 是 continuous（整书连续），next/prev 跨章连续翻页，不是翻节
      flow: readingMode === 'paginated' ? 'paginated' : 'scrolled-doc',
      spread: 'none',
      allowScriptedContent: false,
    });
    renditionRef.current = rendition;

    const applyTheme = () => {
      const { fontSize: fs, fontFamily: ff, lineHeight: lh, letterSpacing: ls } = styleRef.current;
      rendition.themes.register(THEME_NAME, {
        'body': {
          'font-family': FONT_STACK[ff],
          'font-size': `${fs}px !important`,
          'line-height': `${lh} !important`,
          'letter-spacing': `${ls}em !important`,
        },
        'p': { 'margin': '0 0 0.8em 0' },
        'img': { 'max-width': '100%', 'height': 'auto' },
      });
      rendition.themes.select(THEME_NAME);
    };

    // 位置变化 → 上报 CFI
    rendition.on('relocated', (loc: any) => {
      const cfi = loc?.start?.cfi || loc?.cfi;
      if (cfi) onLocRef.current?.(cfi);
    });

    const start = async () => {
      try {
        applyTheme();
        const cfi = initialCfiRef.current;
        if (cfi) {
          await rendition.display(cfi);
        } else {
          await rendition.display();
        }
        if (!cancelled) setLoading(false);
      } catch (e) {
        console.error('[EpubViewer] display 失败', e);
        if (!cancelled) {
          setError('EPUB 渲染失败，请重试或重新解析本书');
          setLoading(false);
        }
      }
    };
    start();

    // 暴露翻页控制
    if (pageControlRef) {
      pageControlRef.current = {
        prev: () => { rendition.prev(); },
        next: () => { rendition.next(); },
      };
    }

    return () => {
      cancelled = true;
      try { rendition.destroy(); } catch { /* ignore */ }
      try { book.destroy(); } catch { /* ignore */ }
      bookRef.current = null;
      renditionRef.current = null;
      if (pageControlRef) pageControlRef.current = null;
    };
    // 仅依赖 fileUrl：整个阅读过程用同一 rendition，模式/样式变化走下方独立 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileUrl]);

  // ── 模式切换：同一 rendition.flow()，不重建 DOM（根治黑屏）──
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    r.flow(readingMode === 'paginated' ? 'paginated' : 'scrolled-doc');
  }, [readingMode]);

  // ── 样式变化：themes 实时生效，不重建 ──
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    r.themes.register(THEME_NAME, {
      'body': {
        'font-family': FONT_STACK[fontFamily],
        'font-size': `${fontSize}px !important`,
        'line-height': `${lineHeight} !important`,
        'letter-spacing': `${letterSpacing}em !important`,
      },
      'p': { 'margin': '0 0 0.8em 0' },
      'img': { 'max-width': '100%', 'height': 'auto' },
    });
    r.themes.select(THEME_NAME);
  }, [fontSize, fontFamily, lineHeight, letterSpacing]);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span style={{ color: 'var(--color-text-muted)' }}>{error}</span>
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden" style={{ background: 'var(--color-bg)' }}>
      <div ref={viewerRef} className="w-full h-full epub-viewer-canvas" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="animate-pulse" style={{ color: 'var(--color-text-muted)' }}>加载中...</span>
        </div>
      )}
    </div>
  );
}
