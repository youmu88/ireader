import { useEffect, useRef, useState } from 'react';
import ePub, { type Book, type Rendition } from 'epubjs';
import { getToken } from '../services/authService';
import { useTheme } from '../services/themeService';
import { useGesture } from '../hooks/useGesture';

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
  /** 暴露章节跳转控制——EPUB 模式点击目录时使用。接收章节的 spine index（从0开始） */
  chapterNavRef?: React.MutableRefObject<((chapterIndex: number) => Promise<void>) | null>;
  /** 点击/触摸阅读区时回调（用于父层弹出浮动操作面板）。epub.js 的 iframe 会吞掉事件，故在此转发 */
  onTap?: () => void;
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
  chapterNavRef,
  onTap,
}: EpubViewerProps) {
  const viewerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<Book | null>(null);
  const renditionRef = useRef<Rendition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 滑动翻页视觉反馈：翻页方向闪烁箭头
  const [swipeIndicator, setSwipeIndicator] = useState<'left' | 'right' | null>(null);
  const initialCfiRef = useRef<string | null>(initialCfi ?? null);
  const onLocRef = useRef(onLocationChange);
  onLocRef.current = onLocationChange;
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  // 统一手势入口（gesture hub）：接管 epub 阅读区的 swipe/longpress/tap。
  //   - swipe left/right → rendition 翻页（修根：恢复 epub 模式左右滑动翻页）
  //   - longpress → 触发父层浮动菜单 onTap（替代第19轮不可靠的 rendition.on('click') 长按）
  //   - tap → 不拦截，书内 TOC 跳转/文字选择原生穿透
  const gesture = useGesture({
    onSwipe: (dir) => {
      if (readingMode !== 'paginated') return; // 仅翻页模式支持滑动翻页
      // 视觉反馈：显示翻页方向箭头（600ms 后自动消失）
      setSwipeIndicator(dir);
      setTimeout(() => setSwipeIndicator(null), 600);
      if (dir === 'left') renditionRef.current?.next();
      else renditionRef.current?.prev();
    },
    onLongPress: () => {
      onTapRef.current?.();
    },
  });

  // ── 暗色模式感知 ──
  const { theme } = useTheme();
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // 用 ref 持有最新样式参数，供 rendition 钩子读取，避免重建
  const styleRef = useRef({ fontSize, fontFamily, lineHeight, letterSpacing, theme });
  styleRef.current = { fontSize, fontFamily, lineHeight, letterSpacing, theme };

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

    // ── 根因3 修复：epub.js 在容器尺寸为 0 时 display() 永不 resolve（iOS 100vh 塌陷）→ 永久"加载中" ──
    // 尺寸守卫：容器宽高均 > 0 才 renderTo；否则等下一帧/ResizeObserver 触发后再渲染。
    let rendition: Rendition | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let retryRaf = 0;
    // iframe 内手势监听的卸载器（effect 顶层，供 cleanup 调用）
    let gestureDetachRef: { current: null | (() => void) } = { current: null };

    const buildRendition = () => {
      if (cancelled || rendition) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        // 容器尚无有效尺寸（移动端首屏塌陷），下一帧重试
        retryRaf = requestAnimationFrame(buildRendition);
        return;
      }
      rendition = book.renderTo(el, {
        width: '100%',
        height: '100%',
        // 默认 manager 是 continuous（整书连续），next/prev 跨章连续翻页，不是翻节
        flow: readingMode === 'paginated' ? 'paginated' : 'scrolled-doc',
        spread: 'none',
        allowScriptedContent: false,
      });
      renditionRef.current = rendition;

      const applyTheme = () => {
        const { fontSize: fs, fontFamily: ff, lineHeight: lh, letterSpacing: ls, theme: t } = styleRef.current;
        const isDark = t === 'dark';
        rendition!.themes.register(THEME_NAME, {
          // 根因修复：epub.js 的 iframe 文档是 <html><body>，翻页平移时右侧露出的空白列
          // 属于 html 根区域（body 之外），body 有背景但 html 默认白色，故翻页瞬间露白条。
          // 给 html 同色背景，让露出的空白列与页面同色，白条消失。
          'html': {
            'background-color': isDark ? 'hsl(0, 0%, 8%)' : 'hsl(0, 0%, 98%)',
          },
          'body': {
            'font-family': FONT_STACK[ff],
            'font-size': `${fs}px !important`,
            'line-height': `${lh} !important`,
            'letter-spacing': `${ls}em !important`,
            'background-color': isDark ? 'hsl(0, 0%, 8%)' : 'hsl(0, 0%, 98%)',
            'color': isDark ? 'hsl(0, 0%, 93%)' : 'hsl(0, 0%, 10%)',
          },
          'p': { 'margin': '0 0 0.8em 0' },
          'img': { 'max-width': '100%', 'height': 'auto' },
        });
        rendition!.themes.select(THEME_NAME);
      };

      // 位置变化 → 上报 CFI
      rendition.on('relocated', (loc: any) => {
        const cfi = loc?.start?.cfi || loc?.cfi;
        if (cfi) onLocRef.current?.(cfi);
      });

      // 根因修复（替代全屏透明 <button> 遮罩 + 不可靠的 rendition.on('click') 长按）：
      // 浏览器安全机制规定 iframe 内的 touch 事件不会冒泡到父层 DOM，外层 ReaderPage 的
      // onTouchStart/End 因此到不了 epub 内容 → 滑动翻页/长按双双失效。
      // 修复：用统一手势入口 useGesture 的 attachToEpubContents，在 iframe 的 document 上
      // 直接注入 touch 监听（epub.js 官方通道 rendition.getContents() 暴露的 iframe 文档），
      // 完整捕获 swipe/longpress/tap，并统一阈值常量（修根，非 hack）。
      //   - swipe left/right → rendition.next()/prev()（真正翻页）
      //   - longpress → 触发父层浮动菜单（onTap 回调）
      //   - tap → 不拦截书内 TOC 点击/文字选择（原生穿透）
      // getContents() 在 display 后才有内容，且翻页会变，故在 display 成功后动态 attach。
      const GESTURE_INJECT_MARK = '__ireaderGestureAttached';
      let attachGestureRetries = 0;
      const MAX_ATTACH_RETRIES = 3;
      const ATTACH_RETRY_DELAY_MS = 200;

      const attachGesture = () => {
        // ⚠️ epub.js 类型定义 Rendition.getContents() 返回 Contents（单个对象），
        // 但运行时底层 Manager.getContents() 返回 Contents[]（数组）。
        // 用 as any 绕开类型不一致，实际取数组第一个元素的 document。
        const raw = rendition!.getContents?.() as any;
        const list: Array<{ document: Document }> = Array.isArray(raw) ? raw : [raw];

        if (!list.length || !list[0]?.document) {
          console.warn('[EpubViewer] attachGesture: getContents() 返回空，重试=', attachGestureRetries + 1, '/', MAX_ATTACH_RETRIES);
          if (attachGestureRetries < MAX_ATTACH_RETRIES) {
            attachGestureRetries++;
            setTimeout(attachGesture, ATTACH_RETRY_DELAY_MS);
          } else {
            console.error('[EpubViewer] attachGesture: getContents() 始终返回空，手势监听未挂载！');
          }
          return;
        }
        // 重置重试计数（成功获取到 contents）
        attachGestureRetries = 0;

        // 防重复：检查 document 是否已有注入标记
        const doc = list[0].document;
        if ((doc as any)[GESTURE_INJECT_MARK]) {
          console.log('[EpubViewer] attachGesture: 手势已注入，跳过重复绑定');
          return;
        }

        if (gestureDetachRef.current) { gestureDetachRef.current(); gestureDetachRef.current = null; }
        gestureDetachRef.current = gesture.attachToEpubContents(list);
        console.log('[EpubViewer] attachGesture: ✅ 手势监听已挂载到 iframe document, contents 数量=', list.length);
      };
      // 首次 display 完成后挂载；relocated 时 contents 可能重建，重新挂载
      rendition.on('rendered', attachGesture);
      rendition.on('relocated', attachGesture);

      const start = async () => {
        try {
          applyTheme();
          const cfi = initialCfiRef.current;
          if (cfi) {
            await rendition!.display(cfi);
          } else {
            await rendition!.display();
          }
          // 🔁 强制保底：display() resolve 后直接挂载手势。
          // 某些场景下 rendered/relocated 事件可能延迟或丢失
          //（如 epub.js 特定版本/大文件/移动端低性能设备），
          // 此时事件监听未挂载 → 滑动/长按失效。此处双保险确保手势一定挂上。
          attachGesture();
          if (!cancelled) {
            setLoading(false);
            if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          }
        } catch (e) {
          console.error('[EpubViewer] display 失败', e);
          if (!cancelled) {
            setError('EPUB 渲染失败，请重试或重新解析本书');
            setLoading(false);
          }
        }
      };
      start();
    };

    // 首屏立即尝试；若尺寸为 0，buildRendition 内部用 rAF 自动重试
    buildRendition();
    // 监听容器尺寸变化（iOS 地址栏收起/旋转），尺寸就绪后补渲染
    const ro = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => { if (!rendition) buildRendition(); })
      : null;
    ro?.observe(el);

    // 超时兜底：15s 内仍未渲染成功，给出明确失败提示而非永久"加载中"
    timeoutId = setTimeout(() => {
      if (!cancelled && loading && !renditionRef.current) {
        setError('EPUB 加载超时，请检查网络或重新解析本书');
        setLoading(false);
      }
    }, 15000);

    // 暴露翻页控制
    if (pageControlRef) {
      pageControlRef.current = {
        prev: () => { renditionRef.current?.prev(); },
        next: () => { renditionRef.current?.next(); },
      };
    }

    // 暴露章节跳转控制——EPUB 目录导航
    if (chapterNavRef) {
      chapterNavRef.current = async (chapterIndex: number) => {
        // epub.js 通过 spine index 获取 Section 对象，使用其 href 跳转
        const spine = book.spine;
        if (spine && spine.get) {
          const section = spine.get(chapterIndex);
          // section 的 href 形如 "chapter1.xhtml"，display(href) 会让 epub.js
          // 自动查找并渲染对应文件。注意：需要去掉可能的 url 路径部分。
          if (section?.href) {
            await renditionRef.current?.display(section.href);
          } else if (section?.url) {
            await renditionRef.current?.display(section.url);
          }
        }
      };
    }

    return () => {
      cancelled = true;
      if (retryRaf) cancelAnimationFrame(retryRaf);
      if (timeoutId) clearTimeout(timeoutId);
      if (gestureDetachRef.current) { gestureDetachRef.current(); gestureDetachRef.current = null; }
      ro?.disconnect();
      try { rendition?.destroy(); } catch { /* ignore */ }
      try { book.destroy(); } catch { /* ignore */ }
      bookRef.current = null;
      renditionRef.current = null;
      if (pageControlRef) pageControlRef.current = null;
      if (chapterNavRef) chapterNavRef.current = null;
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

  // ── 样式变化 + 暗色模式切换：themes 实时生效，不重建 ──
  useEffect(() => {
    const r = renditionRef.current;
    if (!r) return;
    const isDark = theme === 'dark';
    r.themes.register(THEME_NAME, {
      'html': {
        'background-color': isDark ? 'hsl(0, 0%, 8%)' : 'hsl(0, 0%, 98%)',
      },
      'body': {
        'font-family': FONT_STACK[fontFamily],
        'font-size': `${fontSize}px !important`,
        'line-height': `${lineHeight} !important`,
        'letter-spacing': `${letterSpacing}em !important`,
        'background-color': isDark ? 'hsl(0, 0%, 8%)' : 'hsl(0, 0%, 98%)',
        'color': isDark ? 'hsl(0, 0%, 93%)' : 'hsl(0, 0%, 10%)',
      },
      'p': { 'margin': '0 0 0.8em 0' },
      'img': { 'max-width': '100%', 'height': 'auto' },
    });
    r.themes.select(THEME_NAME);
  }, [fontSize, fontFamily, lineHeight, letterSpacing, theme]);

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
      {/* 滑动翻页视觉反馈：翻页方向箭头指示器 */}
      {swipeIndicator && (
        <div className={`absolute top-1/2 -translate-y-1/2 z-20 pointer-events-none transition-opacity duration-150 ${swipeIndicator === 'left' ? 'left-4' : 'right-4'}`}>
          <div className="w-10 h-10 rounded-full flex items-center justify-center animate-pulse" style={{ background: 'rgba(128,128,128,0.25)' }}>
            {swipeIndicator === 'left' ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            )}
          </div>
        </div>
      )}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="animate-pulse" style={{ color: 'var(--color-text-muted)' }}>加载中...</span>
        </div>
      )}
    </div>
  );
}
