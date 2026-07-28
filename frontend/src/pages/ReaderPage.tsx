import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  cacheBookChapters,
  cacheSingleChapter,
  getCachedChapterContent,
  getCachedTTSAudio,
  cacheTTSAudio,
  getBookCacheDetailedStats,
  getCachedChapters,
  getOfflineBookInfo,
  clearBookChapterCache,
  clearBookTTSAudioCache,
  downloadBatchCachedAudio,
  downloadOfflineEpubPackage,
} from '../services/offlineCacheService';
import axios from 'axios';
import {
  getDefaultPlayer,
  splitText,
  type PlayerState,
} from '../services/ttsPlayer';
import type { BookCacheDetailedStats } from '../services/offlineCacheService';
import EpubViewer from '../components/EpubViewer';
import TxtReaderView, { type TxtReaderViewHandle } from '../components/TxtReaderView';
import { ReaderTopBar } from '../components/ReaderTopBar';
import { ReaderControlPanel } from '../components/ReaderControlPanel';
import { useReaderSettings } from '../reader/hooks/useReaderSettings';
import { useTtsIntegration } from '../reader/hooks/useTtsIntegration';
import { useReaderInteraction } from '../interaction/useReaderInteraction';
import { useAuth } from '../contexts/AuthContext';
import { getToken } from '../services/authService';

interface Book {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
  status: 'processing' | 'ready' | 'failed';
}

interface Chapter {
  id: string;
  title: string;
  order: number;
  href?: string;
  startOffset?: number;
  endOffset?: number;
}

const PROGRESS_SAVE_DELAY = 800; // ms debounce for saving progress

const TTS_PLAYBACK_KEY = 'ireader_tts_playback'; // localStorage key for TTS playback session (survives page refresh)

/** 格式化字节数为人类可读 */

function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { isOfflineMode, exitOfflineMode } = useAuth();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null);
  const [txtContent, setTxtContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [, setChapterLoading] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ── 阅读偏好（useReaderSettings hook 管理 + 自动持久化，Phase 5.5） ──
  const settings = useReaderSettings();
  const { fontSize, setFontSize, fontFamily, setFontFamily, lineHeight, setLineHeight, letterSpacing, readingMode, setReadingMode } = settings;

  // ── TTS 播放持久化（localStorage，页面刷新后恢复） ──
  interface PlaybackState {
    bookId: string;
    chapterId: string;
    segmentIndex: number;
    bookTitle?: string;
    chapterTitle?: string;
    timestamp: number;
  }
  const savePlaybackToLocalStorage = (state: PlaybackState) => {
    try {
      localStorage.setItem(TTS_PLAYBACK_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
  };
  const clearPlaybackFromLocalStorage = () => {
    try { localStorage.removeItem(TTS_PLAYBACK_KEY); } catch { /* ignore */ }
  };


  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsSpeed] = useState(() => {
    try {
      const raw = localStorage.getItem('ireader_tts_speed');
      return raw ? parseFloat(raw) : 1.0;
    } catch { return 1.0; }
  });
  const ttsVolume = 1.0;
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // ── TXT 翻页：由 TxtReaderView 组件内部管理 ──
  /** TXT 跨模式共享的字符位置比例 [0,1]，用于切换模式时从当前阅读位置精确恢复 */
  const charOffsetRatioRef = useRef<number>(0);
  // ── EPUB 模式：由 EpubViewer（epub.js）托管，进度用 CFI ──
  /** EpubViewer 翻页控制（prev/next），仅 EPUB 模式使用 */
  const epubPageControlRef = useRef<{ prev: () => void; next: () => void } | null>(null);
  /** EpubViewer 章节跳转控制（目录导航），仅 EPUB 模式使用 */
  const epubChapterNavRef = useRef<((chapterIndex: number) => Promise<void>) | null>(null);
  /** EPUB 当前阅读位置 CFI（用于进度持久化与恢复） */
  const epubCfiRef = useRef<string | null>(null);
  /** EPUB 章节内阅读比例 (0~1)，由 EpubViewer relocated 事件实时更新，供 TTS 起点推算 */
  const epubChapterRatioRef = useRef<number>(0);
  const [ttsVoice] = useState(() => {
    try { return localStorage.getItem('ireader_tts_voice') || 'zh-CN-XiaoxiaoNeural'; } catch { return 'zh-CN-XiaoxiaoNeural'; }
  });


  // ── 悬浮UI控制（全屏阅读：点击屏幕显示/隐藏所有控件） ──
  const [showUi, setShowUi] = useState(false);
  const showUiRef = useRef(false);
  useEffect(() => { showUiRef.current = showUi; }, [showUi]);
  /** TXT 或 EPUB iframe 中最后一次有效的文字选区。 */
  const [selectedText, setSelectedText] = useState('');
  const [copiedToast, setCopiedToast] = useState(false);
  const txtPageRef = useRef<HTMLDivElement>(null);
  const progressSaveTimer = useRef<any>(null);

  const ttsPlayerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const chaptersRef = useRef(chapters);
  const currentChapterRef = useRef(currentChapter);
  const loadingNextChapterRef = useRef(false);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const goToNextChapterRef = useRef<((_fromAutoScroll?: boolean) => Promise<void>) | null>(null);
  const goToPrevChapterRef = useRef<(() => Promise<void>) | null>(null);
  /** navigateToChapter ref — 用于翻页动画回调中访问（避免闭包过期） */
  const navigateToChapterRef = useRef<((chapter: Chapter, _append?: boolean) => Promise<void>) | null>(null);
  /** TTS 自动进入下一章 — ref 包装避免闭包过期 */
  const advanceToNextChapterTTSRef = useRef<((player: any) => Promise<void>) | null>(null);
  const txtScrollRef = useRef<HTMLDivElement>(null);
  const txtReaderViewRef = useRef<TxtReaderViewHandle>(null);
  const savedTtsProgressRef = useRef<{chapterId: string; segmentIndex: number; progress: number} | null>(null);

  /** 当前书籍 ID 的 ref（用于异步操作的书籍切换守卫） */
  const currentBookIdRef = useRef<string | undefined>(bookId);
  /** 进度条容器 ref（用于拖拽 seek） */
  const [pendingScrollRestorePct, setPendingScrollRestorePct] = useState<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  /** 是否正在拖拽进度条（防止 mouseup 未触发导致的卡住） */
  const isDraggingRef = useRef(false);



  // ── 阅读区交互装配 ──
  // 菜单仅由左下角按钮触发；原生选区存在时 InputSurface 自动暂停滑动。
  const toggleFloatMenu = useCallback(() => {
    if (ttsStateRef.current !== 'idle' || showSearchRef.current || showTocRef.current) return;
    if (book?.format === 'txt') {
      setSelectedText(window.getSelection()?.toString().trim() ?? '');
    }
    setShowUi(v => !v);
  }, [book?.format]);

  const closeMenu = useCallback(() => setShowUi(false), []);

  const interaction = useReaderInteraction({
    enabled: () => (
      readingModeRef.current === 'paginated'
      && !showUiRef.current
      && !showTocRef.current
      && !isPageTurningRef.current
      && ttsStateRef.current === 'idle'
      && !showSearchRef.current
      && book?.format === 'txt'
    ),
    navigate: (direction) => performPageTurnRef.current(direction === 'next' ? 'next' : 'prev'),
    tap: () => {
      if (showUiRef.current) closeMenu();
      else if (showTocRef.current) setShowToc(false);
    },
  });

/** 打开目录时自动滚动到当前章节位置 */
useEffect(() => {
  if (showToc && activeTocItemRef.current) {
    // 用 rAF 确保 DOM 已渲染后再滚动
    requestAnimationFrame(() => {
      activeTocItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
}, [showToc]);

  // ── 睡眠计时器 ──
  

  // ── 书籍内容搜索（全书·双线程架构） ──
  // 线程1：目录章节名匹配（同步，最高优先级）
  // 线程2：全文内容搜索（异步并发加载各章节后搜索）
  interface SearchResult {
    index: number;
    text: string;
    offset: number;
    chapterIdx: number;
    chapterTitle: string;
    /** true=目录匹配（章节名命中），false=正文匹配 */
    isChapterMatch: boolean;
  }
  const [showSearch, setShowSearch] = useState(false);
  const showSearchRef = useRef(false);
  useEffect(() => { showSearchRef.current = showSearch; }, [showSearch]);
  /** TOC 弹层开关的 ref 镜像，供键盘监听闭包读取最新值 */
  const showTocRef = useRef(false);
  useEffect(() => { showTocRef.current = showToc; }, [showToc]);

  /** TXT 统一分页出口：委托 TxtReaderView 组件处理翻页逻辑。 */
  const performPageTurnRef = useRef<(direction: 'prev' | 'next') => Promise<void>>(async (direction) => {
    await txtReaderViewRef.current?.performPageTurn(direction);
  });
  const [isPageTurning] = useState(false);
  /** ── ref 同步最新状态（供 useCallback([]) 内部闭包读取） ── */
  const readingModeRef = useRef(readingMode);
  const ttsStateRef = useRef(ttsState);
  const isPageTurningRef = useRef(isPageTurning);
  // 同步 ref 与 state，供 useCallback([]) 内部闭包读取最新值
  useEffect(() => { readingModeRef.current = readingMode; }, [readingMode]);
  useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);
  useEffect(() => { isPageTurningRef.current = isPageTurning; }, [isPageTurning]);

  /**
   * 桌面端键盘翻页快捷键：← 向左翻一页 / → 向右翻一页。
   * 严格复用「滑动翻页」通道（向左滑=next、向右滑=prev、逐页翻），绝不跳章节：
   *  - EPUB→epubPageControlRef.next()/prev()（epub.js 整页翻）
   *  - TXT→performPageTurnRef('next'/'prev')（整页翻）
   * 两种阅读模式（scroll / paginated）下 ←/→ 都按「翻一页」语义走，与触摸滑动手势完全一致。
   * 门控：非输入焦点 + 非 TTS 播放中/loading + 非搜索/TOC 弹层 + 非翻页动画中。
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // 输入框/可编辑元素聚焦时不拦截（避免打断搜索等输入）
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      // TTS 播放/加载中、搜索或目录打开、翻页动画中时不响应
      if (ttsStateRef.current !== 'idle') return;
      if (showSearchRef.current || showTocRef.current) return;
      if (isPageTurningRef.current) return;
      e.preventDefault();
      const next = e.key === 'ArrowRight';
      // ── 复用滑动翻页通道（逐页翻，不跳章节）──
      if (book?.format === 'epub') {
        if (next) epubPageControlRef.current?.next();
        else epubPageControlRef.current?.prev();
      } else if (next) {
        performPageTurnRef.current('next');
      } else {
        performPageTurnRef.current('prev');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [book?.format]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchActiveIdx, setSearchActiveIdx] = useState(-1);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** 缓存全书各章节的文本内容（懒加载），key=chapter.id, value={text, order} */
  const fullBookTextCache = useRef<Map<string, { text: string; order: number }>>(new Map());
  const [isSearchingFullBook, setIsSearchingFullBook] = useState(false);
  /** 搜索防抖定时器：输入停顿 400ms 后才执行全书搜索，避免每次敲字都触发 */
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前搜索请求 ID（用于取消陈旧请求的结果更新） */
  const searchReqIdRef = useRef(0);

  // 组件卸载时清理搜索防抖定时器
  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, []);

  /**
   * 🔍 搜索双线程架构
   *
   * 线程1（目录匹配）— 同步，最高优先级
   *   - 在 chapters 数组的 title 中搜索关键词匹配
   *   - 匹配到的章节直接作为"目录匹配"结果排在顶部
   *   - 立即返回，无需等待内容加载
   *
   * 线程2（全文搜索）— 异步并发
   *   - 分批并发加载所有未缓存章节的内容
   *   - 在各章节的正文中搜索关键词
   *   - 结果排在目录匹配之后，按章节顺序排列
   *
   * 设计原则：
   * - 目录匹配结果优先级最高，标题命中的章节名直接展示
   * - 全文搜索异步进行，结果逐步追加
   * - 使用 searchReqIdRef 防止陈旧请求覆盖最新结果
   */

  /** 线程1：目录章节名匹配（同步搜索，最高优先级） */
  const searchChapterTitles = useCallback((_query: string, lowerQuery: string): SearchResult[] => {
    const results: SearchResult[] = [];
    let matchIdx = 0;
    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      const lowerTitle = ch.title.toLowerCase();
      if (lowerTitle.includes(lowerQuery)) {
        results.push({
          index: matchIdx++,
          text: ch.title,
          offset: 0,
          chapterIdx: ci,
          chapterTitle: ch.title,
          isChapterMatch: true,
        });
      }
    }
    return results;
  }, [chapters]);

  /** 线程2：全文内容搜索（异步，并发加载各章节后搜索） */
  const searchFullText = useCallback(async (
    query: string,
    lowerQuery: string,
    reqId: number,
  ): Promise<SearchResult[]> => {
    const cache = fullBookTextCache.current;
    // 检查是否所有章节都已缓存
    const uncached = chapters.filter(ch => !cache.has(ch.id));
    if (uncached.length > 0) {
      setIsSearchingFullBook(true);
      try {
        // 分批加载，每批最多 5 个并发请求
        const BATCH_SIZE = 5;
        for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
          // 💡 中途如果用户清空了搜索或发起了新搜索，停止加载
          if (searchReqIdRef.current !== reqId) return [];

          const batch = uncached.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (ch) => {
            try {
              if (cache.has(ch.id)) return; // 已被其他批次加载
              // 优先用预加载缓存
              const preloaded = preloadedChaptersRef.current.get(ch.id);
              let content: string;
              if (preloaded) {
                content = preloaded.content;
                preloadedChaptersRef.current.delete(ch.id);
              } else {
                const res = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`, { timeout: 30000 });
                content = res.data.data?.content || '';
                if (book?.format === 'epub') {
                  content = stripHtml(content);
                }
              }
              cache.set(ch.id, { text: content, order: ch.order });
            } catch {
              cache.set(ch.id, { text: '', order: ch.order });
            }
          }));
        }
      } finally {
        // 💡 最后检查：如果过程中请求已过期，不更新 isSearchingFullBook
        if (searchReqIdRef.current === reqId) {
          setIsSearchingFullBook(false);
        }
      }
    }

    // 💡 再检查一次：防止加载完成后请求已过期
    if (searchReqIdRef.current !== reqId) return [];

    // 全文搜索正文
    const results: SearchResult[] = [];
    let matchIdx = 0;

    for (let ci = 0; ci < chapters.length && matchIdx < 20; ci++) {
      const ch = chapters[ci];
      const cached = cache.get(ch.id);
      if (!cached || !cached.text) continue;

      const lowerContent = cached.text.toLowerCase();
      let searchPos = 0;

      while (matchIdx < 20) {
        const pos = lowerContent.indexOf(lowerQuery, searchPos);
        if (pos === -1) break;

        const start = Math.max(0, pos - 20);
        const end = Math.min(cached.text.length, pos + query.length + 20);
        let context = cached.text.slice(start, end);
        if (start > 0) context = '…' + context;
        if (end < cached.text.length) context = context + '…';

        results.push({
          index: matchIdx,
          text: context,
          offset: pos,
          chapterIdx: ci,
          chapterTitle: ch.title,
          isChapterMatch: false,
        });
        searchPos = pos + query.length;
        matchIdx++;
      }
    }

    return results;
  }, [chapters, bookId, book, stripHtml]);

  /** 合并后的搜索入口：线程1（目录匹配）+ 线程2（全文搜索） */
  const performSearch = useCallback(async (query: string) => {
    // 生成新的请求 ID，用于取消陈旧请求
    const reqId = ++searchReqIdRef.current;

    if (!query) {
      setSearchResults([]);
      setSearchActiveIdx(-1);
      return;
    }

    const lowerQuery = query.toLowerCase();

    // ★ 线程1：目录章节名匹配（同步，立即执行）
    const titleResults = searchChapterTitles(query, lowerQuery);

    // 直接展示目录匹配结果（让用户能立刻看到）
    setSearchResults(titleResults);
    setSearchActiveIdx(titleResults.length > 0 ? 0 : -1);

    // ★ 线程2：全文内容搜索（异步执行）
    searchFullText(query, lowerQuery, reqId).then((textResults) => {
      // 请求已过期，丢弃结果
      if (searchReqIdRef.current !== reqId) return;

      // 合并结果：目录匹配（isChapterMatch=true）在前，正文匹配在后
      // 目录匹配不重复（章节去重）
      const titleChapterIdxSet = new Set(titleResults.map(r => r.chapterIdx));
      const filteredTextResults = textResults.filter(r => !titleChapterIdxSet.has(r.chapterIdx));

      // 调整 index 序号
      const merged = [...titleResults];
      for (const tr of filteredTextResults) {
        tr.index = merged.length;
        merged.push(tr);
      }

      setSearchResults(merged);
      // 如果之前没有目录匹配但有条目匹配，activeIdx 设为0
      if (merged.length > 0 && searchActiveIdx < 0) {
        setSearchActiveIdx(0);
      }
    });
  }, [searchChapterTitles, searchFullText]);

  /** 跳转到搜索结果位置（先切换章节，再滚动到匹配位置） */
  // handleSearchJump 定义见 navigateToChapter 之后（约 1090 行附近）
  const sleepTimerIntervalRef = useRef<any>(null);
  /** 当前章节 TOC 条目 DOM 引用 — 打开目录时自动滚动到可视区域 */
  const activeTocItemRef = useRef<HTMLDivElement | null>(null);
  
  /** Preloaded next-chapter contents for smooth scroll transitions */
  /** Track chapter IDs accumulated during auto-scroll for continuous reading */
  const accumulatedIdsRef = useRef<Set<string>>(new Set());
  /** Preloaded next-chapter contents for smooth scroll transitions */
  const preloadedChaptersRef = useRef<Map<string, {content: string}>>(new Map());
  /** Saved reading progress from API */
  const savedProgressRef = useRef<any>(null);
  /** Display chapter title — stays on original chapter during append mode */
  const [displayChapter, setDisplayChapter] = useState<Chapter | null>(null);
  // ── 客户端离线缓存 ──
  const [cacheStatus, setCacheStatus] = useState<BookCacheDetailedStats | null>(null);
  const [cachingInProgress, setCachingInProgress] = useState(false);
  const [cacheProgressText, setCacheProgressText] = useState('');

  /** 检查当前书籍的客户端缓存状态 */
  const checkCacheStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      const status = await getBookCacheDetailedStats(bookId);
      setCacheStatus(status);
    } catch {
      setCacheStatus(null);
    }
  }, [bookId]);

  /** 缓存当前章节到客户端 */
  const handleCacheCurrentChapter = useCallback(async () => {
    if (!bookId || !currentChapter || !book) return;
    setCachingInProgress(true);
    try {
      // 获取当前章节内容
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content || '';
      // 内联 HTML 剥离（使用完整的 stripHtml 处理 <style> 等块，避免 CSS 内容残留）
      const content = book.format === 'epub' ? stripHtml(rawContent) : rawContent;
      await cacheSingleChapter(bookId, book.title, {
        chapterId: currentChapter.id,
        title: currentChapter.title,
        order: currentChapter.order,
        content,
      });
      await checkCacheStatus();
    } catch (err) {
      console.warn('缓存章节失败:', err);
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, currentChapter, book, checkCacheStatus]);

  /** 缓存全书到客户端（文字 + 逐段预合成语音并缓存到本地 IndexedDB） */
  const handleCacheFullBook = useCallback(async () => {
    if (!bookId || !book || !chapters.length) return;

    // ⭐ 前置检查：先看当前缓存状态（复用已有 cacheStatus 或重新获取）
    const currentStats = cacheStatus ?? await getBookCacheDetailedStats(bookId);
    const textAlreadyCached = currentStats && chapters.length > 0 && currentStats.chapterCount >= chapters.length;
    // 文字+语音都已全缓存 → 直接跳过，不触发任何动画
    if (textAlreadyCached && currentStats!.audioChapterCount >= chapters.length) {
      console.log('全书文字+语音已全部缓存，跳过全书缓存');
      return;
    }

    setCachingInProgress(true);
    setCacheProgressText(textAlreadyCached ? '合成语音 0/' + chapters.length + ' 章' : '');
    try {
      // 阶段1：批量获取并缓存所有章节文字内容（已全部缓存时跳过）
      let chapterData: { chapterId: string; title: string; order: number; content: string }[] = [];
      if (textAlreadyCached) {
        chapterData = (await Promise.all(chapters.map(async ch => {
          const content = await getCachedChapterContent(bookId, ch.id);
          return content ? { chapterId: ch.id, title: ch.title, order: ch.order, content } : null;
        }))).filter((item): item is { chapterId: string; title: string; order: number; content: string } => item !== null);
      } else {
        const totalCh = chapters.length;
        for (let ci = 0; ci < totalCh; ci++) {
          const ch = chapters[ci];
          setCacheProgressText(`获取章节 ${ci + 1}/${totalCh}`);
          const res = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`);
          const rawContent = res.data.data?.content || '';
          // 内联的 HTML 标签剥离函数（避免在 useCallback 前引用 stripHtml）
          const simpleStrip = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10))).trim();
          const content = book.format === 'epub' ? simpleStrip(rawContent) : rawContent;
          chapterData.push({
            chapterId: ch.id,
            title: ch.title,
            order: ch.order,
            content,
          });
        }
        await cacheBookChapters(bookId, book.title, chapterData);
      }

      // EPUB 还需要缓存 XHTML/CSS/图片/字体等渲染资源，只有资源全部校验后才标记离线包 ready。
      if (book.format === 'epub') {
        setCacheProgressText('下载 EPUB 离线资源');
        await downloadOfflineEpubPackage(
          bookId,
          book.title,
          chapterData,
          (completed, total) => setCacheProgressText(`下载 EPUB 资源 ${completed}/${total}`),
        );
      }

      // 阶段2：全局并发池逐段合成语音并缓存到 IndexedDB
      // 将所有段落任务放入全局队列，跨章并发，充分利用并发能力
      const player = getDefaultPlayer();
      const effectiveVoice = (() => {
        try { return localStorage.getItem('ireader_tts_voice') || player.getVoice() || ttsVoice; } catch { return ttsVoice; }
      })();
      const effectiveSpeed = (() => {
        try {
          const raw = localStorage.getItem('ireader_tts_speed');
          return raw ? parseFloat(raw) : ttsSpeed;
        } catch { return ttsSpeed; }
      })();
      const noCachePref = (() => {
        try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return false; }
      })();

      // 跳过实时合成模式
      if (!noCachePref) {
        const MAX_CONCURRENT = 6; // 全局并发池上限
        let totalCached = 0;

        // ⭐ 阶段2a：先尝试批量拉取服务端已缓存的（后台预合成）音频
        // 这样已预合成的段落就走批量下载，不走逐段 POST /api/tts
        const chapterSegments = new Map<string, string[]>();
        for (const ch of chapters) {
          const chData = chapterData.find(d => d.chapterId === ch.id);
          if (chData?.content) chapterSegments.set(ch.id, splitText(chData.content));
        }
        const effectiveSource = localStorage.getItem('ireader_tts_source') || player.getSource();
        const batchDownloaded = await downloadBatchCachedAudio(
          bookId, effectiveVoice, effectiveSpeed, effectiveSource, chapterSegments,
                      (_chId, _segIdx) => {
            // 每下载一段，更新一下进度（粗略按章节算）
            if (!chapterMarkedDoneForBatch) chapterMarkedDoneForBatch = new Set();
          },
        );
        if (batchDownloaded > 0) {
          console.log(`批量拉取预合成语音完成：${batchDownloaded} 段`);
        }
        let chapterMarkedDoneForBatch: Set<string> | undefined;

        // 收集所有章节的所有段落任务
        interface CacheTask {
          chapter: typeof chapters[0];
          seg: string;
          segIdx: number;
        }
        const allTasks: CacheTask[] = [];
        // 记录每章含多少段、已完成几段（用于按章统计进度）
        const chapterTotalSegments = new Map<string, number>();
        const chapterCompletedSegments = new Map<string, number>();
        for (const ch of chapters) {
          const chData = chapterData.find(d => d.chapterId === ch.id);
          if (!chData || !chData.content) continue;
          const segments = splitText(chData.content);
          chapterTotalSegments.set(ch.id, segments.length);
          chapterCompletedSegments.set(ch.id, 0);
          segments.forEach((seg, segIdx) => {
            allTasks.push({ chapter: ch, seg, segIdx });
          });
        }
        const totalSegments = allTasks.length;
        const totalChapterCount = chapterTotalSegments.size;
        let completedChapterCount = 0; // 所有段都已完成缓存的章数
        if (totalSegments > 0) {
          setCacheProgressText(`合成语音 0/${totalChapterCount} 章`);

          // 全局并发池 — 所有任务共享并发槽
          let i = 0;
          const chapterMarkedDone = new Set<string>(); // 防止同一章多次计入 completedChapterCount
          const next = async () => {
            while (i < allTasks.length) {
              const idx = i++;
              const task = allTasks[idx];
              try {
                const identity = { voice: effectiveVoice, speed: effectiveSpeed, source: effectiveSource, text: task.seg };
                const existing = await getCachedTTSAudio(bookId, task.chapter.id, task.segIdx, identity);
                if (!existing) {
                  const res = await fetch('/api/tts', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
                    },
                    body: JSON.stringify({
                      input: task.seg,
                      voice: effectiveVoice,
                      speed: effectiveSpeed,
                      response_format: 'wav',
                      tts_source: effectiveSource,
                      no_cache: false,
                      book_id: bookId,
                    }),
                  });
                  if (res.ok) {
                    const arrayBuffer = await res.arrayBuffer();
                    await cacheTTSAudio(bookId, task.chapter.id, task.segIdx, arrayBuffer, undefined, identity);
                    totalCached++;
                  }
                }
                // 检查该章是否全部完成（每章只计一次）
                const chDone = (chapterCompletedSegments.get(task.chapter.id) || 0) + 1;
                chapterCompletedSegments.set(task.chapter.id, chDone);
                if (chDone >= (chapterTotalSegments.get(task.chapter.id) || 0) && !chapterMarkedDone.has(task.chapter.id)) {
                  chapterMarkedDone.add(task.chapter.id);
                  completedChapterCount++;
                }
                setCacheProgressText(`合成语音 ${completedChapterCount}/${totalChapterCount} 章`);
              } catch { /* 单段合成失败不影响全书 */ }
            }
          };
          const workers = Array.from({ length: Math.min(MAX_CONCURRENT, totalSegments) }, () => next());
          await Promise.all(workers);
          console.log(`全书缓存完成：共拉取 ${batchDownloaded} 段预合成 + 新合成 ${totalCached} 段语音（${completedChapterCount}章）`);
        }
      }

      await checkCacheStatus();
      setCacheProgressText(''); // 缓存完成，清除进度文字
    } catch (err) {
      console.warn('缓存全书失败:', err);
      setCacheProgressText('缓存失败');
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, book, chapters, checkCacheStatus, ttsSpeed, ttsVoice]);

  /** 清除文字缓存 */
  const handleClearTextCache = useCallback(async () => {
    if (!bookId) return;
    try {
      await clearBookChapterCache(bookId);
      await checkCacheStatus();
    } catch (err) {
      console.warn('清除文字缓存失败:', err);
    }
  }, [bookId, checkCacheStatus]);

  /** 清除语音缓存 */
  const handleClearAudioCache = useCallback(async () => {
    if (!bookId) return;
    try {
      await clearBookTTSAudioCache(bookId);
      await checkCacheStatus();
    } catch (err) {
      console.warn('清除语音缓存失败:', err);
    }
  }, [bookId, checkCacheStatus]);



  // Load book and chapters — 进入书籍完全不碰 TTS 播放器（播放控制只在用户点击按钮时处理）
  useEffect(() => {
    if (!bookId) return;

    // ⭐ 更新当前书籍 ref，供各异步操作校验
    currentBookIdRef.current = bookId;
    loadBook();

    // Cleanup on unmount or book switch
    return () => {
      // 仅清除本地定时器，不碰 TTS 播放器（保持后台播放不中断）
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ── 持久化阅读偏好 ──


  // ⭐ autoPlayTts=1：从书架底部栏续播时自动启动 TTS
  const [searchParams] = useSearchParams();
  const autoPlayTtsTriggered = useRef(false);
  useEffect(() => {
    if (autoPlayTtsTriggered.current) return;
    if (!currentChapter || !book) return;
    if (searchParams.get('autoPlayTts') !== '1') return;
    autoPlayTtsTriggered.current = true;
    // 等待内容渲染完成后启动 TTS
    const timer = setTimeout(() => {
      handleStartTTS();
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book, searchParams]);

  // ⭐ TTS 预热：loadBook 完成后提前初始化播放器（跳过 init 网络请求 + 预载 IDB 缓存）
  const warmupTriggered = useRef(false);
  // ── 重新解析书籍章节（刷新目录） ──
  const [isReparsing, setIsReparsing] = useState(false);
  const handleReparse = useCallback(async () => {
    if (!bookId || !book || book.format !== 'epub' || isReparsing) return;
    if (!window.confirm('重新解析将刷新全部章节信息，确定继续？')) return;
    setIsReparsing(true);
    try {
      await axios.post(`/api/books/${bookId}/reparse`);
      // 刷新后重新获取章节列表（不触发全屏 loading）
      const [bookRes, chaptersRes] = await Promise.all([
        axios.get(`/api/books/${bookId}`),
        axios.get(`/api/books/${bookId}/chapters`),
      ]);
      const newBookData = bookRes.data?.data;
      const newChapters = chaptersRes.data?.data || [];
      if (newBookData) setBook(newBookData);
      if (newChapters.length > 0) {
        setChapters(newChapters);
        // 尝试保持当前章节（如果 ID 变了则跳到第一章）
        const stillExists = newChapters.some((c: Chapter) => c.id === currentChapter?.id);
        if (!stillExists && currentChapter) {
          await loadChapterContent(newChapters[0], undefined, newBookData?.format === 'epub');
        }
      }
    } catch (err: any) {
      alert(err.response?.data?.error || '章节刷新失败，请稍后重试');
    } finally {
      setIsReparsing(false);
    }
  }, [bookId, book, isReparsing, currentChapter]);
  useEffect(() => {
    if (warmupTriggered.current) return;
    if (loading || !currentChapter || !bookId || !book) return;
    warmupTriggered.current = true;

    // 延迟到 loadBook 完全就绪后执行，不影响页面渲染
    const timer = setTimeout(async () => {
      try {
        // 读取上次播放记录，判断是否同书
        let lastPlayback: { bookId: string; chapterId: string } | null = null;
        try {
          const raw = localStorage.getItem('ireader_last_playback');
          if (raw) lastPlayback = JSON.parse(raw);
        } catch { /* ignore */ }

        // 仅当上次也是同一本书时预热（非同书记忆的用户场景无预热必要）
        if (!lastPlayback || lastPlayback.bookId !== bookId) return;

        const player = getDefaultPlayer();
        if (player['audioElement']) return; // 已初始化

        // 读取语音设置
        const savedVoice = (() => {
          try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
        })();
        const savedSpeed = (() => {
          try {
            const raw = localStorage.getItem('ireader_tts_speed');
            return raw ? parseFloat(raw) : null;
          } catch { return null; }
        })();
        const noCachePref = (() => {
          try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; }
        })();

        // 提前初始化播放器（创建 audio 元素 + 缓存 TTS 设置）
        await player.init({
          source: localStorage.getItem('ireader_tts_source') || undefined,
          speed: savedSpeed || ttsSpeed,
          voice: savedVoice || ttsVoice,
          noCache: noCachePref,
          bookId,
          bookTitle: book?.title || '',
          bookCoverUrl: `/api/books/${bookId}/cover`,
        });

        // 预热当前章节的 TTS 音频缓存（从 IDB 加载到播放器）
        const cachedContent = await getCachedChapterContent(bookId, currentChapter.id);
        if (cachedContent) {
          const text = book.format === 'epub' ? stripHtml(cachedContent) : cachedContent;
          const splitChunks = text.match(/[^。！？\n]+[。！？\n]?/g);
          if (splitChunks && splitChunks.length > 0) {
            player.preloadCachedAudio(bookId, currentChapter.id, splitChunks);
          }
        }
      } catch {
        // 预热失败不阻塞应用（静默）
      }
    }, 1000); // 延迟 1 秒确保 loadBook 完全稳定
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, currentChapter, bookId, book]);

  const loadBook = async () => {
    // ⭐ 记录触发时的书籍 ID，异步完成后校验是否仍为同一本书
    const triggerBookId = bookId;
    try {
      setLoading(true);

      // ── 离线判断：navigator.onLine 或首次 API 请求失败时降级 ──
      const isOffline = isOfflineMode || (typeof navigator !== 'undefined' && navigator.onLine === false);

      let bookData: any = null;
      let chaptersData: any[] = [];

      if (!isOffline) {
        try {
          const [bookRes, chaptersRes] = await Promise.all([
            axios.get(`/api/books/${bookId}`),
            axios.get(`/api/books/${bookId}/chapters`),
          ]);
          bookData = bookRes.data.data;
          chaptersData = chaptersRes.data.data || [];
        } catch {
          // 网络请求失败 → 尝试离线降级
        }
      }

      // ⭐ 离线或 API 失败时：从 IndexedDB 缓存读取
      if (!bookData || !chaptersData.length) {
        const [offlineBook, offlineChapters] = await Promise.all([
          getOfflineBookInfo(bookId!),
          getCachedChapters(bookId!),
        ]);
        if (offlineBook) {
          bookData = offlineBook;
        }
        if (offlineChapters.length > 0) {
          chaptersData = offlineChapters.map(c => ({
            id: c.chapterId,
            title: c.title,
            order: c.order,
          }));
        }
        // 离线且无缓存时，仍显示错误（由后续 null 判断处理）
      }

      // ⭐ 书籍切换守卫：异步 fetch 期间用户可能已切换到另一本书
      if (currentBookIdRef.current !== triggerBookId) return;

      if (!bookData || !chaptersData.length) {
        setError(!isOffline ? '加载图书失败' : '当前为离线状态，且该书未缓存到本地');
        setLoading(false);
        return;
      }

      setBook(bookData);
      setChapters(chaptersData);

      // ── 恢复阅读进度：尝试跳转到上次阅读的章节 ──
      let targetChapter = chaptersData[0];
      const isEpub = bookData.format === 'epub';
      let savedProgress: any = null;
      try {
        if (!isOffline) {
          const progRes = await axios.get(`/api/books/${bookId}/progress`);
          savedProgress = progRes.data.data;
        }
        if (savedProgress?.chapterId) {
          const saved = chaptersData.find((c: Chapter) => c.id === savedProgress.chapterId);
          if (saved) {
            targetChapter = saved;
            savedProgressRef.current = savedProgress; // 用于进度恢复
          } else if (savedProgress.percentage != null) {
            // ⭐ 兜底：chapterId 不匹配时（如书被重新解析后 ID 变了），
            //    按 percentage 估算章节顺序号，用 order 字段匹配
            const estimatedOrder = Math.round(savedProgress.percentage * chaptersData.length);
            const fallback = chaptersData.find((c: Chapter) => c.order === estimatedOrder);
            if (fallback) {
              targetChapter = fallback;
              savedProgressRef.current = savedProgress;
            }
          }
        }
        // ⭐ 保存 TTS 进度到 ref（textOffset = segmentIndex），供 handleStartTTS 恢复播放位置
        if (savedProgress?.chapterId && savedProgress?.textOffset != null && savedProgress.textOffset >= 0) {
          // 若 chapterId 未精确匹配（用了兜底），则修正为实际匹配的章节 ID
          const exactMatch = chaptersData.some((c: Chapter) => c.id === savedProgress.chapterId);
          savedTtsProgressRef.current = {
            chapterId: exactMatch ? savedProgress.chapterId : (targetChapter?.id || savedProgress.chapterId),
            segmentIndex: savedProgress.textOffset,
            progress: savedProgress.percentage || 0,
          };
        }
      } catch { /* 无保存的进度 */ }

      // ⭐ 再次校验书籍是否仍为同一本
      if (currentBookIdRef.current !== triggerBookId) return;

      if (targetChapter) {
        if (isEpub) {
          // EPUB 模式：用 CFI 恢复进度，交由 EpubViewer 内部 display(cfi)
          if (savedProgress?.cfi) epubCfiRef.current = savedProgress.cfi;
        } else {
          // TXT：统一用字符位置比例恢复（scroll / paginated 共用）
          if (savedProgress?.percentage != null) {
            charOffsetRatioRef.current = Math.min(1, Math.max(0, savedProgress.percentage));
          } else if (savedProgress?.pageIndex != null) {
            charOffsetRatioRef.current = Math.min(1, Math.max(0, savedProgress.pageIndex / 10000));
          }
          // scroll 模式兼容：沿用原有 pendingScrollRestorePct 恢复路径
          if (savedProgress?.pageIndex != null && bookData.format !== 'epub') {
            const restorePct = savedProgress.pageIndex / 10000;
            if (restorePct > 0) setPendingScrollRestorePct(restorePct);
          }
        }
        await loadChapterContent(targetChapter, undefined, isEpub);
        // 首次加载后立即预加载后续章节
        preloadNextChapters(targetChapter.id);
      }

      // 检查客户端缓存状态
      checkCacheStatus();
    } catch (err: any) {
      setError(err.response?.data?.error || '加载图书失败');
    } finally {
      setLoading(false);
    }
  };

/**
 * stripHtml — 将 HTML 转为纯文本（保留段落结构）
 * （CSS multi-column 分页已替代 splitEpubHtmlIntoBlocks/estimateBlockLines/paginateEpubBlocks）
 */
/** Strip HTML tags for plain text display */
function stripHtml(html: string): string {
  let s = html;
  // Convert block-level closing tags to newlines (preserves paragraph structure)
  s = s.replace(/<\/(?:p|div|h[1-6]|blockquote|li|tr|th|td)>/gi, '\n');
  // Convert <br> tags to newlines
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Also add newlines before block-level opening tags for extra spacing
  s = s.replace(/<(?:p|div|h[1-6]|blockquote|li|tr|th|td)[^>]*>/gi, '\n');
  // Remove head/script/style blocks
  s = s.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove SVG / figure / noscript / iframe / canvas blocks (rare in EPUB but possible)
  s = s.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '');
  s = s.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
  s = s.replace(/<canvas[^>]*>[\s\S]*?<\/canvas>/gi, '');
  s = s.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
  // Remove all remaining HTML tags (support cross-line tags via [\s\S])
  s = s.replace(/<[^>]*>/g, '')
       // Also catch tags that span multiple lines (attribute values with line breaks)
       .replace(/<[\s\S]*?>/g, '');
  // Decode HTML entities (comprehensive, matching ttsPlayer.ts)
  s = s.replace(/&nbsp;/g, '\u00A0')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&apos;/g, "'")
       .replace(/&mdash;/g, '\u2014')
       .replace(/&ndash;/g, '\u2013')
       .replace(/&hellip;/g, '\u2026')
       .replace(/&lsquo;/g, '\u2018')
       .replace(/&rsquo;/g, '\u2019')
       .replace(/&ldquo;/g, '\u201C')
       .replace(/&rdquo;/g, '\u201D')
       .replace(/&laquo;/g, '\u00AB')
       .replace(/&raquo;/g, '\u00BB')
       .replace(/&copy;/g, '\u00A9')
       .replace(/&reg;/g, '\u00AE')
       .replace(/&trade;/g, '\u2122')
       .replace(/&bull;/g, '\u2022')
       .replace(/&middot;/g, '\u00B7')
       .replace(/&euro;/g, '\u20AC')
       .replace(/&pound;/g, '\u00A3')
       .replace(/&yen;/g, '\u00A5')
       .replace(/&#(\d+);/g, (_m: any, n: string) => String.fromCharCode(parseInt(n, 10)))
       .replace(/&#x([0-9a-fA-F]+);/g, (_m: any, n: string) => String.fromCharCode(parseInt(n, 16)));
  // Normalize: collapse multiple spaces but preserve single newlines
  s = s.replace(/[ \t]+/g, ' ');
  // Remove leading whitespace from each line (artifact of HTML indentation)
  s = s.replace(/^[ \t]+/gm, '');
  // Remove whitespace-only lines (reduces excessive blank lines from nested tags)
  s = s.replace(/^[ \t]+$/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

  // Load chapter content


  // Load chapter content
  const loadChapterContent = async (chapter: Chapter, _offset?: number, _isEpub?: boolean, _append?: boolean, _forcePlainText?: boolean) => {
    try {
      const isEpub = _isEpub ?? (book?.format === 'epub');

      // ⭐ 先检查预加载缓存：有缓存时不触发空白闪烁，不显示 loading
      const preloaded = preloadedChaptersRef.current.get(chapter.id);
      const hasPreloadedContent = !!preloaded;

      if (!hasPreloadedContent) {
        // 无预缓存 → 清空内容并显示加载状态（append 模式仅清空，不显示 loading）
        setTxtContent('');
        if (!_append) setChapterLoading(true);
      } else {
        // 有预缓存 → 保留当前内容（不 setTxtContent('')），跳过 loading 闪烁
      }
      setCurrentChapter(chapter);
      // append 模式下不更新显示标题（保持显示原始章节名，避免标题跳跃）
      if (!_append) {
        setDisplayChapter(chapter);
      }

      // ⭐ 尽早启动后续章节预加载（与内容获取并行），而非等渲染完
      preloadNextChapters(chapter.id);

      // 获取章节内容（优先使用预加载内容，其次离线缓存，最后 API）
      let content: string;
      if (preloaded) {
        content = preloaded.content;
        preloadedChaptersRef.current.delete(chapter.id);
      } else {
        // 尝试从客户端离线缓存读取
        const cachedContent = await getCachedChapterContent(bookId!, chapter.id);
        if (cachedContent) {
          content = isEpub ? stripHtml(cachedContent) : cachedContent;
          if (!_append) setChapterLoading(false);
        } else {
          if (!_append) setChapterLoading(true);
          const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
          const rawContent = res.data.data?.content || '';
          if (isEpub) {
            // EPUB 渲染由 EpubViewer 组件（epub.js）独立接管，父组件只保留纯文本供 TTS 使用
            content = stripHtml(rawContent);
          } else {
            content = rawContent;
          }
          if (!_append) setChapterLoading(false);
        }
      }

      // 内容为空时的兜底显示（避免静默失败）
      const displayContent = content || `「${chapter.title}」内容暂未加载，请尝试使用目录切换或联系管理员。`;

      // 追加模式（滚动自动加载）：内容接在已有内容后面，实现平滑连续阅读
      if (_append && !accumulatedIdsRef.current.has(chapter.id)) {
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(prev => {
          const separator = '\n\n' + chapter.title + '\n' + '─'.repeat(30) + '\n\n';
          return prev + separator + displayContent;
        });
      } else {
        // 手动跳转：替换内容，重置累积记录
        accumulatedIdsRef.current.clear();
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(displayContent);
      }
    } catch (err: any) {
      setError('加载章节内容失败');
      setChapterLoading(false);
    }
  };

  const preloadNextChapters = useCallback(async (currentChapterId: string) => {
    if (!chapters.length) return;
    const idx = chapters.findIndex(c => c.id === currentChapterId);
    if (idx < 0) return;
    // 并行预加载后续3章（从2→3增加缓冲），互不等待，大幅提高预加载速度
    const isEpub = book?.format === 'epub';
    const preloadTasks = [];
    for (let i = 1; i <= 3; i++) {
      const next = chapters[idx + i];
      if (next && !preloadedChaptersRef.current.has(next.id)) {
        preloadTasks.push(
          axios.get(`/api/books/${bookId}/chapters/${next.id}/content`)
            .then(res => {
              const rawContent = res.data.data?.content || '';
              const pageThis = preloadedChaptersRef;
              if (isEpub) {
                // EPUB: 仅存储纯文本（TTS 用），渲染由 EpubViewer 组件（epub.js）负责
                pageThis.current.set(next.id, { content: stripHtml(rawContent) });
              } else {
                pageThis.current.set(next.id, { content: rawContent });
              }
            })
            .catch(() => { /* 预加载失败不影响核心功能 */ })
        );
      }
    }
    await Promise.all(preloadTasks);
  }, [chapters, bookId, book, stripHtml]);

  /**
   * 预取下一章节的 TTS 音频分段（后台跨章无缝过渡的关键）
   * 在当前章节播放到 75% 时触发，提前合成下一章节音频
   * 跨章节时 advanceToNextChapterTTS 通过 player.loadFromPrefetched() 直接使用
   */
  const triggerTtsPrefetch = useCallback(async (nextChapterIndex: number) => {
    const nextCh = chapters[nextChapterIndex];
    if (!nextCh || !bookId) return;
    let content = '';
    // 优先从预加载缓存取（preloadNextChapters 已缓存文本内容）
    const preloaded = preloadedChaptersRef.current.get(nextCh.id);
    if (preloaded) {
      content = preloaded.content;
    } else {
      const cached = await getCachedChapterContent(bookId, nextCh.id);
      if (cached) {
        content = book?.format === 'epub' ? stripHtml(cached) : cached;
      } else {
        try {
          const res = await axios.get(`/api/books/${bookId}/chapters/${nextCh.id}/content`);
          const raw = res.data.data?.content || '';
          content = book?.format === 'epub' ? stripHtml(raw) : raw;
        } catch { return; }
      }
    }
    if (!content) return;
    const segments = splitText(content);
    if (segments.length === 0) return;
    // 推入播放器的预取缓冲区（不阻塞当前播放）
    const player = getDefaultPlayer();
    player.prefetchChapterSegments(segments, nextCh.id).catch(() => {});
  }, [chapters, bookId, book]);

  // Debounced progress save
  const debounceSaveProgress = useCallback((data: Record<string, any>) => {
    if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current);
    progressSaveTimer.current = setTimeout(async () => {
      try {
        await axios.put(`/api/books/${bookId}/progress`, data);
      } catch { /* silent */ }
    }, PROGRESS_SAVE_DELAY);
  }, [bookId]);

  // TXT / EPUB 通用章节导航
  const navigateToChapter = async (chapter: Chapter, _append?: boolean) => {
    setShowToc(false);

    if (book?.format === 'epub') {
      // EPUB 模式：使用 EpubViewer 的 chapterNavRef 跳转到对应 spine 索引
      const spineIndex = chapters.indexOf(chapter);
      if (spineIndex >= 0 && epubChapterNavRef.current) {
        await epubChapterNavRef.current(spineIndex);
      }
      // ⭐ EPUB 也需要加载纯文本内容（供 TTS 朗读使用），同时更新 currentChapter
      await loadChapterContent(chapter, undefined, true);
    } else {
      // TXT 按章导航：自动滚动加载时使用追加模式（`_append=true`），内容接在已有内容后面平滑续读；
      // 目录/按钮手动切换时 `_append` 为 undefined/false → 替换模式（清空重新加载）。
      await loadChapterContent(chapter, undefined, undefined, _append);
    }

    debounceSaveProgress({ chapterId: chapter.id, percentage: chapter.order / chapters.length });
  };

  // 保持 ref 指向最新函数，供翻页动画等异步回调使用
  navigateToChapterRef.current = navigateToChapter;

  /** 跳转到搜索结果位置（先切换章节，再滚动到匹配位置） */
  const handleSearchJump = useCallback(async (result: { offset: number; chapterIdx: number; chapterTitle: string }) => {
    setShowSearch(false);
    setSearchResults([]);

    const targetChapter = chapters[result.chapterIdx];
    if (!targetChapter) return;

    // 如果目标不是当前章节，先切换章节
    if (currentChapter?.id !== targetChapter.id) {
      // ⭐ 强制纯文本模式：让 loadChapterContent 不设置 epubDisplayHtml，
      // 只设置 txtContent（纯文本），确保 DOM 中的文本与搜索 offset 完全一致
      await loadChapterContent(targetChapter, undefined, undefined, false, true);
    } else {
      // ⭐ 当前章节时也重新加载为纯文本模式（可能有 epubDisplayHtml）
      await loadChapterContent(targetChapter, undefined, undefined, false, true);
    }

    // 等渲染完成后滚动到匹配位置
    const query = searchQuery;
    // 在切换章节/跳转后才清空搜索查询（确保 RAF 回调中能读到正确的 query）
    setTimeout(() => setSearchQuery(''), 200);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const container = txtScrollRef.current;
        if (!container) return;

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
        let charCount = 0;
        let targetNode: Text | null = null;
        let targetOffset = 0;
        while (walker.nextNode()) {
          const node = walker.currentNode as Text;
          const nodeLen = node.textContent?.length || 0;
          if (charCount + nodeLen > result.offset) {
            targetNode = node;
            targetOffset = result.offset - charCount;
            break;
          }
          charCount += nodeLen;
        }
        if (targetNode) {
          const range = document.createRange();
          range.setStart(targetNode, targetOffset);
          range.setEnd(targetNode, targetOffset + query.length);
          const rect = range.getBoundingClientRect();
          if (rect) {
            container.scrollBy({ top: rect.top - container.clientHeight / 3, behavior: 'smooth' });
          }
          const highlightSpan = document.createElement('mark');
          highlightSpan.className = 'bg-yellow-300 dark:bg-yellow-600 rounded px-0.5 transition-all duration-1000';
          try {
            range.surroundContents(highlightSpan);
            setTimeout(() => {
              highlightSpan.classList.remove('bg-yellow-300', 'dark:bg-yellow-600');
              highlightSpan.classList.add('bg-yellow-100', 'dark:bg-yellow-800');
            }, 2000);
          } catch { /* 跨节点环绕可能失败，静默 */ }
        }
        setSearchActiveIdx(-1);
      });
    });
  }, [chapters, currentChapter, loadChapterContent, searchQuery]);

  // TXT next/prev chapter
  const goToNextChapter = async (_fromAutoScroll?: boolean) => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx < chapters.length - 1) {
      await navigateToChapter(chapters[idx + 1], _fromAutoScroll);
    }
  };
  // 保持 ref 始终指向最新渲染的函数，供 IntersectionObserver 回调使用
  goToNextChapterRef.current = goToNextChapter;

  const goToPrevChapter = async () => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx > 0) {
      await navigateToChapter(chapters[idx - 1]);
    }
  };
  goToPrevChapterRef.current = goToPrevChapter;

  /**
   * TTS 自动进入下一章：严格单章播放模式
   * 当一章播放完毕(onEnd)时自动加载下一章文本并播放，确保内容与语音同步
   */
  const advanceToNextChapterTTS = async (player: any) => {
    if (!currentChapterRef.current || !chaptersRef.current.length) return;
    const triggerBookId = currentBookIdRef.current;
    const ci = chaptersRef.current.findIndex((c) => c.id === currentChapterRef.current!.id);
    if (ci < 0 || ci >= chaptersRef.current.length - 1) {
      // 最后一章播完，停止播放
      player.stop();
      setTtsState('idle');
      setTtsProgress(0);
      setActiveSegmentIndex(-1);
      setTtsSegmentText('');
      clearPlaybackFromLocalStorage();
      return;
    }
    const nextCh = chaptersRef.current[ci + 1];
    // 保存上一章完成进度（单个章节完成后标记为全书进度 = (ci+1)/total）
    const totalChaps = chaptersRef.current.length;
    const chapterDonePct = (ci + 1) / totalChaps;
    // 写入真实的全书进度
    debounceSaveProgress({ chapterId: currentChapterRef.current.id, percentage: chapterDonePct });
    try {
      let content = await getCachedChapterContent(triggerBookId!, nextCh.id);
      if (!content) {
        const res = await axios.get(`/api/books/${triggerBookId}/chapters/${nextCh.id}/content`);
        content = res.data.data?.content || '';
      }
      if (currentBookIdRef.current !== triggerBookId) return; // 书籍已切换
      if (!content) return;
      content = book?.format === 'epub' ? stripHtml(content) : content;
      if (!content) return;
      // 更新章节 + 显示内容（严格同步）
      setCurrentChapter(nextCh);
      setDisplayChapter(nextCh);
      currentChapterRef.current = nextCh;
      accumulatedIdsRef.current.clear();
      accumulatedIdsRef.current.add(nextCh.id);
      setTxtContent(content);
      // 重置滚动位置
      if (txtScrollRef.current) txtScrollRef.current.scrollTop = 0;
      // 加载下一章文本到播放器（优先使用预取缓存，后台跨章无需等待 TTS API）
      const loadedFromPrefetch = await player.loadFromPrefetched();
      if (!loadedFromPrefetch) {
        // 无预取数据时回退到标准加载（初次启动或极快切换场景）
        await player.load(content, false, nextCh.id);
      }
      setActiveSegmentIndex(0);
      setTtsProgress(0);
      // 重置进度保存定时器（新的 chapterId）
      await player.play();
      // 预加载再下一章
      preloadNextChapters(nextCh.id);
    } catch {
      // 加载失败，停止播放
      player.stop();
      setTtsState('idle');
    }
  };
  advanceToNextChapterTTSRef.current = advanceToNextChapterTTS;

  // ════════════════════════════════════════════
  // TTS 朗读控制
  // ════════════════════════════════════════════

  /** 获取当前章节的纯文本内容（用于 TTS 朗读） */
  const getCurrentChapterText = useCallback(async (): Promise<string> => {
    if (!currentChapter || !bookId || !book) return '';

    // ⭐ 优先从 IDB 缓存读取（0-5ms，无需网络）
    const cachedContent = await getCachedChapterContent(bookId, currentChapter.id);
    if (cachedContent) {
      return book.format === 'epub' ? stripHtml(cachedContent) : cachedContent;
    }

    // ⭐ 未命中缓存 → 从 API 获取
    try {
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content;
      if (!rawContent) return '';
      // EPUB 内容去 HTML 标签；TXT 内容已经是纯文本
      return book.format === 'epub' ? stripHtml(rawContent) : rawContent;
    } catch { /* fallback */ }

    // 兜底：返回 txtContent（不理想但至少有点内容）
    return txtContent;
  }, [currentChapter, bookId, book, txtContent]);

  // ── TTS 进度保存已迁移至 useProgressPersistence（Phase 4.6）──

  // ⭐ 进入书籍时，若 TTS 播放器正在播放本书 → 同步 UI 状态（恢复高亮、进度、回调）
  useEffect(() => {
    if (!bookId || !currentChapter || loading) return;

    const player = getDefaultPlayer();
    const state = player.getState();
    if (state === 'idle' || player.currentBookId !== bookId) return;

    // ⭐ 播放器正在播放本书 → 同步 UI
    ttsPlayerRef.current = player;
    setTtsState(state);

    const idx = player.getCurrentIndex();
    if (idx >= 0) {
      setActiveSegmentIndex(idx);
      setTtsProgress(player.getTotalChunks() > 0 ? (idx + 1) / player.getTotalChunks() : 0);
      setTtsSegmentText(player.getCurrentSegmentText());
    }

    // ⭐ 注册回调，使高亮和进度持续更新（与 handleStartTTS 中的回调一致）
    player.setCallbacks({
      onStateChange: (s) => {
        setTtsState(s);
        // 睡眠计时器：暂停/停止时清除定时器
        if (s !== 'playing') {
          if (sleepTimerIntervalRef.current) {
            clearInterval(sleepTimerIntervalRef.current);
            sleepTimerIntervalRef.current = null;
          }
        }
      },
      onSegmentPlay: (i, total) => {
        setTtsSegmentText(player.getCurrentSegmentText());
        setActiveSegmentIndex(i);

        // ⭐ 自动滚动到当前高亮分段
        requestAnimationFrame(() => {
            const container = txtScrollRef.current;
            if (!container) return;
            const highlighted = container.querySelector('[data-tts-segment="active"]');
          if (highlighted) {
            highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });

        // ⭐ 播放到 75% 时预加载下一章内容 + 预取下章 TTS 音频
        if (total > 0 && i >= total * 0.75) {
          const ci = chapters.findIndex((c) => c.id === currentChapter?.id);
          if (ci >= 0 && ci < chapters.length - 1) {
            preloadNextChapters(currentChapter!.id);
            // 预取下章 TTS 音频（后台模式跨章无需等待 TTS API）
            triggerTtsPrefetch(ci + 1).catch(() => {});
          }
        }
      },
      onProgress: (p) => setTtsProgress(p),
      onError: (err) => {
        console.warn('TTS 朗读错误:', err);
        // ⭐ 段落级合成失败/无可用音频 → 播放器已自动跳过(playNext)，不弹横幅打扰用户
        if ((err.includes('合成失败') || err.includes('无可用音频')) && !err.includes('当前离线且该段语音未缓存')) {
          return;
        }
        let userMsg = err;
        if (err.includes('当前离线且该段语音未缓存')) {
          userMsg = '该章节的语音缓存不完整，联网后请重新缓存本章或全书。';
        }
        if (err.includes('Failed to fetch') || err.includes('NetworkError') || err.includes('TTS service unavailable')) {
          userMsg = '语音服务连接失败，请检查设置面板中的 TTS 服务地址是否正确，或切换 TTS 后端';
        } else if (err.includes('502') || err.includes('TTS 合成失败')) {
          userMsg = '语音合成失败，TTS 后端可能未启动（默认需 Kokoro :8880），当前仅 Edge-TTS(:8883) 在运行';
        }
        setTtsError(userMsg);
        setTimeout(() => setTtsError(null), 8000);
      },
              onEnd: () => {
        setTtsProgress(1);
        if (sleepTimerIntervalRef.current) {
          clearInterval(sleepTimerIntervalRef.current);
          sleepTimerIntervalRef.current = null;
        }
        // ⭐ 单章播放完毕 → 自动加载下一章并继续播放
        advanceToNextChapterTTSRef.current?.(player);
      },
      // ⭐ 锁屏/通知栏上下章控制 — 委托给章节导航函数
      onPrevChapter: () => {
        const idx = chapters.findIndex((c) => c.id === (currentChapter?.id || ''));
        if (idx > 0) {
          navigateToChapter(chapters[idx - 1]);
        }
      },
      onNextChapter: () => {
        const idx = chapters.findIndex((c) => c.id === (currentChapter?.id || ''));
        if (idx >= 0 && idx < chapters.length - 1) {
          navigateToChapter(chapters[idx + 1]);
        }
      },
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, currentChapter, loading]);

  // ── TTS 控制（Phase 6.2c: 委托 useTtsIntegration hook） ──
  const tts = useTtsIntegration({
    bookId,
    getChapterText: getCurrentChapterText,
    currentChapterId: currentChapter?.id,
    currentChapterTitle: currentChapter?.title,
    bookTitle: book?.title,
    onSegmentChange: (idx, _total) => {
      setActiveSegmentIndex(idx);
      requestAnimationFrame(() => {
        const container = txtScrollRef.current;
        if (!container) return;
        const highlighted = container.querySelector('[data-tts-segment="active"]');
        if (highlighted) highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    onChapterEnd: () => { advanceToNextChapterTTSRef.current?.(ttsPlayerRef.current!); },
  });
  const handleStartTTS = tts.startTTS;
  const handleStopTTS = tts.stopTTS;
  const handlePauseTTS = tts.pauseTTS;
  const handleResumeTTS = tts.resumeTTS;
  const handleTTSSeek = tts.seekTTS;
  const handleSetSleepTimer = tts.setSleepTimer;




  // After book loads, check for saved TTS progress and offer resume
  // ⭐ 全局鼠标/触摸拖拽进度条 seek
  useEffect(() => {
    const bar = progressBarRef.current;
    if (!bar) return;

    const handleGlobalMove = (clientX: number) => {
      if (!isDraggingRef.current) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      handleTTSSeek(pct);
    };

    const onMouseMove = (e: MouseEvent) => handleGlobalMove(e.clientX);
    const onMouseUp = () => { isDraggingRef.current = false; };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 0) handleGlobalMove(e.touches[0].clientX);
    };
    const onTouchEnd = () => { isDraggingRef.current = false; };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd);

    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [handleTTSSeek]);

  // TTS 进度恢复仅在用户点击「朗读」按钮时从 API 获取，进入书籍时不检查


  /** 根据 pageIndex 获取分页后的 TXT 内容 */

  // ── Sync refs with state for closure‑safe access in event handlers ──
  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);
  useEffect(() => { currentChapterRef.current = currentChapter; }, [currentChapter]);

// ── Fix Bug 2: 滚动到底部时自动加载下一章 ──
  // 最小触发间隔（毫秒）：防止内容较短时 rootMargin 导致连续快速触发
  const lastChapterLoadTimeRef = useRef(0);
  const MIN_CHAPTER_INTERVAL = 800;

  useEffect(() => {
    if (readingMode !== 'scroll') return;

    // 找到当前可见的滚动容器（EPUB 文本视图 或 TXT 视图，只存在一个）
    const scrollContainer = txtScrollRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!scrollContainer || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingNextChapterRef.current) return;
        // 最小间隔门控：防止内容较短时 rootMargin 导致连续快速触发
        const now = Date.now();
        if (now - lastChapterLoadTimeRef.current < MIN_CHAPTER_INTERVAL) return;
        const idx = chaptersRef.current.findIndex(
          (c: Chapter) => c.id === currentChapterRef.current?.id
        );
        if (idx < 0 || idx >= chaptersRef.current.length - 1) return;

        // 动态加载门控：仅在章节实际加载完成前阻止重复触发
        loadingNextChapterRef.current = true;
        lastChapterLoadTimeRef.current = now;
        const loadPromise = goToNextChapterRef.current!(true);
        loadPromise.finally(() => {
          loadingNextChapterRef.current = false;
        });
      },
      { root: scrollContainer, threshold: 0, rootMargin: '0px 0px 400px 0px' }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [readingMode, book?.format]);

  // ── TXT 滚动/分页逻辑已迁移至 TxtReaderView 组件（Phase 2.6）──

  // Cleanup on unmount — 使用 ref 避免闭包捕获到 null state
  useEffect(() => {
    return () => {
      // ⭐ 使用 currentChapterRef.current（ref）而非 currentChapter（state，在 [] 闭包中为 null）
      const chap = currentChapterRef.current;
      if (ttsPlayerRef.current && chap) {
        const idx = ttsPlayerRef.current.getCurrentIndex();
        const total = ttsPlayerRef.current.getTotalChunks();
        if (idx >= 0 && total > 0) {
          // ⭐ 直接 axios.put（绕过 debounceSaveProgress，避免 800ms 延时被后面的 clearTimeout 取消）
          const cIdx = chaptersRef.current.findIndex((c: any) => c.id === chap.id);
          const totalCh = chaptersRef.current.length;
          const chapterPct = (idx + 1) / total;
          const bookPct = cIdx >= 0 && totalCh > 0
            ? (cIdx + chapterPct) / totalCh
            : chapterPct;
          axios.put(`/api/books/${bookId}/progress`, {
            chapterId: chap.id,
            textOffset: idx,
            percentage: bookPct,
          }).catch(() => {});
          // 同时也持久化到 localStorage
          savePlaybackToLocalStorage({
            bookId: bookId || '',
            chapterId: chap.id,
            segmentIndex: idx,
            timestamp: Date.now(),
          });
        }
      }
      if (progressSaveTimer.current) {
        clearTimeout(progressSaveTimer.current);
      }
      // 不销毁 TTS 播放器——保持后台播放（用户可能在书架页继续听）
      if (ttsPlayerRef.current) {
        ttsPlayerRef.current = null;
      }
    };
  }, []); // ⚠️ 仅组件卸载时执行清理，不要依赖 currentChapter（否则每次翻页/切换章节都会销毁 viewer）

  if (loading) {
    return (
      <div className="h-screen flex flex-col" style={{background: 'var(--color-bg)'}}>
        <ReaderTopBar title="" onBack={() => navigate('/')} readingMode="scroll" onToggleReadingMode={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-lg" style={{color: 'var(--color-text-muted)'}}>加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col" style={{background: 'var(--color-bg)'}}>
        <ReaderTopBar title="" onBack={() => navigate('/')} readingMode="scroll" onToggleReadingMode={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-red-500 mb-4">{error}</p>
            <div className="flex flex-col items-center gap-3">
              <button
                onClick={() => { setError(null); loadBook(); }}
                className="px-4 py-2 rounded-lg font-medium" style={{background: 'var(--color-primary)', color: 'white'}}
              >
                重试
              </button>
              {isOfflineMode && (
                <>
                  <button
                    onClick={() => navigate('/login', { replace: true })}
                    className="px-4 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-sm font-medium"
                  >
                    返回登录页
                  </button>
                  <button
                    onClick={exitOfflineMode}
                    className="px-4 py-1.5 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-sm font-medium"
                  >
                    退出离线模式
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
         <div className="reader-root h-[100dvh]" style={{background: 'var(--color-bg)'}}>
      <div className="h-full relative">

        {/* Reader Content - full screen, no fixed toolbar */}
        <div className="h-full flex flex-col">
          <div
            ref={interaction.attachElement}
            className="flex-1 flex overflow-hidden relative"
          >
        {/* TOC Sidebar */}
        {showToc && (
          <div onClick={(e) => e.stopPropagation()} className="w-64 sm:w-72 overflow-y-auto absolute sm:relative z-30 inset-y-0 left-0 shadow-lg sm:shadow-none" style={{background: 'var(--color-bg-card)', borderRight: '0.5px solid var(--color-border)'}}>
            <div className="p-3 font-semibold text-sm flex items-center justify-between" style={{borderBottom: '0.5px solid var(--color-border)'}}>
              <span>章节目录</span>
              {book?.format === 'epub' && (
                <button
                  onClick={handleReparse}
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
              const isActive = currentChapter?.id === ch.id;
              return (
                <div key={ch.id} ref={isActive ? activeTocItemRef : null} className="relative">
                  {isActive && (
                    <div className="absolute left-0 top-0 bottom-0 w-1 rounded-r-sm" style={{background: 'var(--color-primary)'}} />
                  )}
                  <button
                    onClick={() => navigateToChapter(ch)}
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
        )}



        {/* TTS 恢复横幅已移除 — 进入书籍不涉及 TTS 播放 */}

        {/* TTS Error Banner */}
        {ttsError && (
          <div className="absolute top-0 left-0 right-0 z-10 mx-auto max-w-xl mt-2">
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2 flex items-center justify-between shadow-sm">
              <span className="text-xs sm:text-sm text-red-800 dark:text-red-200 flex-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> {ttsError}
              </span>
              <button
                onClick={() => setTtsError(null)}
                className="text-xs px-2 py-1 rounded bg-red-200 dark:bg-red-700 text-red-700 dark:text-red-300 ml-2 shrink-0"
              >
                关闭
              </button>
            </div>
          </div>
        )}

        {/* EPUB Reader — 由 epub.js 托管（根治旧自研分页引擎的黑屏/翻节/字体重排乱） */}
        {book?.format === 'epub' && (
          <EpubViewer
            bookId={book.id}
            fileUrl={`/api/books/${book.id}/file/`}
            readingMode={readingMode}
            fontSize={fontSize}
            fontFamily={fontFamily}
            lineHeight={lineHeight}
            letterSpacing={letterSpacing}
            initialCfi={epubCfiRef.current}
            pageControlRef={epubPageControlRef}
            chapterNavRef={epubChapterNavRef}
            onTap={closeMenu}
            interactionBlocked={showUi || showToc || showSearch || ttsState !== 'idle'}
            onSelectionTextChange={setSelectedText}
            onLocationChange={(cfi, chapterRatio) => {
              epubCfiRef.current = cfi;
              if (typeof chapterRatio === 'number') {
                epubChapterRatioRef.current = chapterRatio;
              }
              if (currentBookIdRef.current) {
                debounceSaveProgress({ cfi });
              }
            }}
            onPrevChapter={() => {
              goToPrevChapterRef.current?.();
            }}
            onNextChapter={() => {
              goToNextChapterRef.current?.();
            }}
          />
        )}

        {/* ⭐ EPUB 常驻上下章按钮 — 点击跳转章节，替代有缺陷的滚动监听自动加载 */}
        {book?.format === 'epub' && (
          <>
            {/* 上一章 — 左侧居中 */}
            <button
              onClick={() => {
                const idx = chapters.findIndex((c) => c.id === currentChapter?.id);
                if (idx > 0) navigateToChapter(chapters[idx - 1]);
              }}
              disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter?.id) <= 0}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 opacity-40 hover:opacity-100 disabled:opacity-10 disabled:pointer-events-none"
              style={{background: 'var(--color-bg-alt)', color: 'var(--color-text)'}}
              title="上一章"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            {/* 下一章 — 右侧居中 */}
            <button
              onClick={() => {
                const idx = chapters.findIndex((c) => c.id === currentChapter?.id);
                if (idx >= 0 && idx < chapters.length - 1) navigateToChapter(chapters[idx + 1]);
              }}
              disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter?.id) >= chapters.length - 1}
              className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 opacity-40 hover:opacity-100 disabled:opacity-10 disabled:pointer-events-none"
              style={{background: 'var(--color-bg-alt)', color: 'var(--color-text)'}}
              title="下一章"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </>
        )}

        {/* TXT Reader — 由 TxtReaderView 组件托管（Phase 2.6 剥离） */}
        {book?.format === 'txt' && (
          <TxtReaderView
            ref={txtReaderViewRef}
            content={txtContent}
            chapterTitle={(displayChapter || currentChapter)?.title || ''}
            readingMode={readingMode}
            fontSize={fontSize}
            lineHeight={lineHeight}
            letterSpacing={letterSpacing}
            fontFamily={fontFamily}
            ttsSegments={null}
            activeSegmentIndex={activeSegmentIndex}
            searchResults={searchResults}
            onProgress={(ratio) => { charOffsetRatioRef.current = ratio; }}
            onBoundary={(dir) => {
              if (dir === 'next') goToNextChapterRef.current?.();
              else goToPrevChapterRef.current?.();
            }}
            onPageInfo={(page, total) => { setPageIndex(page); setTotalPages(total); }}
            initialScrollRatio={pendingScrollRestorePct}
            isPageTurning={isPageTurning}
          />
        )}

        {/* ── 搜索浮层 ── */}
        {showSearch && (
          <div className="absolute inset-0 z-40 flex items-start justify-center pt-16" onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }}>
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
              {/* 搜索输入框 */}
              <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSearchQuery(val);
                    // 防抖：输入停顿 400ms 后才执行全书搜索
                    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
                    if (!val) { setSearchResults([]); setSearchActiveIdx(-1); return; }
                    searchTimerRef.current = setTimeout(() => performSearch(val), 400);
                  }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && searchResults.length > 0) { handleSearchJump(searchResults[0]); } if (e.key === 'Escape') { setShowSearch(false); setSearchQuery(''); setSearchResults([]); } }}
                  placeholder="搜索全书…"
                  className="flex-1 bg-transparent outline-none text-sm py-1.5 text-gray-800 dark:text-gray-200 placeholder-gray-400"
                  autoFocus
                />
                <button
                  onClick={() => { setShowSearch(false); setSearchQuery(''); setSearchResults([]); }}
                  className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
              {/* 搜索结果列表 */}
              <div className="max-h-64 overflow-y-auto">
                {searchQuery && isSearchingFullBook && searchResults.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">
                    <span className="animate-pulse">正在搜索全书…</span>
                  </div>
                )}
                {searchQuery && !isSearchingFullBook && searchResults.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gray-400">未找到匹配结果</div>
                )}
                {/* 目录匹配分隔线（有正文匹配时显示） */}
                {searchResults.some(r => r.isChapterMatch) && searchResults.some(r => !r.isChapterMatch) && (
                  <div className="px-3 py-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/10 border-b border-blue-100 dark:border-blue-800/30">
                    📖 章节匹配（最高优先级）
                  </div>
                )}
                {searchResults.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => handleSearchJump(result)}
                    className={`w-full text-left px-4 py-2.5 text-sm border-b border-gray-100 dark:border-gray-700 last:border-b-0 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors duration-150 ${
                      searchActiveIdx === i ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                    }`}
                  >
                    <span className="block text-xs text-gray-400 mb-0.5">
                      {result.isChapterMatch ? (
                        <span className="inline-flex items-center gap-1">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-blue-500"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                          章节匹配
                        </span>
                      ) : (
                        <>匹配 {i + 1}</>
                      )}
                      {result.chapterTitle && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                          {result.chapterTitle}
                        </span>
                      )}
                    </span>
                    {result.isChapterMatch ? (
                      <span className="text-blue-700 dark:text-blue-300 font-medium">
                        {result.chapterTitle}
                      </span>
                    ) : (
                      <span className="text-gray-700 dark:text-gray-300 leading-relaxed" dangerouslySetInnerHTML={{
                        __html: result.text.replace(
                          new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                          '<mark class="bg-yellow-300 dark:bg-yellow-600 text-gray-900 dark:text-gray-100 rounded px-0.5">$1</mark>'
                        )
                      }} />
                    )}
                  </button>
                ))}
                {/* 全文搜索进行中提示 */}
                {searchQuery && isSearchingFullBook && searchResults.length > 0 && (
                  <div className="px-3 py-2 text-xs text-center text-gray-400 border-t border-gray-100 dark:border-gray-700">
                    <span className="animate-pulse">正在深入搜索全文内容…</span>
                  </div>
                )}
              </div>
              {searchResults.length > 0 && !isSearchingFullBook && (
                <div className="px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 text-center">
                  共 {searchResults.length} 个匹配结果，点击跳转
                </div>
              )}
            </div>
          </div>
        )}

        {/* TTS 朗读进度指示（浮层） */}
        {/* TTS 朗读进度指示（浮层） */}
        {ttsState !== 'idle' && ttsSegmentText && (
          <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
                          <div className="mx-auto max-w-3xl px-3 sm:px-6 pb-16">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                <p className="text-sm text-blue-800 dark:text-blue-200 line-clamp-2">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> {ttsSegmentText}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
        </div>

        {/* ✅ 复制成功 Toast — 覆盖在阅读区上方，2秒自动消失 */}
        {copiedToast && (
          <div className="absolute top-24 left-1/2 -translate-x-1/2 z-40 animate-slide-up pointer-events-none">
            <div className="rounded-full px-5 py-2 flex items-center gap-2 shadow-lg"
              style={{ background: 'var(--color-primary)', color: '#fff' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              已复制到剪贴板
            </div>
          </div>
        )}

        {/* ☰ 左下角半透明菜单图标 — 点击弹出/关闭浮动操作面板 */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleFloatMenu(); }}
          className="absolute bottom-6 left-6 z-35 w-11 h-11 rounded-full flex items-center justify-center transition-opacity duration-200 hover:opacity-80 active:scale-90"
          style={{ background: 'rgba(128,128,128,0.5)', opacity: 0.5 }}
          aria-label="菜单"
          title="菜单"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        {/* ☰ 悬浮操作面板：点击左下角半透明图标弹出，点击半透明背景关闭 */}
        {showUi && (
          <ReaderControlPanel
            onBack={() => navigate('/')}
            onSearch={() => { setShowSearch(true); closeMenu(); setTimeout(() => searchInputRef.current?.focus(), 100); }}
            onToggleToc={() => { setShowToc(v => !v); closeMenu(); }}
            showToc={showToc}
            chapterTitle={(displayChapter || currentChapter)?.title || book?.title || ''}
            ttsState={ttsState}
            ttsProgress={ttsProgress}
            onStartTTS={handleStartTTS}
            onPauseTTS={handlePauseTTS}
            onResumeTTS={handleResumeTTS}
            onStopTTS={handleStopTTS}
            onSeek={handleTTSSeek}
            onPrevChapter={() => goToPrevChapterRef.current?.()}
            onNextChapter={() => goToNextChapterRef.current?.()}
            sleepTimerMinutes={tts.sleepTimerMinutes}
            onSetSleepTimer={handleSetSleepTimer}
            fontSize={fontSize}
            setFontSize={setFontSize}
            lineHeight={lineHeight}
            setLineHeight={setLineHeight}
            fontFamily={fontFamily}
            setFontFamily={setFontFamily}
            readingMode={readingMode}
            onToggleReadingMode={() => {
              const goingToPaginated = readingMode === 'scroll';
              if (goingToPaginated) {
                const scrollEl = txtPageRef.current;
                if (scrollEl && scrollEl.scrollHeight > 0) {
                  charOffsetRatioRef.current = Math.min(1, Math.max(0, scrollEl.scrollTop / scrollEl.scrollHeight));
                }
                setReadingMode('paginated');
              } else {
                setReadingMode('scroll');
              }
            }}
            currentChapterIndex={currentChapter ? chapters.findIndex(c => c.id === currentChapter.id) : -1}
            totalChapters={chapters.length}
            bookFormat={book?.format}
            pageIndex={pageIndex}
            totalPages={totalPages}
            onPageTurn={(dir) => performPageTurnRef.current(dir)}
            selectedText={selectedText}
            onCopy={async () => {
              const text = selectedText || window.getSelection()?.toString().trim() || '';
              if (!text) return;
              try {
                await navigator.clipboard.writeText(text);
                setCopiedToast(true);
                setSelectedText('');
                window.getSelection()?.removeAllRanges();
                closeMenu();
                setTimeout(() => setCopiedToast(false), 2000);
              } catch { /* Clipboard API unavailable */ }
            }}
            cachingInProgress={cachingInProgress}
            cacheProgressText={cacheProgressText}
            cacheStatus={cacheStatus}
            onCacheChapter={handleCacheCurrentChapter}
            onCacheFullBook={handleCacheFullBook}
            onClearTextCache={handleClearTextCache}
            onClearAudioCache={handleClearAudioCache}
            onClose={closeMenu}
          />
        )}
      </div>
    </div>
  );
}


export default ReaderPage;
