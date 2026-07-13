import React, { useState, useEffect, useRef, useCallback } from 'react';
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
} from '../services/offlineCacheService';
import axios from 'axios';
import {
  getDefaultPlayer,
  splitText,
  type PlayerState,
} from '../services/ttsPlayer';
import type { BookCacheDetailedStats } from '../services/offlineCacheService';

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
const TTS_PROGRESS_SAVE_INTERVAL = 3000; // ms interval for saving TTS playback position
const TTS_PLAYBACK_KEY = 'ireader_tts_playback'; // localStorage key for TTS playback session (survives page refresh)

/** 格式化字节数为人类可读 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null);
  const [txtContent, setTxtContent] = useState<string>('');
  const [epubDisplayHtml, setEpubDisplayHtml] = useState<string>(''); // Sanitized EPUB HTML for display (preserves images)
  const [loading, setLoading] = useState(true);
  const [chapterLoading, setChapterLoading] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // ── 阅读偏好持久化（localStorage） ──
  const READER_PREFS_KEY = 'ireader_reader_prefs';
  const loadReaderPrefs = () => {
    try {
      const raw = localStorage.getItem(READER_PREFS_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  };
  const saveReaderPrefs = (prefs: Record<string, any>) => {
    try {
      const current = loadReaderPrefs() || {};
      localStorage.setItem(READER_PREFS_KEY, JSON.stringify({ ...current, ...prefs }));
    } catch { /* ignore */ }
  };
  const initialPrefs = loadReaderPrefs() || {};

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


  const [fontSize, setFontSize] = useState(initialPrefs.fontSize ?? 18);
  const [fontFamily, setFontFamily] = useState<'sans' | 'serif' | 'mono'>(initialPrefs.fontFamily ?? 'sans');
  const [lineHeight, setLineHeight] = useState(initialPrefs.lineHeight ?? 1.8);
  const [letterSpacing] = useState(initialPrefs.letterSpacing ?? 0.01);
  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsSpeed, setTtsSpeed] = useState(() => {
    try {
      const raw = localStorage.getItem('ireader_tts_speed');
      return raw ? parseFloat(raw) : 1.0;
    } catch { return 1.0; }
  });
  const ttsVolume = 1.0;
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [readingMode, setReadingMode] = useState<'scroll' | 'paginated'>(initialPrefs.readingMode ?? 'scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // ── 翻页模式（ReadiumCSS 横向滚动分页模型）──
  /** 翻页容器 ref：column-fill:auto + overflow-x:auto 的横向滚动分页 */
  const paginatedScrollRef = useRef<HTMLDivElement>(null);
  /** 跨模式共享的字符位置比例 [0,1]，用于切换模式时从当前阅读位置精确恢复（不跳回开头） */
  const charOffsetRatioRef = useRef<number>(0);
  /** 翻页模式是否正在重建内容（防止翻页动画与重建冲突） */
  const isRebuildingRef = useRef(false);
  const [ttsVoice, setTtsVoice] = useState(() => {
    try { return localStorage.getItem('ireader_tts_voice') || 'zh-CN-XiaoxiaoNeural'; } catch { return 'zh-CN-XiaoxiaoNeural'; }
  });


  // ── 悬浮UI控制（全屏阅读：点击屏幕显示/隐藏所有控件） ──
  const [showUi, setShowUi] = useState(false);
  const txtPageRef = useRef<HTMLDivElement>(null);
  const progressSaveTimer = useRef<any>(null);
  const ttsProgressSaveTimer = useRef<any>(null);
  const ttsPlayerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const chaptersRef = useRef(chapters);
  const currentChapterRef = useRef(currentChapter);
  const loadingNextChapterRef = useRef(false);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const goToNextChapterRef = useRef<((_fromAutoScroll?: boolean) => Promise<void>) | null>(null);
  /** navigateToChapter ref — 用于翻页动画回调中访问（避免闭包过期） */
  const navigateToChapterRef = useRef<((chapter: Chapter, _append?: boolean) => Promise<void>) | null>(null);
  /** TTS 自动进入下一章 — ref 包装避免闭包过期 */
  const advanceToNextChapterTTSRef = useRef<((player: any) => Promise<void>) | null>(null);
  const txtScrollRef = useRef<HTMLDivElement>(null);
  const savedTtsProgressRef = useRef<{chapterId: string; segmentIndex: number; progress: number} | null>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  /** 当前书籍 ID 的 ref（用于异步操作的书籍切换守卫） */
  const currentBookIdRef = useRef<string | undefined>(bookId);
  /** 进度条容器 ref（用于拖拽 seek） */
  const [pendingScrollRestorePct, setPendingScrollRestorePct] = useState<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  /** 是否正在拖拽进度条（防止 mouseup 未触发导致的卡住） */
  const isDraggingRef = useRef(false);



  // ── 全屏阅读：点击屏幕切换UI显示 ──
  const handleTapReader = useCallback(() => {
    // 如果目录(TOC)已打开，点击阅读区只关闭目录，不弹浮动菜单
    if (showToc) {
      setShowToc(false);
      return;
    }
    setShowUi(prev => !prev);
  }, [showToc]);

  // uiHideTimerRef 保留供兼容（不再使用定时器，仅留 ref 避免编译报错）

  // ── 睡眠计时器 ──
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);

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

  /** 执行翻页 — ref 包装，让 handleSwipeEnd 等前面定义的函数也能引用 */
  const performPageTurnRef = useRef<(direction: 'prev' | 'next') => Promise<void>>(async () => {});
  const [isPageTurning, setIsPageTurning] = useState(false);
  /** ── ref 同步最新状态（供 useCallback([]) 内部闭包读取） ── */
  const readingModeRef = useRef(readingMode);
  const ttsStateRef = useRef(ttsState);
  const isPageTurningRef = useRef(isPageTurning);
  // 同步 ref 与 state，供 useCallback([]) 内部闭包读取最新值
  useEffect(() => { readingModeRef.current = readingMode; }, [readingMode]);
  useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);
  useEffect(() => { isPageTurningRef.current = isPageTurning; }, [isPageTurning]);
  const swipeStartRef = useRef<{ x: number; y: number; time: number } | null>(null);

  /** 触摸开始：记录起始位置 */
  const handleSwipeStart = useCallback((clientX: number, clientY: number) => {
    swipeStartRef.current = { x: clientX, y: clientY, time: Date.now() };
  }, []);

  /** 触摸结束：判断滑动方向 */
  const handleSwipeEnd = useCallback((clientX: number, clientY: number) => {
    const start = swipeStartRef.current;
    if (!start) return;
    const dx = clientX - start.x;
    const dy = clientY - start.y;
    const dt = Date.now() - start.time;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    swipeStartRef.current = null;

    // 正在翻页动画中、TTS 或搜索打开时，不处理滑动
    if (isPageTurning) return;
    if (ttsState !== 'idle' || showSearchRef.current) return;
    if (readingMode !== 'paginated') return;

    // 滑动距离 > 50px 且水平方向 > 垂直方向 → 翻页
    if (absDx > 50 && absDx > absDy * 1.5 && dt < 500) {
      if (dx < 0) {
        performPageTurnRef.current('next');
      } else {
        performPageTurnRef.current('prev');
      }
    }
  }, [isPageTurning, ttsState, readingMode]);

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
  const sleepTimerEndRef = useRef<number | null>(null);
  const sleepTimerIntervalRef = useRef<any>(null);
  
  /** Preloaded next-chapter contents for smooth scroll transitions */
  /** Track chapter IDs accumulated during auto-scroll for continuous reading */
  const accumulatedIdsRef = useRef<Set<string>>(new Set());
  /** Preloaded next-chapter contents for smooth scroll transitions */
  const preloadedChaptersRef = useRef<Map<string, {content: string; html?: string}>>(new Map());
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
      // 内联 HTML 剥离
        const simpleStrip2 = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      const content = book.format === 'epub' ? simpleStrip2(rawContent) : rawContent;
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
      const chapterData: { chapterId: string; title: string; order: number; content: string }[] = [];
      if (!textAlreadyCached) {
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
        try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; }
      })();

      // 跳过实时合成模式
      if (!noCachePref) {
        const MAX_CONCURRENT = 6; // 全局并发池上限
        let totalCached = 0;

        // ⭐ 阶段2a：先尝试批量拉取服务端已缓存的（后台预合成）音频
        // 这样已预合成的段落就走批量下载，不走逐段 POST /api/tts
        setCacheProgressText('检测服务端缓存...');
        const batchDownloaded = await downloadBatchCachedAudio(
          bookId, effectiveVoice, effectiveSpeed, chapters,
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
                const existing = await getCachedTTSAudio(bookId, task.chapter.id, task.segIdx);
                if (!existing) {
                  const res = await fetch('/api/tts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      input: task.seg,
                      voice: effectiveVoice,
                      speed: effectiveSpeed,
                      response_format: 'wav',
                      tts_source: 'kokoro',
                      no_cache: false,
                    }),
                  });
                  if (res.ok) {
                    const arrayBuffer = await res.arrayBuffer();
                    await cacheTTSAudio(bookId, task.chapter.id, task.segIdx, arrayBuffer);
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
      if (ttsProgressSaveTimer.current) {
        clearInterval(ttsProgressSaveTimer.current);
        ttsProgressSaveTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ── 持久化阅读偏好 ──
  useEffect(() => { saveReaderPrefs({ fontSize }); }, [fontSize]);
  useEffect(() => { saveReaderPrefs({ fontFamily }); }, [fontFamily]);
  useEffect(() => { saveReaderPrefs({ lineHeight }); }, [lineHeight]);
  useEffect(() => { saveReaderPrefs({ readingMode }); }, [readingMode]);
  useEffect(() => { saveReaderPrefs({ letterSpacing }); }, [letterSpacing]);


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
      const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;

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
        const progRes = await axios.get(`/api/books/${bookId}/progress`);
        savedProgress = progRes.data.data;
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
        // 统一用字符位置比例恢复（scroll / paginated 共用）
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
  // Remove all remaining HTML tags
  s = s.replace(/<[^>]+>/g, '');
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

  /** Sanitize EPUB HTML for safe display with images */
  const sanitizeEpubHtml = useCallback((rawHtml: string, bookId: string): string => {
    let s = rawHtml;
    // Remove script/style/iframe/object/embed blocks completely
    s = s.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    s = s.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    s = s.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
    s = s.replace(/<object[^>]*>[\s\S]*?<\/object>/gi, '');
    s = s.replace(/<embed[^>]*>[\s\S]*?<\/embed>/gi, '');
    // Remove event handler attributes (onclick, onerror, etc.)
    s = s.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    // Strip <link> CSS tags (prevents MIME errors when relative CSS paths hit SPA fallback)
    s = s.replace(/<link\b[^>]*>/gi, '');
    // Strip <a> href links (prevent clicks from navigating SPA away to nonexistent routes → 404)
    // EPUB internal links like href="text00007.html" would cause /api/books/text00007.html 404
    s = s.replace(/<a\b[^>]*>/gi, '<span>');
    s = s.replace(/<\/a>/gi, '</span>');
    // Rewrite relative image src paths to absolute backend URLs
    s = s.replace(/<img\s+([^>]*?)src\s*=\s*"(?!http|\/\/)([^"]+)"/gi, (_, before, src) => {
      return `<img ${before}src="/api/books/${bookId}/files/${src}"`;
    });
    s = s.replace(/<img\s+([^>]*?)src\s*=\s*'(?!http|\/\/)([^']+)'/gi, (_, before, src) => {
      return `<img ${before}src="/api/books/${bookId}/files/${src}"`;
    });
    // Fix any double slashes from concatenation (e.g. /api/books/id/files//images/foo.jpg)
    s = s.replace(/\/files\/\//g, '/files/');
    return s;
  }, []);

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
      let epubHtml: string | undefined;
      if (preloaded) {
        content = preloaded.content;
        epubHtml = preloaded.html;
        preloadedChaptersRef.current.delete(chapter.id);
      } else {
        // 尝试从客户端离线缓存读取
        const cachedContent = await getCachedChapterContent(bookId!, chapter.id);
        if (cachedContent) {
          content = cachedContent;
          if (!_append) setChapterLoading(false);
        } else {
          if (!_append) setChapterLoading(true);
          const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
          const rawContent = res.data.data?.content || '';
          if (isEpub) {
            epubHtml = sanitizeEpubHtml(rawContent, bookId!);
            content = stripHtml(rawContent);
            if (!_append && !_forcePlainText) {
              setEpubDisplayHtml(epubHtml);
            }
          } else {
            setEpubDisplayHtml('');
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
        // EPUB 追加模式：也将 HTML 版本追加到 epubDisplayHtml（保留图片）
        if (isEpub && epubHtml) {
          setEpubDisplayHtml(prev => prev + '\n' + epubHtml);
        }
      } else {
        // 手动跳转：替换内容，重置累积记录
        accumulatedIdsRef.current.clear();
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(displayContent);
        // 手动跳转 EPUB：替换为当前章节的 HTML 版本
        // ⭐ 但在强制纯文本模式（搜索跳转）下跳过，确保 DOM 文本与搜索 offset 一致
        if (!_forcePlainText && isEpub && epubHtml) {
          setEpubDisplayHtml(epubHtml);
        } else if (!_forcePlainText && isEpub) {
          setEpubDisplayHtml(displayContent);
        } else if (_forcePlainText) {
          setEpubDisplayHtml('');
        }
      }
    } catch (err: any) {
      setError('加载章节内容失败');
      setChapterLoading(false);
    }
  };

  // ── 增量列分页引擎：核心函数 ──

  /**
   * 获取章节内容（优先预加载缓存 → 离线缓存 → API）
   * 返回纯文本（TXT直接返回，EPUB stripHtml）
   */
  const fetchChapterText = useCallback(async (chapter: Chapter, isEpub: boolean): Promise<string> => {
    const preloaded = preloadedChaptersRef.current.get(chapter.id);
    if (preloaded) {
      preloadedChaptersRef.current.delete(chapter.id);
      return preloaded.content;
    }
    const cachedContent = await getCachedChapterContent(bookId!, chapter.id);
    if (cachedContent) return cachedContent;
    const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
    const raw = res.data.data?.content || '';
    return isEpub ? stripHtml(raw) : raw;
  }, [bookId]);

  /**
   * HTML 实体转义（防止章节标题中的特殊字符破坏 DOM 结构）
   */
  const escapeHtml = useCallback((text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }, []);

  /**
   * 将纯文本转为安全的 innerHTML（处理换行 → <br>、空格等）
   */
  const textToHtml = useCallback((text: string): string => {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
      .replace(/  /g, '&nbsp;&nbsp;');
  }, []);

  /**
   * 重建翻页模式内容（ReadiumCSS 横向滚动分页模型）
   *
   * 核心思想：用单个横向滚动容器 `paginatedScrollRef`，
   * CSS `column-fill:auto; column-count:1; column-gap; height:100%; overflow-x:auto`。
   * 内容 = 当前章节起 + 前一章尾部 + 后续若干章 的连续 HTML（EPUB 保留图片/排版）。
   * 页 = 一屏宽，翻页 = scrollLeft ± clientWidth。
   *
   * @param startChapter   起始章节（从当前阅读章节开始，不会跳回书籍开头）
   * @param resumeRatio   跨模式/跨章恢复用的字符位置比例 [0,1]，默认从上次保存位置恢复
   */
  const rebuildPaginatedContent = useCallback(async (
    startChapter: Chapter,
    resumeRatio?: number,
  ) => {
    const el = paginatedScrollRef.current;
    if (!el || !chapters.length) return;
    isRebuildingRef.current = true;

    const isEpub = book?.format === 'epub';
    const startIdx = chapters.findIndex(c => c.id === startChapter.id);
    if (startIdx < 0) { isRebuildingRef.current = false; return; }

    // 取前一章尾（用于跨章连续翻页的无缝衔接）+ 当前章 + 后续 3 章
    const fromIdx = Math.max(0, startIdx - 1);
    const toIdx = Math.min(chapters.length - 1, startIdx + 3);
    const windowChapters = chapters.slice(fromIdx, toIdx + 1);

    try {
      const fragments: string[] = [];
      for (const ch of windowChapters) {
        const text = await fetchChapterText(ch, isEpub);
        const sep = `<h2 class="chapter-title" data-chapter-id="${ch.id}">${escapeHtml(ch.title || '未命名章节')}</h2>`;
        const body = isEpub
          ? sanitizeEpubHtml(text, bookId!)
          : `<div class="chapter-text">${textToHtml(text)}</div>`;
        fragments.push(`<section class="reader-section" data-chapter-id="${ch.id}">${sep}${body}</section>`);
      }
      el.innerHTML = fragments.join('');

      setCurrentChapter(startChapter);
      currentChapterRef.current = startChapter;
      setDisplayChapter(startChapter);

      // 恢复位置：优先用传入 ratio，否则用跨模式保存的字符比例，否则 0
      const ratio = resumeRatio ?? charOffsetRatioRef.current ?? 0;
      requestAnimationFrame(() => {
        const maxLeft = Math.max(0, el.scrollWidth - el.clientWidth);
        el.scrollLeft = ratio * maxLeft;
        const pw = el.clientWidth || 1;
        const total = Math.max(1, Math.ceil(el.scrollWidth / pw));
        setTotalPages(total);
        setPageIndex(Math.round(ratio * (total - 1)));
        isRebuildingRef.current = false;
      });

      // 预加载后续章节
      preloadNextChaptersRef.current(startChapter.id);
    } catch {
      isRebuildingRef.current = false;
    }
  }, [chapters, book, bookId, fetchChapterText, sanitizeEpubHtml, textToHtml]);

  /**
   * 翻页（横向滚动分页模型）
   * 翻页 = scrollLeft ± clientWidth（一屏一页）
   * 到当前窗口末尾时自动翻到下一章并保留末尾比例；到开头时翻到上一章末页。
   */
  const performPageTurn = useCallback(async (direction: 'prev' | 'next') => {
    if (ttsStateRef.current !== 'idle' || showSearchRef.current || isPageTurningRef.current) return;
    if (readingModeRef.current !== 'paginated') return;
    if (isRebuildingRef.current) return;

    const el = paginatedScrollRef.current;
    if (!el) return;
    const pw = el.clientWidth;
    if (pw <= 0) return;

    setIsPageTurning(true);
    try {
      if (direction === 'next') {
        if (el.scrollLeft + pw < el.scrollWidth - 1) {
          // 窗口内下一页
          el.scrollTo({ left: el.scrollLeft + pw, behavior: 'smooth' });
          const total = Math.max(1, Math.ceil(el.scrollWidth / pw));
          setPageIndex(Math.min(total - 1, Math.round(el.scrollLeft / pw) + 1));
        } else {
          // 到达窗口末尾 → 翻到下一章，保留末尾无缝衔接
          const idx = chapters.findIndex(c => c.id === currentChapterRef.current?.id);
          if (idx >= 0 && idx < chapters.length - 1) {
            const next = chapters[idx + 1];
            // 用 0.85 比例让新章首与旧章末视觉衔接
            await rebuildPaginatedContent(next, 0.85);
          }
        }
      } else {
        if (el.scrollLeft > 1) {
          el.scrollTo({ left: Math.max(0, el.scrollLeft - pw), behavior: 'smooth' });
          setPageIndex(Math.max(0, Math.round(el.scrollLeft / pw) - 1));
        } else {
          const idx = chapters.findIndex(c => c.id === currentChapterRef.current?.id);
          if (idx > 0) {
            const prev = chapters[idx - 1];
            await rebuildPaginatedContent(prev, 0.15);
          }
        }
      }
    } finally {
      setTimeout(() => setIsPageTurning(false), 350);
    }
  }, [chapters, rebuildPaginatedContent]);
  // 保持 ref 同步，供键盘/手势事件调用
  performPageTurnRef.current = performPageTurn;

  // Debounced progress save

  /** 预加载后续3个章节 — ref 包装，供引擎函数引用（避免循环依赖） */
  const preloadNextChaptersRef = useRef<(currentChapterId: string) => Promise<void>>(async () => {});
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
                // EPUB: 同时存储 HTML（有图片）和纯文本（TTS 用）
                const html = sanitizeEpubHtml(rawContent, bookId!);
                pageThis.current.set(next.id, { content: stripHtml(rawContent), html });
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
      try {
        const res = await axios.get(`/api/books/${bookId}/chapters/${nextCh.id}/content`);
        const raw = res.data.data?.content || '';
        content = book?.format === 'epub' ? stripHtml(raw) : raw;
      } catch { return; }
    }
    if (!content) return;
    const segments = splitText(content);
    if (segments.length === 0) return;
    // 推入播放器的预取缓冲区（不阻塞当前播放）
    const player = getDefaultPlayer();
    player.prefetchChapterSegments(segments).catch(() => {});
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

  // TXT chapter navigation（使用增量列分页引擎）
  const navigateToChapter = async (chapter: Chapter, _append?: boolean) => {
    setShowToc(false);

    if (readingMode === 'paginated') {
      // 翻页模式：从目标章节重建分页内容（不跳回书籍开头）
      await rebuildPaginatedContent(chapter);
    } else {
      // 滚动模式：使用传统的 loadChapterContent
      await loadChapterContent(chapter);
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
      if (ttsProgressSaveTimer.current) {
        clearInterval(ttsProgressSaveTimer.current);
        ttsProgressSaveTimer.current = null;
      }
      return;
    }
    const nextCh = chaptersRef.current[ci + 1];
    // 保存上一章完成进度（单个章节完成后标记为全书进度 = (ci+1)/total）
    const totalChaps = chaptersRef.current.length;
    const chapterDonePct = (ci + 1) / totalChaps;
    saveTtsProgress(currentChapterRef.current.id, -1, 1);
    // 写入真实的全书进度
    debounceSaveProgress({ chapterId: currentChapterRef.current.id, percentage: chapterDonePct });
    try {
      const res = await axios.get(`/api/books/${triggerBookId}/chapters/${nextCh.id}/content`);
      if (currentBookIdRef.current !== triggerBookId) return; // 书籍已切换
      let rawContent = res.data.data?.content || '';
      const content = book?.format === 'epub' ? stripHtml(rawContent) : rawContent;
      if (!content) return;
      // 更新章节 + 显示内容（严格同步）
      setCurrentChapter(nextCh);
      setDisplayChapter(nextCh);
      currentChapterRef.current = nextCh;
      accumulatedIdsRef.current.clear();
      accumulatedIdsRef.current.add(nextCh.id);
      setTxtContent(content);
      if (book?.format === 'epub') {
        setEpubDisplayHtml(sanitizeEpubHtml(rawContent, triggerBookId!));
      }
      // 重置滚动位置
      if (txtScrollRef.current) txtScrollRef.current.scrollTop = 0;
      // 加载下一章文本到播放器（优先使用预取缓存，后台跨章无需等待 TTS API）
      const loadedFromPrefetch = await player.loadFromPrefetched();
      if (!loadedFromPrefetch) {
        // 无预取数据时回退到标准加载（初次启动或极快切换场景）
        await player.load(content, false);
      }
      setActiveSegmentIndex(0);
      setTtsProgress(0);
      // 重置进度保存定时器（新的 chapterId）
      startTtsProgressSaver(triggerBookId!, nextCh.id, nextCh.title || '', player);
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

  /** 保存 TTS 播放进度（全书百分比） */
  const saveTtsProgress = useCallback((chapterId: string, segmentIndex: number, _chapterPct: number) => {
    // 转换为全书百分比：(当前章节索引 + 章节内进度) / 总章节数
    const cIdx = chapters.findIndex(c => c.id === chapterId);
    const total = chapters.length;
    const bookPct = cIdx >= 0 && total > 0
      ? (cIdx + _chapterPct) / total
      : _chapterPct;
    // ⭐ 同时保存当前的滚动位置 pageIndex，避免 TTS 进度覆盖后 scroll 恢复丢失
    const container = txtScrollRef.current;
    let pageIndex: number | undefined;
    if (container && container.scrollHeight > container.clientHeight) {
      pageIndex = Math.round((container.scrollTop / (container.scrollHeight - container.clientHeight)) * 10000);
    }
    debounceSaveProgress({
      chapterId,
      textOffset: segmentIndex,
      percentage: bookPct,
      ...(pageIndex !== undefined ? { pageIndex } : {}),
    });
  }, [debounceSaveProgress, chapters]);

  /** 启动 TTS 进度定期保存（同时持久化到 localStorage，支持页面刷新恢复） */
  const startTtsProgressSaver = useCallback((bookId: string, chapterId: string, chapterTitle: string, player: any) => {
    if (ttsProgressSaveTimer.current) clearInterval(ttsProgressSaveTimer.current);
    ttsProgressSaveTimer.current = setInterval(() => {
      const idx = player.getCurrentIndex();
      const total = player.getTotalChunks();
      if (idx >= 0 && total > 0) {
        // 章节内 chunk 进度 (0~1)
        const chapterPct = (idx + 1) / total;
        saveTtsProgress(chapterId, idx, chapterPct);
        // ⭐ 同步持久化到 localStorage，页面刷新后可自动检测并弹出恢复横幅
        savePlaybackToLocalStorage({
          bookId,
          chapterId,
          segmentIndex: idx,
          bookTitle: book?.title,
          chapterTitle,
          timestamp: Date.now(),
        });
      }
    }, TTS_PROGRESS_SAVE_INTERVAL);
  }, [saveTtsProgress, book]);

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
        if (err.includes('合成失败') || err.includes('无可用音频')) {
          return;
        }
        let userMsg = err;
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
        if (ttsProgressSaveTimer.current) {
          clearInterval(ttsProgressSaveTimer.current);
          ttsProgressSaveTimer.current = null;
        }
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

    // ⭐ 重启进度保存定时器（当前组件实例的上下文）
    startTtsProgressSaver(bookId, currentChapter.id, currentChapter?.title || '', player);
  }, [bookId, currentChapter, loading, chapters, preloadNextChapters, startTtsProgressSaver, navigateToChapter]);

  const handleStartTTS = useCallback(async () => {
    if (!bookId || !currentChapter) return;

    // ⭐ 记录触发时的书籍 ID，异步获取文本后校验
    const triggerBookId = bookId;
    const text = await getCurrentChapterText();
    if (!text) return;

    // ⭐ 书籍切换守卫：异步获取文本期间用户可能已切换书籍
    if (currentBookIdRef.current !== triggerBookId) return;

    try {
      const player = getDefaultPlayer();
      ttsPlayerRef.current = player;

      // ⭐ 问题1：检测当前播放器状态，处理暂停/切换
      const currentState = player.getState();
      const isPlaying = currentState === 'playing' || currentState === 'paused' || currentState === 'loading';
      if (isPlaying && player.currentBookId === bookId) {
        // ✅ 同一本书正在播放 → 暂停（toggle）
        player.pause();
        return;
      }
      if (isPlaying && player.currentBookId && player.currentBookId !== bookId) {
        // ✅ 不同书在播放 → 保存旧书位置，切换到新书
        // 保存旧书最后播放位置到 localStorage（供后续恢复横幅使用）
        const oldIdx = player.getCurrentIndex();
        const oldTotal = player.getTotalChunks();
        if (oldIdx >= 0 && oldTotal > 0) {
          savePlaybackToLocalStorage({
            bookId: player.currentBookId,
            chapterId: (player as any).chapterId || '',
            segmentIndex: oldIdx,
            bookTitle: (player as any).bookTitle,
            chapterTitle: player.chapterTitle || '',
            timestamp: Date.now(),
          });
        }
        player.stop();
      }

      // 设置当前播放的书籍信息（供全局状态订阅 + localStorage 持久化使用）
      player.chapterTitle = currentChapter?.title || '';
      player.chapterId = currentChapter?.id || '';
      (player as any).bookTitle = book?.title || '';

      // ⭐ 设置音色 — 优先从 localStorage 读取（用户显式保存的），
      // 其次是 player.init() 已从后端加载的值，最后才是 state 默认值
      const savedVoice = (() => {
        try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
      })();
      const effectiveVoice = savedVoice || player.getVoice() || ttsVoice;
      player.setVoice(effectiveVoice);
      if (effectiveVoice !== ttsVoice) setTtsVoice(effectiveVoice);

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
        onSegmentPlay: (idx, _total) => {
          setTtsSegmentText(player.getCurrentSegmentText());
          // ⭐ 严格单章模式：idx 直接对应当前章节的分段索引
          setActiveSegmentIndex(idx);

          // ⭐ 自动滚动到当前高亮分段
          requestAnimationFrame(() => {
            const container = txtScrollRef.current;
            if (!container) return;
            const highlighted = container.querySelector('[data-tts-segment="active"]');
            if (highlighted) {
              highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });

          // ⭐ 播放到 75% 时预加载下一章内容（仅内容预加载，不追加到播放器）+ 预取下章 TTS 音频
          if (_total > 0 && idx >= _total * 0.75) {
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
          if (err.includes('合成失败') || err.includes('无可用音频')) {
            return;
          }
          let userMsg = err;
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
          if (ttsProgressSaveTimer.current) {
            clearInterval(ttsProgressSaveTimer.current);
            ttsProgressSaveTimer.current = null;
          }
          if (sleepTimerIntervalRef.current) {
            clearInterval(sleepTimerIntervalRef.current);
            sleepTimerIntervalRef.current = null;
          }
          // ⭐ 单章播放完毕 → 自动加载下一章并继续播放（严格同步）
          advanceToNextChapterTTSRef.current?.(player);
        },
        // ⭐ 锁屏/通知栏上下章控制
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

      // ⭐ 从 localStorage 读取语音设置（仅在确认有显式保存的值时更新）
      const savedVoiceLs = (() => {
        try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
      })();
      const savedSpeedLs = (() => {
        try {
          const raw = localStorage.getItem('ireader_tts_speed');
          return raw ? parseFloat(raw) : null;
        } catch { return null; }
      })();
      if (savedVoiceLs) {
        setTtsVoice(savedVoiceLs);
        player.setVoice(savedVoiceLs);
      }
      if (savedSpeedLs && savedSpeedLs !== ttsSpeed) {
        setTtsSpeed(savedSpeedLs);
        player.setSpeed(savedSpeedLs);
      }
      // ⭐ 从 localStorage 读取"实时合成模式"开关（设置页可配置）
      const noCachePref = (() => {
        try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; }
      })();

      // ⭐ 如果播放器已预热初始化（audio 元素已存在），跳过完整 init，仅更新选项
      if (player['audioElement']) {
        // 优先使用 localStorage 中用户保存的值
        const savedVoiceLs2 = (() => {
          try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
        })();
        const savedSpeedLs2 = (() => {
          try {
            const raw = localStorage.getItem('ireader_tts_speed');
            return raw ? parseFloat(raw) : null;
          } catch { return null; }
        })();
        const useVoice = savedVoiceLs2 || player.getVoice() || ttsVoice;
        const useSpeed = savedSpeedLs2 || ttsSpeed;
        player.setVoice(useVoice);
        player.setSpeed(useSpeed);
        player['currentBookId'] = bookId;
        player['bookTitle'] = book?.title || '';
        player['bookCoverUrl'] = book ? `/api/books/${bookId}/cover` : '';
        if (player['audioElement']) {
          player['audioElement'].playbackRate = useSpeed;
        }
      } else {
        const savedVoiceLs3 = (() => {
          try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
        })();
        const savedSpeedLs3 = (() => {
          try {
            const raw = localStorage.getItem('ireader_tts_speed');
            return raw ? parseFloat(raw) : null;
          } catch { return null; }
        })();
        await player.init({
          speed: savedSpeedLs3 || ttsSpeed,
          voice: savedVoiceLs3 || ttsVoice,
          noCache: noCachePref,
          bookId,
          bookTitle: book?.title || '',
          bookCoverUrl: book ? `/api/books/${bookId}/cover` : '',
        });
      }
      player.setVolume(ttsVolume);

      // 文本已是纯文本（EPUB 已由 getCurrentChapterText 返回 txtContent，非原始 HTML）
      await player.load(text, false);

      // Start periodic TTS progress saving (also persists to localStorage)
      startTtsProgressSaver(bookId, currentChapter.id, currentChapter?.title || '', player);

      // ⭐ 从第0段开始播放（停止后再次播放不跳转到旧位置）
      await player.play();
    } catch (err) {
      console.error('TTS 启动失败:', err);
      setTtsError('语音播放启动失败：TTS 后端服务不可用（默认 Kokoro :8880 未运行），请在设置中切换到 Edge-TTS 或启动 Kokoro 服务');
      setTimeout(() => setTtsError(null), 10000);
    }
  }, [bookId, currentChapter, book, ttsSpeed, getCurrentChapterText, saveTtsProgress, startTtsProgressSaver, preloadNextChapters, chapters, navigateToChapter]);

  /** 上一章切换（用于播放器控制） */
  const handlePrevChapter = useCallback(async () => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx <= 0) return;
    // 如果正在播放，先停止
    const player = ttsPlayerRef.current;
    if (player && player.getState() !== 'idle') {
      player.stop();
      setTtsState('idle');
      setTtsProgress(0);
      setActiveSegmentIndex(-1);
      setTtsSegmentText('');
    }
    await goToPrevChapter();
    // 自动播放上一章
    setTimeout(() => handleStartTTS(), 100);
  }, [currentChapter, chapters, goToPrevChapter, handleStartTTS]);

  /** 下一章切换（用于播放器控制） */
  const handleNextChapter = useCallback(async () => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx < 0 || idx >= chapters.length - 1) return;
    // 如果正在播放，先停止
    const player = ttsPlayerRef.current;
    if (player && player.getState() !== 'idle') {
      player.stop();
      setTtsState('idle');
      setTtsProgress(0);
      setActiveSegmentIndex(-1);
      setTtsSegmentText('');
    }
    await goToNextChapter();
    // 自动播放下一章
    setTimeout(() => handleStartTTS(), 100);
  }, [currentChapter, chapters, goToNextChapter, handleStartTTS]);

  /** 暂停 TTS */
  const handlePauseTTS = useCallback(() => {
    ttsPlayerRef.current?.pause();
  }, []);

  /** 恢复 TTS */
  const handleResumeTTS = useCallback(() => {
    ttsPlayerRef.current?.resume();
  }, []);


  const handleStopTTS = useCallback(() => {
    // ⭐ 停止时不清除播放器内部进度（避免影响暂停/恢复），
    //    但清除内存中的已保存进度 ref，使下次播放不从旧位置续播
    savedTtsProgressRef.current = null;
    // ⭐ 清除 localStorage 播放持久化记录（用户主动停止，不再需要恢复）
    try {
      localStorage.removeItem('ireader_last_playback');
    } catch { /* 静默 */ }
    if (ttsProgressSaveTimer.current) {
      clearInterval(ttsProgressSaveTimer.current);
      ttsProgressSaveTimer.current = null;
    }
    // 清除睡眠计时器
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
    setSleepTimerMinutes(null);
    sleepTimerEndRef.current = null;
    ttsPlayerRef.current?.stop();
    setTtsState('idle');
    setTtsProgress(0);
    setTtsSegmentText('');
    setActiveSegmentIndex(-1);
  }, []);

  /** 拖动 TTS 进度条 seek */
  const handleTTSSeek = useCallback(async (progress: number) => {
    const player = ttsPlayerRef.current;
    if (!player || player.getState() === 'idle') return;
    const wasPlaying = player.getState() === 'playing';
    if (wasPlaying) player.pause();
    try {
      await player.seekTo(progress);
      const idx = player.getCurrentIndex() + 1;
      const total = player.getTotalChunks();
      setTtsProgress(total > 0 ? (idx + 1) / total : 0);
      setTtsSegmentText(player.getCurrentSegmentText());
      if (wasPlaying) await player.play();
    } catch {
      // seek 失败不阻塞
    }
  }, []);

  /** 设置睡眠计时器 */
  const handleSetSleepTimer = useCallback((minutes: number | null) => {
    setSleepTimerMinutes(minutes);
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
    if (minutes === null) {
      sleepTimerEndRef.current = null;
      return;
    }
    const endAt = Date.now() + minutes * 60 * 1000;
    sleepTimerEndRef.current = endAt;
    // 每秒检查一次是否到期
    sleepTimerIntervalRef.current = setInterval(() => {
      if (sleepTimerEndRef.current && Date.now() >= sleepTimerEndRef.current) {
        // 计时到期，停止 TTS
        if (sleepTimerIntervalRef.current) {
          clearInterval(sleepTimerIntervalRef.current);
          sleepTimerIntervalRef.current = null;
        }
        handleStopTTS();
      }
    }, 1000);
  }, [handleStopTTS]);

  /** 渲染带 TTS 高亮的文本内容 */
  const renderHighlightedContent = useCallback((content: string): React.ReactNode => {
    if (ttsState === 'idle' || activeSegmentIndex < 0 || !content) {
      return content;
    }
    const segments = splitText(content);
    if (activeSegmentIndex >= segments.length) return content;

    const target = segments[activeSegmentIndex];
    if (!target) return content;

    // 按分段顺序找到当前段落在原始内容中的位置（处理重复文本）
    let searchPos = 0;
    let foundPos = -1;
    for (let i = 0; i <= activeSegmentIndex && i < segments.length; i++) {
      const seg = segments[i];
      const pos = content.indexOf(seg, searchPos);
      if (pos === -1) break;
      foundPos = pos;
      searchPos = pos + seg.length;
    }
    if (foundPos === -1) return content;

    return (
      <>
        {content.slice(0, foundPos)}
        <span
          data-tts-segment="active"
          className="bg-yellow-200 dark:bg-yellow-700/70 rounded px-0.5 transition-colors duration-300"
          aria-live="polite"
        >
          {target}
        </span>
        {content.slice(foundPos + target.length)}
      </>
    );
  }, [ttsState, activeSegmentIndex]);

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

  /** 根据 pageIndex 获取分页后的 TXT 内容 */

  // ── 滚动进度保存：跟踪用户滚动位置，定期保存阅读进度 ──
  const scrollProgressSaveTimer = useRef<any>(null);
  const handleScrollProgress = useCallback(() => {
    if (!currentChapter || !chapters.length) return;
    if (scrollProgressSaveTimer.current) clearTimeout(scrollProgressSaveTimer.current);
    scrollProgressSaveTimer.current = setTimeout(() => {
      const container = txtScrollRef.current;
      const scrollPct = container && container.scrollHeight > container.clientHeight
        ? container.scrollTop / (container.scrollHeight - container.clientHeight)
        : 0;
      const idx = chapters.findIndex(c => c.id === currentChapter.id);
      debounceSaveProgress({
        chapterId: currentChapter.id,
        percentage: (idx + 1) / chapters.length,
        pageIndex: Math.round(scrollPct * 10000),
      });
    }, 2000);
  }, [currentChapter, chapters, debounceSaveProgress]);

  // 监听 TXT 滚动容器的滚动事件
  useEffect(() => {
    if (readingMode !== 'scroll') return;
    const container = txtScrollRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScrollProgress, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScrollProgress);
      if (scrollProgressSaveTimer.current) clearTimeout(scrollProgressSaveTimer.current);
    };
  }, [readingMode, txtContent, currentChapter, handleScrollProgress]);

  // ⭐ 在 TXT 内容渲染完成后恢复滚动位置（修复 requestAnimationFrame 时机不对的问题）
  useEffect(() => {
    if (pendingScrollRestorePct == null) return;
    // 使用 requestAnimationFrame 确保一次重绘后再恢复
    const raf = requestAnimationFrame(() => {
      const container = txtScrollRef.current;
      if (container && pendingScrollRestorePct > 0) {
        container.scrollTop = pendingScrollRestorePct * (container.scrollHeight - container.clientHeight);
      }
      setPendingScrollRestorePct(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [txtContent, pendingScrollRestorePct]);

  // 分页模式：内容/字号/行距变化时轻量重排（不重新 fetch，仅按比例恢复 scrollLeft）
  useEffect(() => {
    if (readingMode !== 'paginated') {
      setTotalPages(1);
      return;
    }
    const el = paginatedScrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const pw = el.clientWidth || 1;
      const total = Math.max(1, Math.ceil(el.scrollWidth / pw));
      setTotalPages(total);
      const ratio = charOffsetRatioRef.current ?? 0;
      el.scrollLeft = ratio * Math.max(0, el.scrollWidth - pw);
      setPageIndex(Math.round(ratio * (total - 1)));
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epubDisplayHtml, txtContent, book?.format, readingMode, fontSize, lineHeight]);

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
      if (ttsProgressSaveTimer.current) {
        clearInterval(ttsProgressSaveTimer.current);
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
            <button
              onClick={() => { setError(null); loadBook(); }}
              className="px-4 py-2 rounded-lg font-medium" style={{background: 'var(--color-primary)', color: 'white'}}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen select-none" style={{background: 'var(--color-bg)'}}>
      <div className="h-full relative">
        {/* ── 浮动章节导航按钮（半透明大按钮，屏幕左右中部） ── */}
        <button
          onClick={(e) => { e.stopPropagation(); goToPrevChapter(); }}
          disabled={!currentChapter || chapters.findIndex(c => c.id === currentChapter.id) === 0}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-30 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/20 hover:bg-black/30 dark:bg-white/20 dark:hover:bg-white/30 backdrop-blur-sm text-white text-xl flex items-center justify-center disabled:opacity-0 disabled:pointer-events-none transition-all duration-200 active:scale-90"
          title="上一章"
        >
          ‹
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); goToNextChapter(); }}
          disabled={!currentChapter || chapters.findIndex(c => c.id === currentChapter.id) === chapters.length - 1}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-30 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/20 hover:bg-black/30 dark:bg-white/20 dark:hover:bg-white/30 backdrop-blur-sm text-white text-xl flex items-center justify-center disabled:opacity-0 disabled:pointer-events-none transition-all duration-200 active:scale-90"
          title="下一章"
        >
          ›
        </button>
        {/* Reader Content - full screen, no fixed toolbar */}
        <div className="h-full flex flex-col">
          <div
            className="flex-1 flex overflow-hidden relative"
            onClick={handleTapReader}
            onTouchStart={(e) => { handleSwipeStart(e.touches[0].clientX, e.touches[0].clientY); }}
            onTouchEnd={(e) => { handleSwipeEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }}
            onMouseDown={(e) => { handleSwipeStart(e.clientX, e.clientY); }}
            onMouseUp={(e) => { handleSwipeEnd(e.clientX, e.clientY); }}
          >
        {/* TOC Sidebar */}
        {showToc && (
          <div onClick={(e) => e.stopPropagation()} className="w-64 sm:w-72 overflow-y-auto absolute sm:relative z-20 inset-y-0 left-0 shadow-lg sm:shadow-none" style={{background: 'var(--color-bg-card)', borderRight: '0.5px solid var(--color-border)'}}>
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
            {chapters.map((ch) => (
              <button
                key={ch.id}
                onClick={() => navigateToChapter(ch)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-200 dark:hover:bg-gray-700 truncate ${
                  currentChapter?.id === ch.id
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-medium'
                    : 'text-gray-700 dark:text-gray-300'
                }`}
              >
                {ch.title}
              </button>
            ))}
          </div>
        )}


        {/* EPUB 不再使用 epubjs 视图，统一用 text+CSS column 模式渲染 */}

        {/* EPUB Text View */}
        {book?.format === 'epub' && (
          <div
            ref={(el) => {
              (pageContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }}
            className={`px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto reading-container ${
              readingMode === 'scroll' ? 'flex-1 overflow-y-auto' : 'flex-1 overflow-hidden flex flex-col'
            }`}
            data-l-spacing={letterSpacing}
            style={readingMode === 'paginated' ? { touchAction: 'none', overscrollBehavior: 'none' } : undefined}
          >
            <div
              style={{
                color: 'var(--color-text)',
                fontSize: `${fontSize}px`,
                fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
                letterSpacing: `${letterSpacing}em`,
                ...(readingMode === 'paginated' ? { flex: 1, minHeight: 0, overflow: 'hidden' } : {}),
              }}
            >
              {chapterLoading ? (
                <div className="flex items-center justify-center py-12">
                  <span className="animate-pulse" style={{ color: 'var(--color-text-muted)' }}>加载中...</span>
                </div>
              ) : readingMode === 'paginated' ? (
                <div
                  ref={paginatedScrollRef}
                  className="paginated-scroll"
                  style={{
                    height: '100%',
                    overflowX: 'auto',
                    overflowY: 'hidden',
                    columnFill: 'auto',
                    columnCount: 1,
                    columnGap: '2rem',
                    fontSize: `${fontSize}px`,
                    fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                    lineHeight,
                    letterSpacing: `${letterSpacing}em`,
                    padding: '0 1.5rem',
                    scrollBehavior: 'smooth',
                  }}
                />
              ) : epubDisplayHtml ? (
                <div className="epub-content" dangerouslySetInnerHTML={{ __html: epubDisplayHtml }} />
              ) : txtContent ? (
                ttsState !== 'idle' && activeSegmentIndex >= 0 ? (
                  <div className="whitespace-pre-line">
                    {renderHighlightedContent(txtContent)}
                  </div>
                ) : (
                  <div className="whitespace-pre-line">{txtContent}</div>
                )
              ) : (
                <div className="flex items-center justify-center py-12">
                  <span style={{ color: 'var(--color-text-muted)' }}>暂无内容</span>
                </div>
              )}
            </div>
            <div ref={bottomSentinelRef} className="h-4" />
            <div className="mt-4 pt-3 flex items-center justify-between text-sm"
              style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const idx = chapters.findIndex((c) => c.id === (currentChapter?.id || ''));
                  if (idx > 0) navigateToChapter(chapters[idx - 1]);
                }}
                disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter.id) === 0}
                className="px-3 py-1 rounded-lg transition-all duration-150 tap-active disabled:opacity-40"
                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一章
              </button>
              <span className="text-xs" style={{color: 'var(--color-text-muted)'}}>
                {currentChapter
                  ? readingMode === 'paginated'
                    ? `${pageIndex + 1} / ${totalPages}`
                    : `${chapters.findIndex((c) => c.id === currentChapter.id) + 1} / ${chapters.length}`
                  : ''}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goToNextChapter();
                }}
                disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter.id) === chapters.length - 1}
                className="px-3 py-1 rounded-lg transition-all duration-150 tap-active disabled:opacity-40"
                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              >
                下一章 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
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

        {/* TXT Reader */}
        {book?.format === 'txt' && (
          <div
            ref={(el) => {
              (txtScrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
              (pageContainerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
            }}
            className={`flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto ${readingMode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}
            data-l-spacing={letterSpacing}
            style={readingMode === 'paginated' ? { touchAction: 'none', overscrollBehavior: 'none' } : undefined}
          >
            {(displayChapter || currentChapter) && (
              <div className="mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">
                  {(displayChapter || currentChapter)!.title}
                </h2>
              </div>
            )}
            {/* ── 翻页动画已集成到 column 容器（CSS multi-column + scroll-behavior smooth） ── */}
            <div
              ref={txtPageRef}
              className={`text-gray-800 dark:text-gray-200 whitespace-pre-wrap ${
                readingMode === 'paginated' ? 'flex-1 overflow-hidden' : ''
              }`}
              style={{
                fontSize: `${fontSize}px`,
                fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
                letterSpacing: `${letterSpacing}em`,
                ...(readingMode === 'paginated' ? { touchAction: 'none', overscrollBehavior: 'none' } : {}),
              }}
            >
              {chapterLoading ? (
                <div className="flex items-center justify-center py-12">
                  <span className="text-gray-400 animate-pulse">加载中...</span>
                </div>
              ) : (
                readingMode === 'paginated'
                  ? (
                    <div
                      ref={paginatedScrollRef}
                      className="paginated-scroll"
                      style={{
                        height: '100%',
                        overflowX: 'auto',
                        overflowY: 'hidden',
                        columnFill: 'auto',
                        columnCount: 1,
                        columnGap: '2rem',
                        fontSize: `${fontSize}px`,
                        fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                        lineHeight,
                        letterSpacing: `${letterSpacing}em`,
                        padding: '0 1.5rem',
                        scrollBehavior: 'smooth',
                      }}
                    />
                  )
                  : ttsState !== 'idle' && activeSegmentIndex >= 0
                    ? renderHighlightedContent(txtContent)
                    : txtContent
              )}
            </div>
            {/* 底部哨兵元素：用于 IntersectionObserver 检测滚动到末尾 */}
            <div ref={bottomSentinelRef} className="h-4" />
          </div>
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

        {/* ⏫ 悬浮操作面板：默认隐藏，点击阅读区显示 */}
        {showUi && (
          <div className="absolute inset-0 z-30 flex flex-col" onClick={() => setShowUi(false)}>
            {/* 半透明背景点击关闭 */}
            <div className="absolute inset-0 bg-black/30" onClick={() => setShowUi(false)} />

            <div className="flex-1 relative z-10" onClick={() => setShowUi(false)} />

            {/* 底部控制面板 — 阻止点击冒泡到外层遮罩，避免非关闭按钮意外关闭面板 */}
            <div className="relative z-10 pointer-events-none">
              <div className="pointer-events-auto glass-bar rounded-2xl shadow-2xl mx-auto max-w-3xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
                  <div className="p-5 space-y-4">
                    {/* ── 第一行：返回 + 搜索 + 书名 + 目录 ── */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => navigate('/')}
                          className="flex items-center gap-1.5 text-base rounded-full px-4 py-2 transition-all duration-200 tap-active"
                        style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}
                        >
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="15 18 9 12 15 6"/></svg> 返回
                        </button>
                        {/* 🔍 搜索 — 在返回按钮之后 */}
                        <button
                          onClick={() => { setShowSearch(true); setShowUi(false); setTimeout(() => searchInputRef.current?.focus(), 100); }}
                          className="w-9 h-9 rounded-full flex items-center justify-center"
                          style={{ background: 'var(--color-bg-alt)' }}
                          title="搜索"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                        </button>
                      </div>
                      <h2 className="text-base font-medium truncate max-w-[45%] text-center"
                        style={{ color: 'var(--color-text-secondary)' }}>
                        {(displayChapter || currentChapter)?.title || book?.title || ''}
                      </h2>
                      <button
                        onClick={() => { setShowToc(v => !v); setShowUi(false); }}
                        className={`text-sm px-4 py-2 rounded-full font-medium transition-all duration-200 tap-active`}
                        style={{
                          background: showToc ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                          color: showToc ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                        }}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        目录
                      </button>
                    </div>

                    {/* ── 播放栏（上一章/播放暂停/下一章/停止 + 定时按钮靠右） ── */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          {/* ⏮ 上一章 */}
                          <button onClick={handlePrevChapter} className="w-9 h-9 rounded-full flex items-center justify-center" style={{background: 'var(--color-bg-alt)'}} title="上一章">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                          </button>
                          {/* ▶/⏸ 播放/暂停 */}
                          {ttsState === 'playing' ? (
                            <button onClick={handlePauseTTS} className="w-11 h-11 rounded-full flex items-center justify-center" style={{background: 'var(--color-primary)'}} title="暂停">
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                            </button>
                          ) : (
                            <button onClick={ttsState === 'paused' ? handleResumeTTS : handleStartTTS} className="w-11 h-11 rounded-full flex items-center justify-center" style={{background: 'var(--color-primary)'}} title={ttsState === 'paused' ? '继续' : '播放'}>
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            </button>
                          )}
                          {/* ⏭ 下一章 */}
                          <button onClick={handleNextChapter} className="w-9 h-9 rounded-full flex items-center justify-center" style={{background: 'var(--color-bg-alt)'}} title="下一章">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                          </button>
                          {/* ⏹ 停止 — 清理进度，下次播放从当前页开始 */}
                          <button onClick={handleStopTTS} className="w-9 h-9 rounded-full flex items-center justify-center" style={{background: 'var(--color-bg-alt)'}} title="停止">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                          </button>
                        </div>
                        {/* 定时按钮 — 靠右 */}
                        <button
                          onClick={() => {
                            const opts: (number | null)[] = [null, 15, 30, 60];
                            const idx = opts.indexOf(sleepTimerMinutes);
                            const next = opts[(idx + 1) % opts.length];
                            handleSetSleepTimer(next);
                          }}
                          className={`text-sm px-3 py-1.5 rounded-lg transition-all duration-200 tap-active`}
                          style={{
                            background: sleepTimerMinutes ? 'var(--color-accent-2-subtle)' : 'var(--color-bg-alt)',
                            color: sleepTimerMinutes ? 'var(--color-accent-2)' : 'var(--color-text-secondary)',
                          }}
                        >
                          {sleepTimerMinutes ? <span className="inline-flex items-center gap-1"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>{sleepTimerMinutes}分</span> : <span className="inline-flex items-center gap-1"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>定时</span>}
                        </button>
                      </div>
                      <div
                        ref={progressBarRef}
                        className="rounded-full h-3 cursor-pointer relative group"
                        style={{ background: 'var(--color-border)' }}
                        onMouseDown={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                          isDraggingRef.current = true;
                          handleTTSSeek(pct);
                        }}
                      >
                        <div
                          className="h-full rounded-full transition-none"
                          style={{ width: `${Math.round(ttsProgress * 100)}%`, background: 'var(--color-primary)' }}
                        />
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `calc(${Math.round(ttsProgress * 100)}% - 8px)` }}
                        />
                      </div>

                    </div>

                    <div style={{ borderTop: '0.5px solid var(--color-border)' }} />

                    {/* ── 阅读设置（字号/行距）紧凑 2列 ── */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      {/* 字号 */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>字号</span>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setFontSize(Math.max(12, fontSize - 2))}
                            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all tap-icon"
                            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A−</button>
                          <span className="text-sm w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
                          <button onClick={() => setFontSize(Math.min(36, fontSize + 2))}
                            className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium transition-all tap-icon"
                            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>A+</button>
                        </div>
                      </div>
                      {/* 行距 */}
                      <div className="flex items-center justify-between">
                        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>行距</span>
                        <div className="flex items-center gap-1.5">
                          <button onClick={() => setLineHeight(Math.max(1.2, lineHeight - 0.2))} disabled={lineHeight <= 1.2}
                            className="w-10 h-10 rounded-full flex items-center justify-center text-sm disabled:opacity-40 transition-colors"
                            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>−</button>
                          <span className="text-sm w-8 text-center" style={{ color: 'var(--color-text-muted)' }}>{lineHeight.toFixed(1)}</span>
                          <button onClick={() => setLineHeight(Math.min(3.0, lineHeight + 0.2))} disabled={lineHeight >= 3.0}
                            className="w-10 h-10 rounded-full flex items-center justify-center text-sm disabled:opacity-40 transition-colors"
                            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>+</button>
                        </div>
                      </div>
                      </div>

                    {/* ── 样式（字体 + 阅读模式）─与上方网格共享间距，不额外加分隔线 ── */}
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>样式</span>
                      <div className="flex items-center gap-2">
                        <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value as 'sans' | 'serif' | 'mono')}
                          className="text-sm px-3 py-1.5 rounded-lg border-none cursor-pointer outline-none"
                          style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}>
                          <option value="sans">无衬线</option>
                          <option value="serif">衬线</option>
                          <option value="mono">等宽</option>
                        </select>
                        <button onClick={async () => {
                          const goingToPaginated = readingMode === 'scroll';
                          if (goingToPaginated) {
                            // 切换前：把当前 scroll 模式位置比例保存下来，切到翻页后从相同位置恢复（不跳回开头）
                            const scrollEl = txtPageRef.current;
                            if (scrollEl && scrollEl.scrollHeight > 0) {
                              charOffsetRatioRef.current = Math.min(1, Math.max(0, scrollEl.scrollTop / scrollEl.scrollHeight));
                            }
                            setReadingMode('paginated');
                            if (currentChapter) await rebuildPaginatedContent(currentChapter);
                          } else {
                            setReadingMode('scroll');
                          }
                        }}
                          className={`text-sm px-3 py-1.5 rounded-lg font-medium transition-all duration-200 tap-active`}
                          style={{
                            background: readingMode === 'paginated' ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                            color: readingMode === 'paginated' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                          }}>
                          {readingMode === 'paginated' ? <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 翻页</> : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> 滚动</>}
                        </button>
                      </div>
                    </div>




                  {/* ── 底部导航（仅保留章节进度信息，导航按钮移至浮动） ── */}
                  <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
                    <div className="flex items-center justify-center">
                      <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
                        {currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1} / ${chapters.length}` : ''}
                      </span>
                    </div>
                     {book?.format && readingMode === 'paginated' && (
                       <div className="flex items-center justify-between mt-1">
                          {book?.format === 'txt' || book?.format === 'epub' ? (
                            <>
                              <button
                                onClick={() => performPageTurn('prev')}
                                disabled={pageIndex === 0 && chapters.findIndex(c => c.id === currentChapter?.id) === 0}
                                className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                              ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一页</button>
                              <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{pageIndex + 1} / {totalPages}</span>
                              <button
                                onClick={() => performPageTurn('next')}
                                disabled={pageIndex >= totalPages - 1 && chapters.findIndex(c => c.id === currentChapter?.id) === chapters.length - 1}
                                className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                                style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                              >下一页 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg></button>
                            </>
                          ) : (
                           <>
                             <button
                               onClick={() => performPageTurn('prev')}
                               disabled={chapters.findIndex(c => c.id === currentChapter?.id) === 0}
                               className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                               style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                             ><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一章</button>
                             <span className="text-sm" style={{ color: 'var(--color-text-muted)' }}>{currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1} / ${chapters.length}` : ''}</span>
                             <button
                               onClick={() => performPageTurn('next')}
                               disabled={chapters.findIndex(c => c.id === currentChapter?.id) === chapters.length - 1}
                               className="text-sm px-4 py-2 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                               style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                             >下一章 <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg></button>
                           </>
                         )}
                       </div>
                     )}
                  </div>

                  {/* ── 缓存管理 ── */}
                  <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
                    <div className="flex items-center justify-center gap-3">
                      <button
                        onClick={handleCacheCurrentChapter}
                        disabled={cachingInProgress}
                        className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-200 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                        title="缓存本章"
                      >
                        <span className="flex flex-col items-center gap-0.5">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          <span>本章</span>
                        </span>
                      </button>
                      <button
                        onClick={handleCacheFullBook}
                        disabled={cachingInProgress}
                        className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-200 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                        title="缓存全书"
                      >
                        <span className="flex flex-col items-center gap-0.5">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
                          <span>全书</span>
                        </span>
                      </button>
                      <button
                        onClick={handleClearTextCache}
                        className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-150 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                        title="清除文字缓存"
                      >
                        <span className="flex flex-col items-center gap-0.5">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                          <span>文字</span>
                        </span>
                      </button>
                      {(cacheStatus?.audioChapterCount ?? 0) > 0 && (
                        <button
                          onClick={handleClearAudioCache}
                          className="w-12 h-12 rounded-full flex items-center justify-center text-[10px] transition-all duration-150 tap-active"
                          style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                          title="清除语音缓存"
                        >
                          <span className="flex flex-col items-center gap-0.5">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            <span>语音</span>
                          </span>
                        </button>
                      )}
                    </div>
                    {cachingInProgress && cacheProgressText && (
                      <div className="flex items-center justify-center text-xs pt-1" style={{ color: 'var(--color-accent)' }}>
                        {cacheProgressText}
                      </div>
                    )}
                    {cacheStatus && cacheStatus.chapterCount > 0 && (
                      <div className="flex items-center justify-center gap-3 text-xs pt-1 flex-wrap" style={{ color: 'var(--color-text-muted)' }}>
                        <span title="已缓存章节" style={{ color: 'var(--color-accent-2)' }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> {cacheStatus.chapterCount}/{cacheStatus.totalChapters}章
                        </span>
                        {cacheStatus.audioChapterCount > 0 && (
                          <span title="已缓存语音章节">
                            🎙 {cacheStatus.audioChapterCount}/{cacheStatus.totalChapters}章
                          </span>
                        )}
                        <span>{formatBytes(cacheStatus.totalBytes)}{cacheStatus.audioChapterCount > 0 ? `（文字 ${formatBytes(cacheStatus.chapterBytes)} / 语音 ${formatBytes(cacheStatus.audioBytes)}）` : ''}</span>
                      </div>
                    )}
                  </div>


                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Reader Top Bar Component ──
function ReaderTopBar({
  title,
  onBack,
  onToggleToc,
  fontSize,
  onFontSizeChange,
  fontFamily,
  onFontFamilyChange,
  lineHeight,
  onLineHeightChange,
  readingMode,
  onToggleReadingMode,
  ttsState,
  ttsActive,
  onStartTTS,
  onStopTTS,
  cacheStatus,
  cachingInProgress,
  onCacheChapter,
  onCacheFullBook,
  onClearCache,
}: {
  title: string;
  onBack: () => void;
  onToggleToc?: () => void;
  fontSize?: number;
  onFontSizeChange?: (s: number) => void;
  fontFamily?: 'sans' | 'serif' | 'mono';
  onFontFamilyChange?: (f: 'sans' | 'serif' | 'mono') => void;
  lineHeight?: number;
  onLineHeightChange?: (lh: number) => void;
  readingMode: 'scroll' | 'paginated';
  onToggleReadingMode: () => void;
  ttsState?: PlayerState;
  ttsActive?: boolean;
  onStartTTS?: () => void;
  onStopTTS?: () => void;
  bookFormat?: 'epub' | 'txt';
  showEpubView?: boolean;
  onToggleEpubView?: () => void;
  // 离线缓存
  cacheStatus?: { chapterCount: number; totalChapters: number; hasAudio: boolean } | null;
  cachingInProgress?: boolean;
  onCacheChapter?: () => void;
  onCacheFullBook?: () => void;
  onClearCache?: () => void;
}) {

  return (
    <div className="glass flex items-center justify-between px-2 sm:px-4 py-1 sm:py-2 overflow-x-auto scrollbar-hide"
      style={{ borderBottom: '0.5px solid var(--color-border)' }}>
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-sm tap-active px-2 py-1 rounded-lg transition-all duration-200"
          style={{ color: 'var(--color-primary)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className="hidden sm:inline">返回</span>
        </button>
        <h1 className="text-sm font-medium truncate max-w-[120px] sm:max-w-xs"
          style={{ color: 'var(--color-text)' }}>
          {title}
        </h1>
        <span className="text-[10px] shrink-0" style={{ color: 'var(--color-text-muted)' }}>v0.1.0</span>
      </div>
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* TTS 朗读按钮 */}
        {onStartTTS && (
          <button
            onClick={ttsActive ? onStopTTS : onStartTTS}
            disabled={ttsState === 'loading'}
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
            style={{
              background: ttsActive ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
              color: ttsActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
            }}
            title={ttsActive ? '停止朗读' : '朗读本章'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {ttsState === 'playing' ? (
                <><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>
              ) : (
                <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /></>
              )}
            </svg>
            <span className="hidden sm:inline">{ttsState === 'playing' ? '朗读中' : ttsState === 'paused' ? '已暂停' : ttsState === 'loading' ? '加载中' : '朗读'}</span>
          </button>
        )}
        {/* 离线缓存按钮 */}
        {onCacheChapter && (
          <>
            <button
              onClick={onCacheChapter}
              disabled={cachingInProgress}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
              style={{
                background: cacheStatus?.chapterCount ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                color: cacheStatus?.chapterCount ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              }}
              title="缓存当前章节到本地（离线可用）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              <span className="hidden sm:inline">{cachingInProgress ? '缓存中' : '缓存'}</span>
            </button>
            <button
              onClick={onCacheFullBook}
              disabled={cachingInProgress}
              className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              title="缓存全书到本地（离线可用）"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                <line x1="12" y1="22.08" x2="12" y2="12" />
              </svg>
              <span className="hidden sm:inline">全书</span>
            </button>
            {cacheStatus && cacheStatus.chapterCount > 0 && (
              <>
                <span className="text-xs" style={{ color: 'var(--color-primary)' }} title="已缓存章节数">
                  {cacheStatus.chapterCount}/{cacheStatus.totalChapters}
                </span>
                <button
                  onClick={onClearCache}
                  className="w-6 h-6 flex items-center justify-center rounded-full tap-icon"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="清除本地缓存"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </>
            )}
          </>
        )}
        {onToggleToc && (
          <button
            onClick={onToggleToc}
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span className="hidden sm:inline">目录</span>
          </button>
        )}
        {/* 字体族选择 */}
        {onFontFamilyChange && (
          <select
            value={fontFamily || 'sans'}
            onChange={(e) => onFontFamilyChange(e.target.value as 'sans' | 'serif' | 'mono')}
            className="text-xs px-2 py-1.5 rounded-lg border-none cursor-pointer"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text)' }}
          >
            <option value="sans">无衬线</option>
            <option value="serif">衬线</option>
            <option value="mono">等宽</option>
          </select>
        )}
        {/* 阅读模式切换 */}
        <button
          onClick={onToggleReadingMode}
          className="flex items-center gap-1 text-xs px-2 py-1.5 rounded-full transition-all duration-200 tap-active"
          style={{
            background: readingMode === 'paginated' ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
            color: readingMode === 'paginated' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
          }}
          title="切换阅读模式"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {readingMode === 'paginated' ? (
              <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>
            ) : (
              <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>
            )}
          </svg>
          <span className="hidden sm:inline">{readingMode === 'paginated' ? '翻页' : '滚动'}</span>
        </button>
        {/* 字号控制 */}
        {onFontSizeChange && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onFontSizeChange(Math.max(12, (fontSize || 18) - 2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
            >
              A-
            </button>
            <span className="text-xs w-5 text-center" style={{ color: 'var(--color-text-secondary)' }}>{fontSize || 18}</span>
            <button
              onClick={() => onFontSizeChange(Math.min(36, (fontSize || 18) + 2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
            >
              A+
            </button>
          </div>
        )}
        {/* 行高控制 */}
        {onLineHeightChange && (
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => onLineHeightChange(Math.max(1.2, (lineHeight || 1.8) - 0.2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              disabled={(lineHeight || 1.8) <= 1.2}
            >
              行-
            </button>
            <span className="text-xs w-5 text-center" style={{ color: 'var(--color-text-secondary)' }}>{(lineHeight || 1.8).toFixed(1)}</span>
            <button
              onClick={() => onLineHeightChange(Math.min(3.0, (lineHeight || 1.8) + 0.2))}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-xs tap-icon transition-all duration-150"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
              disabled={(lineHeight || 1.8) >= 3.0}
            >
              行+
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ReaderPage;
