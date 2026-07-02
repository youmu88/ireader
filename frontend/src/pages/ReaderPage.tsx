import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  cacheBookChapters,
  cacheSingleChapter,
  getCachedChapterContent,
  getBookCacheStatus,
  clearBookCache,
} from '../services/offlineCacheService';
import axios from 'axios';
import {
  getDefaultPlayer,
  splitText,
  type PlayerState,
} from '../services/ttsPlayer';

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
  const loadPlaybackFromLocalStorage = (): PlaybackState | null => {
    try {
      const raw = localStorage.getItem(TTS_PLAYBACK_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }
    return null;
  };

  const [fontSize, setFontSize] = useState(initialPrefs.fontSize ?? 18);
  const [fontFamily, setFontFamily] = useState<'sans' | 'serif' | 'mono'>(initialPrefs.fontFamily ?? 'sans');
  const [lineHeight, setLineHeight] = useState(initialPrefs.lineHeight ?? 1.8);
  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsSpeed, setTtsSpeed] = useState(1.0);
  const [ttsVolume, setTtsVolume] = useState(() => {
    try { const v = localStorage.getItem('ireader_tts_volume'); return v ? parseFloat(v) : 1.0; } catch { return 1.0; }
  });
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [readingMode, setReadingMode] = useState<'scroll' | 'paginated'>(initialPrefs.readingMode ?? 'scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const showEpubView = false; // 原版/文本切换按钮已移除，固定为文本视图

  const [showTtsResumeBanner, setShowTtsResumeBanner] = useState(false); // show resume prompt
  const [ttsResuming, setTtsResuming] = useState(false); // loading state during jumpToSegment
  // ── 悬浮UI控制（全屏阅读：点击屏幕显示/隐藏所有控件） ──
  const [showUi, setShowUi] = useState(false);
  const uiHideTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const txtPageRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const epubRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const progressSaveTimer = useRef<any>(null);
  const ttsProgressSaveTimer = useRef<any>(null);
  const ttsPlayerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const chaptersRef = useRef(chapters);
  const currentChapterRef = useRef(currentChapter);
  const loadingNextChapterRef = useRef(false);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const goToNextChapterRef = useRef<((_fromAutoScroll?: boolean) => Promise<void>) | null>(null);
  /** TTS 自动进入下一章 — ref 包装避免闭包过期 */
  const advanceToNextChapterTTSRef = useRef<((player: any) => Promise<void>) | null>(null);
  const epubTextScrollRef = useRef<HTMLDivElement>(null);
  const txtScrollRef = useRef<HTMLDivElement>(null);
  const savedTtsProgressRef = useRef<{chapterId: string; segmentIndex: number; progress: number} | null>(null);
  /** 当前书籍 ID 的 ref（用于异步操作的书籍切换守卫） */
  const currentBookIdRef = useRef<string | undefined>(bookId);
  /** 进度条容器 ref（用于拖拽 seek） */
  const progressBarRef = useRef<HTMLDivElement>(null);
  /** 是否正在拖拽进度条（防止 mouseup 未触发导致的卡住） */
  const isDraggingRef = useRef(false);

  // ── 睡眠计时器 ──

  // ── 全屏阅读：点击屏幕切换UI显示 ──
  const handleTapReader = useCallback(() => {
    setShowUi(prev => {
      const next = !prev;
      if (uiHideTimerRef.current) clearTimeout(uiHideTimerRef.current);
      if (next) {
        uiHideTimerRef.current = setTimeout(() => setShowUi(false), 6000);
      }
      return next;
    });
  }, []);

  // Cleanup auto-hide timer on unmount
  useEffect(() => {
    return () => {
      if (uiHideTimerRef.current) clearTimeout(uiHideTimerRef.current);
    };
  }, []);

  // ── 睡眠计时器 ──
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);
  const sleepTimerEndRef = useRef<number | null>(null);
  const sleepTimerIntervalRef = useRef<any>(null);
  /** TTS 后台预生成下一章 — 防止重复追加 */
  const nextChapterPreparedRef = useRef(false);
  /** Preloaded next-chapter contents for smooth scroll transitions */
  /** Track chapter IDs accumulated during auto-scroll for continuous reading */
  const accumulatedIdsRef = useRef<Set<string>>(new Set());
  /** Preloaded next-chapter contents for smooth scroll transitions */
  const preloadedChaptersRef = useRef<Map<string, {content: string; html?: string}>>(new Map());
  /** Saved reading progress from API, consumed by loadEpub */
  const savedProgressRef = useRef<any>(null);
  /** Display chapter title — stays on original chapter during append mode */
  const [displayChapter, setDisplayChapter] = useState<Chapter | null>(null);
  // ── 客户端离线缓存 ──
  const [cacheStatus, setCacheStatus] = useState<{
    chapterCount: number;
    totalChapters: number;
    hasAudio: boolean;
  } | null>(null);
  const [cachingInProgress, setCachingInProgress] = useState(false);

  // ── 服务端统计信息（阅读进度 + 语音预合成 + 缓存概况） ──
  interface ServerBookStats {
    readingPercentage: number;
    voiceGenerationRate: number;
    totalChapters: number;
    completedVoiceChapters: number;
    ttsCacheCount: number;
    cachedChapters: number;
    cacheType: string | null;
  }
  const [serverStats, setServerStats] = useState<ServerBookStats | null>(null);

  /** 检查当前书籍的客户端缓存状态 */
  const checkCacheStatus = useCallback(async () => {
    if (!bookId) return;
    try {
      const status = await getBookCacheStatus(bookId);
      if (status) {
        setCacheStatus({
          chapterCount: status.cachedChapters,
          totalChapters: status.totalChapters,
          hasAudio: status.cachedAudioSegments > 0,
        });
      } else {
        setCacheStatus(null);
      }
    } catch {
      setCacheStatus(null);
    }
  }, [bookId]);

  /** 加载服务端统计信息（阅读进度 + 语音预合成 + 缓存概况） */
  const loadServerStats = useCallback(async () => {
    if (!bookId) return;
    try {
      const res = await axios.get(`/api/books/${bookId}/stats`);
      if (res.data.success) {
        setServerStats(res.data.data);
      }
    } catch { /* 静默失败 */ }
  }, [bookId]);

  /** 缓存当前章节到客户端 */
  const handleCacheCurrentChapter = useCallback(async () => {
    if (!bookId || !currentChapter || !book) return;
    setCachingInProgress(true);
    try {
      // 获取当前章节内容
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content || '';
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

  /** 缓存全书到客户端 */
  const handleCacheFullBook = useCallback(async () => {
    if (!bookId || !book || !chapters.length) return;
    setCachingInProgress(true);
    try {
      // 批量获取所有章节内容
      const chapterData: { chapterId: string; title: string; order: number; content: string }[] = [];
      for (const ch of chapters) {
        const res = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`);
        const rawContent = res.data.data?.content || '';
        const content = book.format === 'epub' ? stripHtml(rawContent) : rawContent;
        chapterData.push({
          chapterId: ch.id,
          title: ch.title,
          order: ch.order,
          content,
        });
      }
      await cacheBookChapters(bookId, book.title, chapterData);
      await checkCacheStatus();
    } catch (err) {
      console.warn('缓存全书失败:', err);
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, book, chapters, checkCacheStatus]);

  /** 清除客户端缓存 */
  const handleClearCache = useCallback(async () => {
    if (!bookId) return;
    try {
      await clearBookCache(bookId);
      setCacheStatus(null);
    } catch (err) {
      console.warn('清除缓存失败:', err);
    }
  }, [bookId]);

  // Load book and chapters — also handles book-switch cleanup
  useEffect(() => {
    if (!bookId) return;

    // ⭐ 书籍切换守卫：更新 ref，使进行中的异步操作可通过对比检测到书籍已变更
    currentBookIdRef.current = bookId;

    // ⭐ 检测当前播放器是否正在播放同一本书（从书架返回阅读页时保持后台播放不中断）
    const player = getDefaultPlayer();
    const isSameBookPlaying = player.currentBookId === bookId &&
      (player.getState() === 'playing' || player.getState() === 'paused' || player.getState() === 'loading');

    if (isSameBookPlaying) {
      // ✅ 同一本书正在播放 → 保持播放，仅同步 UI 状态并挂载新回调
      ttsPlayerRef.current = player;
      const idx = player.getCurrentIndex();
      const total = player.getTotalChunks();
      setTtsState(player.getState());
      setTtsProgress(total > 0 ? (idx + 1) / total : 0);
      setTtsSegmentText(player.getCurrentSegmentText());
      setActiveSegmentIndex(idx);
              // 挂载新回调（旧的 setter 来自已卸载的组件）
      player.setCallbacks({
        onStateChange: (s) => { setTtsState(s); },
        onSegmentPlay: (i, _t) => {
          setTtsSegmentText(player.getCurrentSegmentText());
          setActiveSegmentIndex(i);
          // ⭐ 自动滚动到当前高亮分段
          requestAnimationFrame(() => {
            const container = epubTextScrollRef.current || txtScrollRef.current;
            if (!container) return;
            const highlighted = container.querySelector('[data-tts-segment="active"]');
            if (highlighted) {
              highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        },
        onProgress: (p) => setTtsProgress(p),
        onError: (err) => {
          setTtsError(err);
          setTimeout(() => setTtsError(null), 8000);
        },
        onEnd: () => {
          setTtsProgress(1);
          if (ttsProgressSaveTimer.current) {
            clearInterval(ttsProgressSaveTimer.current);
            ttsProgressSaveTimer.current = null;
          }
          advanceToNextChapterTTSRef.current?.(player);
        },
      });
      // 仍然加载书籍信息（章节列表、封面等），但不重置播放器
      loadBook();
    } else {
      // ❌ 不同书籍或未播放 → 彻底重置 TTS 播放器
      player.stop();
      player.setCallbacks({});
      ttsPlayerRef.current = null;
      setTtsState('idle');
      setTtsProgress(0);
      setTtsSegmentText('');
      setActiveSegmentIndex(-1);
      setTtsError(null);

      // ⭐ 清除 TTS 进度保存定时器
      if (ttsProgressSaveTimer.current) {
        clearInterval(ttsProgressSaveTimer.current);
        ttsProgressSaveTimer.current = null;
      }

      // ⭐ 重置书籍相关的 ref，防止旧书数据污染新书
      nextChapterPreparedRef.current = false;
      accumulatedIdsRef.current.clear();
      preloadedChaptersRef.current.clear();
      savedTtsProgressRef.current = null;
      savedProgressRef.current = null;
      loadingNextChapterRef.current = false;

      // ⭐ 清除睡眠计时器
      if (sleepTimerIntervalRef.current) {
        clearInterval(sleepTimerIntervalRef.current);
        sleepTimerIntervalRef.current = null;
      }
      setSleepTimerMinutes(null);
      sleepTimerEndRef.current = null;

      loadBook();
    }

    // Cleanup on unmount or book switch
    return () => {
      // ⭐ 不再调用 p.stop() 和 p.setCallbacks({})——卸载时保持 TTS 后台播放
      // （用户可能在书架页继续听书）。书籍切换时，新的 effect 会调用 stop() 处理。
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

  // Separate effect for EPUB loading — waits for DOM (readerRef) to be ready
  useEffect(() => {
    if (!book || book.format !== 'epub') return;
    loadEpub(book);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  const loadBook = async () => {
    // ⭐ 记录触发时的书籍 ID，异步完成后校验是否仍为同一本书
    const triggerBookId = bookId;
    try {
      setLoading(true);
      const [bookRes, chaptersRes] = await Promise.all([
        axios.get(`/api/books/${bookId}`),
        axios.get(`/api/books/${bookId}/chapters`),
      ]);

      // ⭐ 书籍切换守卫：异步 fetch 期间用户可能已切换到另一本书
      if (currentBookIdRef.current !== triggerBookId) return;

      const bookData = bookRes.data.data;
      setBook(bookData);
      const chaptersData = chaptersRes.data.data || [];
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
            savedProgressRef.current = savedProgress; // 供 loadEpub 恢复精确位置
          }
        }
        // ⭐ 对于 TXT 书籍也从后端加载 TTS 精确分段位置（与 loadEpub 对 EPUB 的处理对称）
        if (!isEpub && savedProgress?.textOffset != null && savedProgress?.percentage != null && savedProgress?.chapterId) {
          savedTtsProgressRef.current = {
            chapterId: savedProgress.chapterId,
            segmentIndex: savedProgress.textOffset,
            progress: savedProgress.percentage,
          };
        }
      } catch { /* 无保存的进度 */ }

      // ⭐ 再次校验书籍是否仍为同一本
      if (currentBookIdRef.current !== triggerBookId) return;

      if (targetChapter) {
        await loadChapterContent(targetChapter, undefined, isEpub);
        // 恢复精确滚动位置（使用保存的 pageIndex）
        if (savedProgress?.pageIndex != null && bookData.format !== 'epub') {
          const restorePct = savedProgress.pageIndex / 10000;
          requestAnimationFrame(() => {
            const container = epubTextScrollRef.current || txtScrollRef.current;
            if (container && restorePct > 0) {
              container.scrollTop = restorePct * (container.scrollHeight - container.clientHeight);
            }
          });
        }
        // 首次加载后立即预加载后续章节
        preloadNextChapters(targetChapter.id);
      }

      // 检查客户端缓存状态 + 加载服务端统计
      checkCacheStatus();
      loadServerStats();
    } catch (err: any) {
      setError(err.response?.data?.error || '加载图书失败');
    } finally {
      setLoading(false);
    }
  };

  // Load EPUB with epubjs
  const loadEpub = async (bookData: Book) => {
    try {
      // Wait for DOM to be ready (readerRef div must be rendered)
      if (!readerRef.current) {
        // DOM not ready yet — schedule for next frame
        await new Promise<void>(resolve => {
          const check = () => {
            if (readerRef.current) { resolve(); }
            else { requestAnimationFrame(check); }
          };
          requestAnimationFrame(check);
        });
      }

      const ePub = (await import('epubjs')).default;
      const book = ePub(`/api/books/${bookData.id}/file`);
      epubRef.current = book;

      const rendition = book.renderTo(readerRef.current!, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: 'paginated',
      });
      renditionRef.current = rendition;

      // Display first spine item
      await rendition.display();

      // Restore reading progress (use savedProgressRef from loadBook to avoid duplicate API call)
      const progress = savedProgressRef.current;
      if (progress?.cfi) {
        await rendition.display(progress.cfi);
      }
      // Save TTS progress for later restore
      if (progress?.textOffset != null && progress?.percentage != null && progress?.chapterId) {
        savedTtsProgressRef.current = {
          chapterId: progress.chapterId,
          segmentIndex: progress.textOffset,
          progress: progress.percentage,
        };
      }

      // Track location changes for progress saving, chapter sync & auto-advance
      rendition.on('relocated', (location: any) => {
        const cfi = location?.start?.cfi;
        if (cfi) {
          debounceSaveProgress({ cfi, percentage: location?.start?.percentage || 0 });
        }

        // ⭐ 同步 currentChapter：检测用户当前查看的 spine item，更新 currentChapter
        // 解决语音朗读与阅读页面不对齐的问题（朗读始终按 currentChapter 获取内容）
        const start = location?.start;
        if (start?.href) {
          const chs = chaptersRef.current;
          const matchedIdx = chs.findIndex((c: Chapter) => c.href && start.href.startsWith(c.href));
          if (matchedIdx >= 0) {
            const matchedChapter = chs[matchedIdx];
            // 只在章节真正变化时更新 state（避免每次翻页都 setState）
            if (currentChapterRef.current?.id !== matchedChapter.id) {
              setCurrentChapter(matchedChapter);
              setDisplayChapter(matchedChapter);
            }
          }
        }

        // 自动跳转下一章：检测到当前 spine item 接近末尾（比例 > 95%）时自动跳转
        if (start?.percentage != null && start.percentage > 0.95 && !loadingNextChapterRef.current && start.href) {
          const chs = chaptersRef.current;
          const idx = chs.findIndex((c: Chapter) => c.href && start.href.startsWith(c.href));
          if (idx >= 0 && idx < chs.length - 1) {
            loadingNextChapterRef.current = true;
            setTimeout(() => {
              renditionRef.current?.display(chs[idx + 1].href).then(() => {
                setTimeout(() => { loadingNextChapterRef.current = false; }, 2000);
              });
            }, 600);
          }
        }
      });
    } catch (err) {
      console.error('Failed to load EPUB:', err);
      setError('加载 EPUB 阅读器失败');
    }
  };

  /** Strip HTML tags for plain text display */
  const stripHtml = useCallback((html: string): string => {
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
  }, []);

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
  const loadChapterContent = async (chapter: Chapter, _offset?: number, _isEpub?: boolean, _append?: boolean) => {
    try {
      // 在异步获取内容前清空 txtContent，防止 getCurrentChapterText() 读到旧数据
      setTxtContent('');
      setCurrentChapter(chapter);
      // append 模式下不更新显示标题（保持显示原始章节名，避免标题跳跃）
      if (!_append) {
        setDisplayChapter(chapter);
      }

      // 获取章节内容（优先使用预加载内容，其次离线缓存，最后 API）
      let content: string;
      let epubHtml: string | undefined;
      const isEpub = _isEpub ?? (book?.format === 'epub');
      const preloaded = preloadedChaptersRef.current.get(chapter.id);
      if (preloaded) {
        content = preloaded.content;
        epubHtml = preloaded.html;
        preloadedChaptersRef.current.delete(chapter.id);
      } else {
        // 尝试从客户端离线缓存读取
        const cachedContent = await getCachedChapterContent(bookId!, chapter.id);
        if (cachedContent) {
          content = cachedContent;
        } else {
          // append 模式下不显示「加载中...」闪烁：保持现有内容可见，静默加载
          if (!_append) setChapterLoading(true);
          const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
          const rawContent = res.data.data?.content || '';
          if (isEpub) {
            epubHtml = sanitizeEpubHtml(rawContent, bookId!);
            content = stripHtml(rawContent);
            if (!_append) setEpubDisplayHtml(epubHtml);
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
        if (isEpub && epubHtml) {
          setEpubDisplayHtml(epubHtml);
        } else if (isEpub) {
          setEpubDisplayHtml(displayContent);
        }
      }

      // 预加载后续章节，确保滚动到末尾时内容已就绪
      preloadNextChapters(chapter.id);
    } catch (err: any) {
      setError('加载章节内容失败');
      setChapterLoading(false);
    }
  };

  // Debounced progress save

  /** 预加载后续2个章节内容，实现滚动到底无缝过渡 */
  const preloadNextChapters = useCallback(async (currentChapterId: string) => {
    if (!chapters.length) return;
    const idx = chapters.findIndex(c => c.id === currentChapterId);
    if (idx < 0) return;
    // 并行预加载后续2章，互不等待，大幅提高预加载速度
    const isEpub = book?.format === 'epub';
    const preloadTasks = [];
    for (let i = 1; i <= 2; i++) {
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

  // Debounced progress save
  const debounceSaveProgress = useCallback((data: Record<string, any>) => {
    if (progressSaveTimer.current) clearTimeout(progressSaveTimer.current);
    progressSaveTimer.current = setTimeout(async () => {
      try {
        await axios.put(`/api/books/${bookId}/progress`, data);
      } catch { /* silent */ }
    }, PROGRESS_SAVE_DELAY);
  }, [bookId]);

  // TXT chapter navigation
  const navigateToChapter = async (chapter: Chapter, _append?: boolean) => {
    setShowToc(false);
    await loadChapterContent(chapter, undefined, undefined, _append);

    // ⭐ 手动切换章节（非 append 追加模式）时重置滚动位置到顶部
    // 避免从上一章末尾切到本章后仍停留在底部，直接看到本章尾部
    if (!_append) {
      if (epubTextScrollRef.current) {
        epubTextScrollRef.current.scrollTop = 0;
      }
      if (txtScrollRef.current) {
        txtScrollRef.current.scrollTop = 0;
      }
    }

    debounceSaveProgress({ chapterId: chapter.id, percentage: chapter.order / chapters.length });

    // Only navigate epubjs rendition when the epubjs view is actually visible
    // (avoiding triggering relocated events during text view auto-scroll)
    if (book?.format === 'epub' && showEpubView && renditionRef.current && chapter.href) {
      try {
        await renditionRef.current.display(chapter.href);
      } catch {
        // epubjs navigation failed — text view still works
      }
    }
  };

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
    // 保存上一章完成进度
    saveTtsProgress(currentChapterRef.current.id, -1, 1);
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
      if (epubTextScrollRef.current) epubTextScrollRef.current.scrollTop = 0;
      // 加载下一章文本到播放器
      await player.load(content, false);
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

    // ⭐ 调试模式：统一从 API 获取当前章节内容，不依赖 txtContent（可能累积多章内容）
    try {
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content;
      if (!rawContent) return '';
      // EPUB 内容去 HTML 标签；TXT 内容已经是纯文本
      return book.format === 'epub' ? stripHtml(rawContent) : rawContent;
    } catch { /* fallback */ }

    // 兜底：尝试从 epubjs 获取当前显示内容
    try {
      if (renditionRef.current) {
        const contents = renditionRef.current.getContents();
        if (contents?.length > 0) {
          const bodyText = contents[0].document?.body?.innerText;
          if (bodyText) return bodyText;
        }
      }
    } catch { /* fallback */ }

    // 最终兜底：返回 txtContent（不理想但至少有点内容）
    return txtContent;
  }, [currentChapter, bookId, book, txtContent]);

  /** 保存 TTS 播放进度 */
  const saveTtsProgress = useCallback((chapterId: string, segmentIndex: number, progress: number) => {
    debounceSaveProgress({
      chapterId,
      textOffset: segmentIndex,
      percentage: progress,
    });
  }, [debounceSaveProgress]);

  /** 启动 TTS 进度定期保存（同时持久化到 localStorage，支持页面刷新恢复） */
  const startTtsProgressSaver = useCallback((bookId: string, chapterId: string, chapterTitle: string, player: any) => {
    if (ttsProgressSaveTimer.current) clearInterval(ttsProgressSaveTimer.current);
    ttsProgressSaveTimer.current = setInterval(() => {
      const idx = player.getCurrentIndex();
      const total = player.getTotalChunks();
      if (idx >= 0 && total > 0) {
        const pct = (idx + 1) / total;
        saveTtsProgress(chapterId, idx, pct);
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
      // 设置当前播放的书籍信息（供全局状态订阅使用）
      player.currentBookId = bookId;
      player.chapterTitle = currentChapter?.title || '';
      (player as any).bookTitle = book?.title || '';

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
            const container = epubTextScrollRef.current || txtScrollRef.current;
            if (!container) return;
            const highlighted = container.querySelector('[data-tts-segment="active"]');
            if (highlighted) {
              highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });

          // ⭐ 播放到 75% 时预加载下一章内容（仅内容预加载，不追加到播放器）
          if (_total > 0 && idx >= _total * 0.75) {
            const ci = chapters.findIndex((c) => c.id === currentChapter?.id);
            if (ci >= 0 && ci < chapters.length - 1) {
              preloadNextChapters(currentChapter!.id);
            }
          }
        },
        onProgress: (p) => setTtsProgress(p),
        onError: (err) => {
          console.warn('TTS 朗读错误:', err);
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
      });

      // ⭐ 从 localStorage 读取"实时合成模式"开关（设置页可配置）
      const noCachePref = (() => {
        try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; }
      })();
      await player.init({
        speed: ttsSpeed,
        noCache: noCachePref,
        // ⭐ 传入书籍信息用于 Media Session 锁屏封面
        bookTitle: book?.title || '',
        bookCoverUrl: book ? `/api/books/${bookId}/cover` : '',
      });
      player.setVolume(ttsVolume);

      // 文本已是纯文本（EPUB 已由 getCurrentChapterText 返回 txtContent，非原始 HTML）
      await player.load(text, false);

      // ⭐ 恢复 TTS 位置：跳转到上次保存的分段（长章节 50+ 段可能耗时）
      const savedPos = savedTtsProgressRef.current;
      if (savedPos && savedPos.chapterId === currentChapter?.id && savedPos.segmentIndex > 0) {
        setTtsResuming(true);
        try {
          await player.jumpToSegment(savedPos.segmentIndex);
        } finally {
          setTtsResuming(false);
        }
      }

      // Start periodic TTS progress saving (also persists to localStorage)
      startTtsProgressSaver(bookId, currentChapter.id, currentChapter?.title || '', player);

      await player.play();
    } catch (err) {
      console.error('TTS 启动失败:', err);
      setTtsError('语音播放启动失败：TTS 后端服务不可用（默认 Kokoro :8880 未运行），请在设置中切换到 Edge-TTS 或启动 Kokoro 服务');
      setTimeout(() => setTtsError(null), 10000);
    }
  }, [bookId, currentChapter, book, ttsSpeed, getCurrentChapterText, saveTtsProgress, startTtsProgressSaver, preloadNextChapters]);

  /** 暂停 TTS */
  const handlePauseTTS = useCallback(() => {
    ttsPlayerRef.current?.pause();
  }, []);

  /** 恢复 TTS */
  const handleResumeTTS = useCallback(() => {
    ttsPlayerRef.current?.resume();
  }, []);


  const handleStopTTS = useCallback(() => {
    // Save current TTS position before stopping
    if (ttsPlayerRef.current && currentChapter) {
      const idx = ttsPlayerRef.current.getCurrentIndex();
      const total = ttsPlayerRef.current.getTotalChunks();
      if (idx >= 0 && total > 0) {
        saveTtsProgress(currentChapter.id, idx, (idx + 1) / total);
      }
    }
    // ⭐ 清除 localStorage 播放持久化记录（用户主动停止，不再需要恢复）
    clearPlaybackFromLocalStorage();
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
  }, [currentChapter, saveTtsProgress]);

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

  /** 设置 TTS 语速 */
  const handleTTSSpeedChange = useCallback((speed: number) => {
    setTtsSpeed(speed);
    ttsPlayerRef.current?.setSpeed(speed);
  }, []);

  /** 设置 TTS 音量 */
  const handleVolumeChange = useCallback((vol: number) => {
    setTtsVolume(vol);
    ttsPlayerRef.current?.setVolume(vol);
    try { localStorage.setItem('ireader_tts_volume', String(vol)); } catch {}
  }, []);

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

  // ⭐ 同时检查 localStorage（页面刷新后恢复）和 后端 API 进度
  // ⭐ 同时检查 localStorage（页面刷新后恢复）和 后端 API 进度
  useEffect(() => {
    if (!currentChapter || !chapters.length) return;

    // 1️⃣ 检查 localStorage 是否有播放持久化记录（页面刷新后的主要恢复源）
    const localPlayback = loadPlaybackFromLocalStorage();
    if (localPlayback && localPlayback.bookId === bookId && localPlayback.segmentIndex > 0) {
      // 用 localStorage 数据补充/覆盖 savedTtsProgressRef
      const chapter = chapters.find(c => c.id === localPlayback.chapterId);
      if (chapter) {
        savedTtsProgressRef.current = {
          chapterId: localPlayback.chapterId,
          segmentIndex: localPlayback.segmentIndex,
          progress: 0.5, // localStorage 不保存精确 progress，给个中间值触发横幅
        };
      }
    }

    // 2️⃣ 有可恢复的进度则显示横幅
    const saved = savedTtsProgressRef.current;
    if (saved && saved.progress > 0 && saved.progress < 1) {
      setShowTtsResumeBanner(true);
    }
  }, [currentChapter, chapters, bookId]);

  // 阅读模式切换：EPUB 重新渲染
  useEffect(() => {
    if (book?.format !== 'epub' || !epubRef.current || !renditionRef.current) return;
    (async () => {
      const currentCfi = (renditionRef.current as any).currentLocation?.()?.start?.cfi;
      renditionRef.current.destroy();
      if (!readerRef.current) return;
      const newRendition = epubRef.current.renderTo(readerRef.current, {
        width: '100%',
        height: '100%',
        spread: 'none',
        flow: readingMode === 'paginated' ? 'paginated' : 'scrolled-doc',
      });
      renditionRef.current = newRendition;
      newRendition.display(currentCfi);
      newRendition.on('relocated', (location: any) => {
        const cfi = location?.start?.cfi;
        if (cfi) {
          debounceSaveProgress({ cfi, percentage: location?.start?.percentage || 0 });
        }
      });
    })();
  }, [readingMode, book?.format]);


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
    const scrollContainer = epubTextScrollRef.current || txtScrollRef.current;
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
  }, [readingMode, book?.format, showEpubView]);

  /** 根据 pageIndex 获取分页后的 TXT 内容 */

  // ── 滚动进度保存：跟踪用户滚动位置，定期保存阅读进度 ──
  const scrollProgressSaveTimer = useRef<any>(null);
  const handleScrollProgress = useCallback(() => {
    if (!currentChapter || !chapters.length) return;
    if (scrollProgressSaveTimer.current) clearTimeout(scrollProgressSaveTimer.current);
    scrollProgressSaveTimer.current = setTimeout(() => {
      const container = epubTextScrollRef.current || txtScrollRef.current;
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
    const container = epubTextScrollRef.current || txtScrollRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScrollProgress, { passive: true });
    return () => {
      container.removeEventListener('scroll', handleScrollProgress);
      if (scrollProgressSaveTimer.current) clearTimeout(scrollProgressSaveTimer.current);
    };
  }, [readingMode, txtContent, currentChapter, handleScrollProgress]);

  /** 根据 pageIndex 获取分页后的 TXT 内容 */
  const getPaginatedContent = useCallback((content: string, page: number, total: number): string => {
    if (readingMode !== 'paginated' || total <= 1) return content;
    const lines = content.split('\n');
    const linesPerPage = Math.max(1, Math.ceil(lines.length / total));
    const start = page * linesPerPage;
    const end = Math.min(start + linesPerPage, lines.length);
    return lines.slice(start, end).join('\n');
  }, [readingMode]);

  // TXT 分页模式：根据内容长度估算总页数
  useEffect(() => {
    if (book?.format !== 'txt' || !txtContent) {
      setTotalPages(1);
      return;
    }
    // 按每页约 50 行估算（基于 \n 行数），翻页模式下重置 pageIndex
    const lineCount = txtContent.split('\n').length;
    const pages = Math.max(1, Math.ceil(lineCount / 50));
    setTotalPages(pages);
    if (pageIndex >= pages) setPageIndex(0);
  }, [txtContent, book?.format, readingMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Save final TTS position before leaving
      if (ttsPlayerRef.current && currentChapter) {
        const idx = ttsPlayerRef.current.getCurrentIndex();
        const total = ttsPlayerRef.current.getTotalChunks();
        if (idx >= 0 && total > 0) {
          saveTtsProgress(currentChapter.id, idx, (idx + 1) / total);
        }
      }
      if (renditionRef.current) {
        renditionRef.current.destroy();
      }
      if (epubRef.current) {
        epubRef.current.destroy();
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
      <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
        <ReaderTopBar title="" onBack={() => navigate('/')} readingMode="scroll" onToggleReadingMode={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-400 dark:text-gray-500 text-lg">加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
        <ReaderTopBar title="" onBack={() => navigate('/')} readingMode="scroll" onToggleReadingMode={() => {}} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-red-500 mb-4">{error}</p>
            <button
              onClick={() => { setError(null); loadBook(); }}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-white dark:bg-gray-900 select-none">
      <div className="h-full relative">
        {/* ── 浮动章节导航按钮（半透明大按钮，屏幕左右中部） ── */}
        <button
          onClick={(e) => { e.stopPropagation(); goToPrevChapter(); }}
          disabled={!currentChapter || chapters.findIndex(c => c.id === currentChapter.id) === 0}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-30 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/20 hover:bg-black/30 dark:bg-white/20 dark:hover:bg-white/30 backdrop-blur-sm text-white text-xl flex items-center justify-center disabled:opacity-0 disabled:pointer-events-none transition-all"
          title="上一章"
        >
          ‹
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); goToNextChapter(); }}
          disabled={!currentChapter || chapters.findIndex(c => c.id === currentChapter.id) === chapters.length - 1}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-30 w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-black/20 hover:bg-black/30 dark:bg-white/20 dark:hover:bg-white/30 backdrop-blur-sm text-white text-xl flex items-center justify-center disabled:opacity-0 disabled:pointer-events-none transition-all"
          title="下一章"
        >
          ›
        </button>
        {/* Reader Content - full screen, no fixed toolbar */}
        <div className="h-full flex flex-col">
          <div className="flex-1 flex overflow-hidden relative" onClick={handleTapReader}>
        {/* TOC Sidebar */}
        {showToc && (
          <div className="w-64 sm:w-72 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 overflow-y-auto absolute sm:relative z-20 inset-y-0 left-0 shadow-lg sm:shadow-none">
            <div className="p-3 font-semibold text-sm border-b border-gray-200 dark:border-gray-700">
              章节目录
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

        {/* EPUB Reader - epubjs view */}
        {book?.format === 'epub' && showEpubView && (
          <div
            ref={readerRef}
            className="flex-1 overflow-hidden"
            style={{ fontSize: `${fontSize}px` }}
          />
        )}

        {/* EPUB Text View (used when !showEpubView or as fallback) */}
        {book?.format === 'epub' && !showEpubView && (
          <div
            ref={epubTextScrollRef}
            className="flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto overflow-y-auto"
          >
            {(displayChapter || currentChapter) && (
              <div className="mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">
                  {(displayChapter || currentChapter)!.title}
                </h2>
              </div>
            )}
            <div
              className="text-gray-800 dark:text-gray-200"
              style={{
                fontSize: `${fontSize}px`,
                fontFamily: fontFamily === 'sans' ? 'inherit' : fontFamily === 'serif' ? '"Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
              }}
            >
              {chapterLoading ? (
                <div className="flex items-center justify-center py-12">
                  <span className="text-gray-400 animate-pulse">加载中...</span>
                </div>
              ) : epubDisplayHtml ? (
                <div
                  className="epub-content"
                  dangerouslySetInnerHTML={{ __html: epubDisplayHtml }}
                />
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
                  <span className="text-gray-400">暂无内容</span>
                </div>
              )}
            </div>
            {/* 底部哨兵元素：用于 IntersectionObserver 检测滚动到末尾 */}
            <div ref={bottomSentinelRef} className="h-4" />
            {/* 底部章节导航（用户手动跳转，作为跨章节滚动失效时的备选方案） */}
            <div className="border-t border-gray-200 dark:border-gray-700 mt-4 pt-3 flex items-center justify-between text-sm">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const idx = chapters.findIndex((c) => c.id === (currentChapter?.id || ''));
                  if (idx > 0) navigateToChapter(chapters[idx - 1]);
                }}
                disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter.id) === 0}
                className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                ← 上一章
              </button>
              <span className="text-gray-500 dark:text-gray-400">
                {currentChapter
                  ? `${chapters.findIndex((c) => c.id === currentChapter.id) + 1} / ${chapters.length}`
                  : ''}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  goToNextChapter();
                }}
                disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter.id) === chapters.length - 1}
                className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-300 dark:hover:bg-gray-600"
              >
                下一章 →
              </button>
            </div>
          </div>
        )}

        {/* TTS Resume Banner */}
        {showTtsResumeBanner && ttsState === 'idle' && savedTtsProgressRef.current && (
          <div className="absolute top-0 left-0 right-0 z-10 mx-auto max-w-xl mt-2">
            <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg px-4 py-2 flex items-center justify-between shadow-sm">
              <span className="text-sm text-green-800 dark:text-green-200">
                {ttsResuming ? (
                  <>🔄 恢复播放中...</>
                ) : (
                  <>🔊 上次播放到 {Math.round(savedTtsProgressRef.current.progress * 100)}%
                  {savedTtsProgressRef.current.chapterId !== currentChapter?.id ? '（不同章节）' : ''}</>
                )}
              </span>
              <div className="flex gap-2">
                {!ttsResuming && (
                  <button
                    onClick={() => {
                      setShowTtsResumeBanner(false);
                      // Navigate to saved chapter if different
                      const saved = savedTtsProgressRef.current;
                      if (saved && saved.chapterId !== currentChapter?.id) {
                        const target = chapters.find(c => c.id === saved.chapterId);
                        if (target) {
                          navigateToChapter(target).then(() => {
                            setTimeout(() => handleStartTTS(), 300);
                          });
                          return;
                        }
                      }
                      handleStartTTS();
                    }}
                    className="text-xs px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-50"
                  >
                    继续播放
                  </button>
                )}
                {ttsResuming ? (
                  <span className="text-xs px-2 py-1 rounded bg-green-100 dark:bg-green-800 text-green-700 dark:text-green-300 animate-pulse">
                    加载中...
                  </span>
                ) : (
                  <button
                    onClick={() => {
                      setShowTtsResumeBanner(false);
                      clearPlaybackFromLocalStorage();
                    }}
                    className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                  >
                    关闭
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TTS Error Banner */}
        {ttsError && (
          <div className="absolute top-0 left-0 right-0 z-10 mx-auto max-w-xl mt-2">
            <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-2 flex items-center justify-between shadow-sm">
              <span className="text-xs sm:text-sm text-red-800 dark:text-red-200 flex-1">
                ⚠️ {ttsError}
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
            ref={txtScrollRef}
            className={`flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto ${readingMode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}
          >
            {(displayChapter || currentChapter) && (
              <div className="mb-4">
                <h2 className="text-xl font-bold text-gray-800 dark:text-gray-200">
                  {(displayChapter || currentChapter)!.title}
                </h2>
              </div>
            )}
            <div
              ref={txtPageRef}
              className={`text-gray-800 dark:text-gray-200 whitespace-pre-wrap ${
                readingMode === 'paginated' ? 'flex-1 overflow-hidden' : ''
              }`}
              style={{
                fontSize: `${fontSize}px`,
                fontFamily: fontFamily === 'sans' ? 'inherit' : fontFamily === 'serif' ? '"Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
              }}
            >
              {chapterLoading ? (
                <div className="flex items-center justify-center py-12">
                  <span className="text-gray-400 animate-pulse">加载中...</span>
                </div>
              ) : (
                readingMode === 'paginated'
                  ? getPaginatedContent(txtContent, pageIndex, totalPages)
                  : ttsState !== 'idle' && activeSegmentIndex >= 0
                    ? renderHighlightedContent(txtContent)
                    : txtContent
              )}
            </div>
            {/* 底部哨兵元素：用于 IntersectionObserver 检测滚动到末尾 */}
            <div ref={bottomSentinelRef} className="h-4" />
          </div>
        )}

        {/* TTS 朗读进度指示（浮层） */}
        {ttsState !== 'idle' && ttsSegmentText && (
          <div className="absolute bottom-0 left-0 right-0 pointer-events-none">
                          <div className="mx-auto max-w-3xl px-3 sm:px-6 pb-16">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                <p className="text-sm text-blue-800 dark:text-blue-200 line-clamp-2">
                  🔊 {ttsSegmentText}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
        </div>

        {/* ⏫ 悬浮操作面板：默认隐藏，点击阅读区显示 */}
        {showUi && (
          <div className="absolute inset-0 z-30 flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* 半透明背景点击关闭 */}
            <div className="absolute inset-0 bg-black/30" onClick={() => setShowUi(false)} />

            <div className="flex-1 relative z-10" onClick={() => setShowUi(false)} />

            {/* 底部控制面板 */}
            <div className="relative z-10 pointer-events-none">
              <div className="pointer-events-auto bg-white dark:bg-gray-800 rounded-t-2xl shadow-2xl max-h-[55vh] overflow-y-auto mx-auto max-w-3xl">
                  <div className="p-4 space-y-3">
                    {/* ── 第一行：返回 + 书名 + 目录 ── */}
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => navigate('/')}
                        className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-700 rounded-full px-3 py-1.5 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >
                        ← 返回
                      </button>
                      <h2 className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate max-w-[50%] text-center">
                        {book?.title || ''}
                      </h2>
                      <button
                        onClick={() => setShowToc(v => !v)}
                        className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${
                          showToc
                            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                      >
                        📑 目录
                      </button>
                    </div>
                    <div className="border-t border-gray-100 dark:border-gray-700" />
                    
                    {/* ── 朗读/缓存 ── */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={ttsState !== 'idle' ? handleStopTTS : handleStartTTS}
                        disabled={ttsState === 'loading'}
                        className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${ttsState !== 'idle' ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
                      >
                        {ttsState === 'playing' ? '🔊 朗读中' : ttsState === 'paused' ? '⏸ 已暂停' : ttsState === 'loading' ? '⏳ 加载中' : '🔊 朗读'}
                      </button>
                      <button
                        onClick={handleCacheCurrentChapter}
                        disabled={cachingInProgress}
                        className="text-xs px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >
                        💾 缓存本章
                      </button>
                      <button
                        onClick={handleCacheFullBook}
                        disabled={cachingInProgress}
                        className="text-xs px-3 py-1.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >
                        📦 全书缓存
                      </button>
                      {cacheStatus && cacheStatus.chapterCount > 0 && (
                        <button
                          onClick={handleClearCache}
                          className="text-xs px-2 py-1.5 rounded-full text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                        >
                          ✕ 清缓存
                        </button>
                      )}
                    </div>

                    {/* 缓存状态 */}
                    {cacheStatus && cacheStatus.chapterCount > 0 && (
                      <div className="text-xs text-green-600 dark:text-green-400">
                        📦 已离线缓存 {cacheStatus.chapterCount}/{cacheStatus.totalChapters}章
                      </div>
                    )}

                    <div className="border-t border-gray-100 dark:border-gray-700" />

                    {/* ── 字号 ── */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-gray-500 dark:text-gray-400">字号</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFontSize(Math.max(12, fontSize - 2))}
                        className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >A-</button>
                      <span className="text-sm text-gray-700 dark:text-gray-300 w-8 text-center font-medium">{fontSize}</span>
                      <button
                        onClick={() => setFontSize(Math.min(36, fontSize + 2))}
                        className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                      >A+</button>
                    </div>
                  </div>

                  {/* ── 行距 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-gray-400">行距</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setLineHeight(Math.max(1.2, lineHeight - 0.2))}
                        disabled={lineHeight <= 1.2}
                        className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
                      >行-</button>
                      <span className="text-xs text-gray-500 dark:text-gray-400 w-8 text-center">{lineHeight.toFixed(1)}</span>
                      <button
                        onClick={() => setLineHeight(Math.min(3.0, lineHeight + 0.2))}
                        disabled={lineHeight >= 3.0}
                        className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-40 transition-colors"
                      >行+</button>
                    </div>
                  </div>

                  {/* ── 字体 + 模式 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-gray-500 dark:text-gray-400">样式</span>
                    <div className="flex items-center gap-2">
                      <select
                        value={fontFamily}
                        onChange={(e) => setFontFamily(e.target.value as 'sans' | 'serif' | 'mono')}
                        className="text-xs px-2 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 border-none cursor-pointer"
                      >
                        <option value="sans">无衬线</option>
                        <option value="serif">衬线</option>
                        <option value="mono">等宽</option>
                      </select>
                      <button
                        onClick={() => { setReadingMode(prev => prev === 'scroll' ? 'paginated' : 'scroll'); setPageIndex(0); }}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                          readingMode === 'paginated'
                            ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                        }`}
                      >
                        {readingMode === 'paginated' ? '📄 翻页' : '📜 滚动'}
                      </button>
                    </div>
                  </div>


                  {ttsState !== 'idle' && (
                    <div className="space-y-2 pt-1">
                      <div className="border-t border-gray-100 dark:border-gray-700" />
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-500 dark:text-gray-400">朗读控制</span>
                        <div className="flex items-center gap-3">
                          {/* 播放控制 */}
                          <div className="flex items-center gap-1">
                            {ttsState === 'playing' ? (
                              <button onClick={handlePauseTTS} className="w-7 h-7 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs hover:bg-blue-600" title="暂停">⏸</button>
                            ) : (
                              <button onClick={ttsState === 'paused' ? handleResumeTTS : handleStartTTS} className="w-7 h-7 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs hover:bg-blue-600" title={ttsState === 'paused' ? '继续' : '播放'}>▶</button>
                            )}
                            <button onClick={handleStopTTS} className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-xs hover:bg-gray-300 dark:hover:bg-gray-600" title="停止">⏹</button>
                          </div>
                          {/* 进度 */}
                          <span className="text-xs text-gray-500 min-w-[2.5rem]">{Math.round(ttsProgress * 100)}%</span>
                          {/* 语速 */}
                          <div className="flex items-center gap-1">
                            <button onClick={() => handleTTSSpeedChange(Math.max(0.5, ttsSpeed - 0.1))} disabled={ttsSpeed <= 0.5} className="text-xs px-1.5 py-1 rounded bg-gray-100 dark:bg-gray-700 disabled:opacity-40">慢</button>
                            <span className="text-xs text-gray-500 w-7 text-center font-medium">{ttsSpeed.toFixed(1)}x</span>
                            <button onClick={() => handleTTSSpeedChange(Math.min(2.0, ttsSpeed + 0.1))} disabled={ttsSpeed >= 2.0} className="text-xs px-1.5 py-1 rounded bg-gray-100 dark:bg-gray-700 disabled:opacity-40">快</button>
                          </div>
                          {/* 音量 */}
                          <div className="flex items-center gap-1">
                            <span className="text-xs">🔊</span>
                            <input type="range" min="0" max="1" step="0.05" value={ttsVolume} onChange={(e) => handleVolumeChange(parseFloat(e.target.value))} className="w-14 sm:w-20 h-1 accent-blue-500" />
                          </div>
                          {/* 睡眠定时 */}
                          <button
                            onClick={() => {
                              const opts: (number | null)[] = [null, 15, 30, 60];
                              const idx = opts.indexOf(sleepTimerMinutes);
                              const next = opts[(idx + 1) % opts.length];
                              handleSetSleepTimer(next);
                            }}
                            className={`text-xs px-2 py-1 rounded transition-colors ${
                              sleepTimerMinutes
                                ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                            }`}
                          >
                            {sleepTimerMinutes ? `⏰ ${sleepTimerMinutes}分` : '⏰ 定时'}
                          </button>
                        </div>
                      </div>
                      {/* 进度条 — 可点击/拖拽 seek */}
                      <div
                        ref={progressBarRef}
                        className="bg-gray-200 dark:bg-gray-700 rounded-full h-3 cursor-pointer relative group"
                        onMouseDown={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                          isDraggingRef.current = true;
                          handleTTSSeek(pct);
                        }}
                      >
                        <div
                          className="bg-blue-500 h-full rounded-full transition-none"
                          style={{ width: `${Math.round(ttsProgress * 100)}%` }}
                        />
                        {/* 拖拽手柄 */}
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `calc(${Math.round(ttsProgress * 100)}% - 8px)` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* ── 底部导航（仅保留章节进度信息，导航按钮移至浮动） ── */}
                  <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
                    <div className="flex items-center justify-center">
                      <span className="text-xs text-gray-500">
                        {currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1} / ${chapters.length}` : ''}
                      </span>
                    </div>
                    {book?.format === 'txt' && readingMode === 'paginated' && (
                      <div className="flex items-center justify-between mt-1">
                        <button
                          onClick={() => { if (pageIndex > 0) setPageIndex(i => i - 1); else goToPrevChapter(); }}
                          disabled={pageIndex === 0 && chapters.findIndex(c => c.id === currentChapter?.id) === 0}
                          className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                        >← 上一页</button>
                        <span className="text-xs text-gray-500">{pageIndex + 1} / {totalPages}</span>
                        <button
                          onClick={() => { if (pageIndex < totalPages - 1) setPageIndex(i => i + 1); else goToNextChapter(); }}
                          disabled={pageIndex >= totalPages - 1 && chapters.findIndex(c => c.id === currentChapter?.id) === chapters.length - 1}
                          className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                        >下一页 →</button>
                      </div>
                    )}
                  </div>

                  {/* ── 服务端统计 ── */}
                  {serverStats && (
                    <div className="border-t border-gray-100 dark:border-gray-700 pt-2">
                      <div className="flex items-center gap-3 flex-wrap text-xs text-gray-500 dark:text-gray-400">
                        <span>📖 阅读 {Math.round(serverStats.readingPercentage * 100)}%</span>
                        <span>📑 {currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1}/${serverStats.totalChapters}` : `共${serverStats.totalChapters}`}章</span>
                        <span>🔊 预合成 {serverStats.completedVoiceChapters}/{serverStats.totalChapters}章</span>
                        {serverStats.ttsCacheCount !== undefined && serverStats.ttsCacheCount > 0 && (
                          <span>🎙️ 语音缓存 {serverStats.ttsCacheCount}条</span>
                        )}
                        {serverStats.cachedChapters > 0 && (
                          <span>💾 内容缓存 {serverStats.cachedChapters}章{serverStats.cacheType ? `（${serverStats.cacheType === 'full_book' ? '全书' : '部分'}）` : ''}</span>
                        )}
                      </div>
                    </div>
                  )}
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
  const ttsLabel = ttsState === 'playing' ? '🔊 朗读中' :
    ttsState === 'paused' ? '🔇 已暂停' :
    ttsState === 'loading' ? '⏳ 加载中' :
    '🔊 朗读本章';

  return (
    <div className="flex items-center justify-between px-2 sm:px-4 py-1 sm:py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 overflow-x-auto">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-blue-600 dark:text-blue-400 hover:underline text-sm">
          ← 返回书架
        </button>
        <h1 className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate max-w-xs">
          {title}
        </h1>
        <span className="text-[10px] text-gray-400 dark:text-gray-500 ml-1 shrink-0">v0.1.0</span>
      </div>
      <div className="flex items-center gap-3">
        {/* TTS 朗读按钮 */}
        {onStartTTS && (
          <button
            onClick={ttsActive ? onStopTTS : onStartTTS}
            disabled={ttsState === 'loading'}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              ttsActive
                ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
            }`}
            title={ttsActive ? '停止朗读' : '朗读本章'}
          >
            {ttsLabel}
          </button>
        )}
        {/* 离线缓存按钮 */}
        {onCacheChapter && (
          <>
            <button
              onClick={onCacheChapter}
              disabled={cachingInProgress}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                cacheStatus?.chapterCount
                  ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
              }`}
              title="缓存当前章节到本地（离线可用）"
            >
              {cachingInProgress ? '⏳' : '💾'} 缓存本章
            </button>
            <button
              onClick={onCacheFullBook}
              disabled={cachingInProgress}
              className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
              title="缓存全书到本地（离线可用）"
            >
              💾 缓存全书
            </button>
            {cacheStatus && cacheStatus.chapterCount > 0 && (
              <>
                <span className="text-xs text-green-600 dark:text-green-400" title="已缓存章节数">
                  📦 {cacheStatus.chapterCount}/{cacheStatus.totalChapters}
                </span>
                <button
                  onClick={onClearCache}
                  className="text-xs px-1 py-1 rounded text-red-500 hover:text-red-700 dark:hover:text-red-300"
                  title="清除本地缓存"
                >
                  ✕
                </button>
              </>
            )}
          </>
        )}
        {onToggleToc && (
          <button
            onClick={onToggleToc}
            className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            📑 目录
          </button>
        )}
        {/* EPUB 视图切换（已移除——原按钮有 bug 且无实际用途） */}
        {/* 字体族选择 */}
        {onFontFamilyChange && (
          <select
            value={fontFamily || 'sans'}
            onChange={(e) => onFontFamilyChange(e.target.value as 'sans' | 'serif' | 'mono')}
            className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-none cursor-pointer"
          >
            <option value="sans">无衬线</option>
            <option value="serif">衬线</option>
            <option value="mono">等宽</option>
          </select>
        )}
        {/* 阅读模式切换 */}
        <button
          onClick={onToggleReadingMode}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            readingMode === 'paginated'
              ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
              : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
          }`}
          title="切换阅读模式"
        >
          {readingMode === 'paginated' ? '📄 翻页' : '📜 滚动'}
        </button>
        {/* 字号控制 */}
        {onFontSizeChange && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onFontSizeChange(Math.max(12, (fontSize || 18) - 2))}
              className="w-7 h-7 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center justify-center text-xs hover:bg-gray-300 dark:hover:bg-gray-600"
            >
              A-
            </button>
            <span className="text-xs text-gray-500 w-6 text-center">{fontSize || 18}</span>
            <button
              onClick={() => onFontSizeChange(Math.min(36, (fontSize || 18) + 2))}
              className="w-7 h-7 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center justify-center text-xs hover:bg-gray-300 dark:hover:bg-gray-600"
            >
              A+
            </button>
          </div>
        )}
        {/* 行高控制 */}
        {onLineHeightChange && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onLineHeightChange(Math.max(1.2, (lineHeight || 1.8) - 0.2))}
              className="w-7 h-7 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center justify-center text-xs hover:bg-gray-300 dark:hover:bg-gray-600"
              disabled={(lineHeight || 1.8) <= 1.2}
            >
              行-
            </button>
            <span className="text-xs text-gray-500 w-6 text-center">{(lineHeight || 1.8).toFixed(1)}</span>
            <button
              onClick={() => onLineHeightChange(Math.min(3.0, (lineHeight || 1.8) + 0.2))}
              className="w-7 h-7 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center justify-center text-xs hover:bg-gray-300 dark:hover:bg-gray-600"
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
