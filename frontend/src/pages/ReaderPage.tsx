import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import {
  cacheBookChapters,
  cacheSingleChapter,
  getCachedChapterContent,
  getBookCacheDetailedStats,
  clearBookCache,
  clearBookChapterCache,
  clearBookTTSAudioCache,
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
  const [paragraphSpacing, setParagraphSpacing] = useState(initialPrefs.paragraphSpacing ?? 0.6);
  const [letterSpacing] = useState(initialPrefs.letterSpacing ?? 0.01);
  const [firstLineIndent, setFirstLineIndent] = useState(initialPrefs.firstLineIndent ?? false);
  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const ttsSpeed = 1.0;
  const ttsVolume = 1.0;
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [readingMode, setReadingMode] = useState<'scroll' | 'paginated'>(initialPrefs.readingMode ?? 'scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const showEpubView = false;
  const [ttsVoice, setTtsVoice] = useState('zh-CN-XiaoxiaoNeural'); // 原版/文本切换按钮已移除，固定为文本视图


  // ── 悬浮UI控制（全屏阅读：点击屏幕显示/隐藏所有控件） ──
  const [showUi, setShowUi] = useState(false);
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
  const [pendingScrollRestorePct, setPendingScrollRestorePct] = useState<number | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  /** 是否正在拖拽进度条（防止 mouseup 未触发导致的卡住） */
  const isDraggingRef = useRef(false);

  // ── 睡眠计时器 ──

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
  const sleepTimerEndRef = useRef<number | null>(null);
  const sleepTimerIntervalRef = useRef<any>(null);
  
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
  const [cacheStatus, setCacheStatus] = useState<BookCacheDetailedStats | null>(null);
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
      const status = await getBookCacheDetailedStats(bookId);
      setCacheStatus(status);
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

  /** 缓存全书到客户端（文字 + 当前音色语音预合成） */
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

      // ⭐ 同步触发当前音色的后台预合成（静默，不阻塞 UI）
      try {
        await axios.post(`/api/books/${bookId}/tts-generate`, {
          voice: ttsPlayerRef.current?.getVoice?.() || ttsVoice,
          speed: ttsSpeed,
        });
      } catch { /* 预合成触发失败不影响主流程 */ }

      await checkCacheStatus();
      await loadServerStats();
    } catch (err) {
      console.warn('缓存全书失败:', err);
    } finally {
      setCachingInProgress(false);
    }
  }, [bookId, book, chapters, checkCacheStatus, loadServerStats, ttsSpeed, ttsVoice]);

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

  /** 清除所有缓存 */
  const handleClearCache = useCallback(async () => {
    if (!bookId) return;
    try {
      await clearBookCache(bookId);
      setCacheStatus(null);
    } catch (err) {
      console.warn('清除缓存失败:', err);
    }
  }, [bookId]);

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
  useEffect(() => { saveReaderPrefs({ paragraphSpacing }); }, [paragraphSpacing]);
  useEffect(() => { saveReaderPrefs({ letterSpacing }); }, [letterSpacing]);
  useEffect(() => { saveReaderPrefs({ firstLineIndent }); }, [firstLineIndent]);

  // Separate effect for EPUB loading — waits for DOM (readerRef) to be ready
  useEffect(() => {
    if (!book || book.format !== 'epub') return;
    loadEpub(book);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

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
        await loadChapterContent(targetChapter, undefined, isEpub);
        // 恢复精确滚动位置（使用保存的 pageIndex）
        // ⭐ 不再使用 requestAnimationFrame，改用 useEffect 在内容渲染完成后恢复
        if (savedProgress?.pageIndex != null && bookData.format !== 'epub') {
          const restorePct = savedProgress.pageIndex / 10000;
          if (restorePct > 0) {
            setPendingScrollRestorePct(restorePct);
          }
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
      // TTS 进度在用户点击「朗读」时处理，进入书籍时不保存

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
    } catch (err: any) {
      setError('加载章节内容失败');
      setChapterLoading(false);
    }
  };

  // Debounced progress save

  /** 预加载后续3个章节内容，实现滚动到底无缝过渡 */
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
      if (epubTextScrollRef.current) epubTextScrollRef.current.scrollTop = 0;
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

  /** 保存 TTS 播放进度（全书百分比） */
  const saveTtsProgress = useCallback((chapterId: string, segmentIndex: number, _chapterPct: number) => {
    // 转换为全书百分比：(当前章节索引 + 章节内进度) / 总章节数
    const cIdx = chapters.findIndex(c => c.id === chapterId);
    const total = chapters.length;
    const bookPct = cIdx >= 0 && total > 0
      ? (cIdx + _chapterPct) / total
      : _chapterPct;
    // ⭐ 同时保存当前的滚动位置 pageIndex，避免 TTS 进度覆盖后 scroll 恢复丢失
    const container = epubTextScrollRef.current || txtScrollRef.current;
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
          const container = epubTextScrollRef.current || txtScrollRef.current;
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
    });

    // ⭐ 重启进度保存定时器（当前组件实例的上下文）
    startTtsProgressSaver(bookId, currentChapter.id, currentChapter?.title || '', player);
  }, [bookId, currentChapter, loading, chapters, preloadNextChapters, startTtsProgressSaver]);

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

      // ⭐ 设置音色
      if (ttsVoice) player.setVoice(ttsVoice);

      // ⭐ 触发后台预合成：当前章节 + 后续 10 章或 50%（低优先级、非阻塞）
      try {
        const totalCh = chapters.length;
        const currentOrder = currentChapter?.order || 1;
        const remaining = totalCh - currentOrder;
        const chaptersToGen = Math.min(
          Math.max(10, Math.ceil(remaining * 0.5)),
          remaining,
        );
        if (chaptersToGen > 0) {
          axios.post(`/api/books/${bookId}/tts-generate`, {
            voice: ttsVoice,
            speed: ttsSpeed,
            chapterCount: chaptersToGen,
          }).catch(() => {});
        }
      } catch { /* 预合成触发失败不影响主流程 */ }

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
      });

      // ⭐ 从 localStorage 读取语音设置
      const savedVoice = (() => {
        try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
      })();
      if (savedVoice && savedVoice !== ttsVoice) {
        setTtsVoice(savedVoice);
        player.setVoice(savedVoice);
      }
      // ⭐ 从 localStorage 读取"实时合成模式"开关（设置页可配置）
      const noCachePref = (() => {
        try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; }
      })();
      await player.init({
        speed: ttsSpeed,
        voice: ttsVoice,
        noCache: noCachePref,
        // ⭐ 传入书籍信息用于 Media Session 锁屏封面 + 全局播放状态
        bookId,
        bookTitle: book?.title || '',
        bookCoverUrl: book ? `/api/books/${bookId}/cover` : '',
      });
      player.setVolume(ttsVolume);

      // 文本已是纯文本（EPUB 已由 getCurrentChapterText 返回 txtContent，非原始 HTML）
      await player.load(text, false);

      // Start periodic TTS progress saving (also persists to localStorage)
      startTtsProgressSaver(bookId, currentChapter.id, currentChapter?.title || '', player);

      // ⭐ 方案2b：先 play() 再 jumpToSegment — 避免 play() 重置 currentIndex
      await player.play();

      // ⭐ 恢复 TTS 位置：play() 完成后跳转到上次保存的分段
      const savedPos = savedTtsProgressRef.current;
      if (savedPos && savedPos.chapterId === currentChapter?.id && savedPos.segmentIndex >= 0) {
        await player.jumpToSegment(savedPos.segmentIndex);
      }
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

  /** 快退10秒 */
  const handleSkipBackward = useCallback(() => {
    const player = ttsPlayerRef.current;
    if (!player || player.getState() === 'idle') return;
    handleTTSSeek(Math.max(0, ttsProgress - 0.1));
  }, [ttsProgress, handleTTSSeek]);

  /** 快进10秒 */
  const handleSkipForward = useCallback(() => {
    const player = ttsPlayerRef.current;
    if (!player || player.getState() === 'idle') return;
    handleTTSSeek(Math.min(1, ttsProgress + 0.1));
  }, [ttsProgress, handleTTSSeek]);

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
  // ⭐ 在 TXT 内容渲染完成后恢复滚动位置（修复 requestAnimationFrame 时机不对的问题）
  useEffect(() => {
    if (pendingScrollRestorePct == null) return;
    // 使用 requestAnimationFrame 确保一次重绘后再恢复
    const raf = requestAnimationFrame(() => {
      const container = epubTextScrollRef.current || txtScrollRef.current;
      if (container && pendingScrollRestorePct > 0) {
        container.scrollTop = pendingScrollRestorePct * (container.scrollHeight - container.clientHeight);
      }
      setPendingScrollRestorePct(null);
    });
    return () => cancelAnimationFrame(raf);
  }, [txtContent, pendingScrollRestorePct]);
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
          <div className="flex-1 flex overflow-hidden relative" onClick={handleTapReader}>
        {/* TOC Sidebar */}
        {showToc && (
          <div onClick={(e) => e.stopPropagation()} className="w-64 sm:w-72 overflow-y-auto absolute sm:relative z-20 inset-y-0 left-0 shadow-lg sm:shadow-none" style={{background: 'var(--color-bg-card)', borderRight: '0.5px solid var(--color-border)'}}>
            <div className="p-3 font-semibold text-sm" style={{borderBottom: '0.5px solid var(--color-border)'}}>
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
            className="flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto overflow-y-auto reading-container"
            data-p-spacing={paragraphSpacing}
            data-l-spacing={letterSpacing}
            data-first-indent={firstLineIndent}
          >
            {(displayChapter || currentChapter) && (
              <div className="mb-4">
                <h2 className="text-xl font-bold" style={{ color: 'var(--color-text)' }}>
                  {(displayChapter || currentChapter)!.title}
                </h2>
              </div>
            )}
            <div
              style={{
                color: 'var(--color-text)',
                fontSize: `${fontSize}px`,
                fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
                letterSpacing: `${letterSpacing}em`,
              }}
            >
              {chapterLoading ? (
                <div className="flex items-center justify-center py-12">
                  <span className="animate-pulse" style={{ color: 'var(--color-text-muted)' }}>加载中...</span>
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
                  <span style={{ color: 'var(--color-text-muted)' }}>暂无内容</span>
                </div>
              )}
            </div>
            {/* 底部哨兵元素：用于 IntersectionObserver 检测滚动到末尾 */}
            <div ref={bottomSentinelRef} className="h-4" />
            {/* 底部章节导航（用户手动跳转，作为跨章节滚动失效时的备选方案） */}
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
                  ? `${chapters.findIndex((c) => c.id === currentChapter.id) + 1} / ${chapters.length}`
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
            ref={txtScrollRef}
            className={`flex-1 px-3 sm:px-6 py-3 sm:py-4 max-w-3xl mx-auto ${readingMode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}
            data-p-spacing={paragraphSpacing}
            data-l-spacing={letterSpacing}
            data-first-indent={firstLineIndent}
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
                fontFamily: fontFamily === 'sans' ? '-apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' : fontFamily === 'serif' ? '"PingFang SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif' : '"JetBrains Mono", "Fira Code", monospace',
                lineHeight,
                letterSpacing: `${letterSpacing}em`,
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
              <div className="pointer-events-auto glass-bar rounded-t-2xl shadow-2xl max-h-[55vh] overflow-y-auto mx-auto max-w-3xl animate-slide-up" onClick={(e) => e.stopPropagation()}>
                  <div className="p-4 space-y-3">
                    {/* ── 第一行：返回 + 书名 + 目录 ── */}
                    <div className="flex items-center justify-between">
                      <button
                        onClick={() => navigate('/')}
                        className="flex items-center gap-1 text-sm rounded-full px-3 py-1.5 transition-all duration-200 tap-active"
                      style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><polyline points="15 18 9 12 15 6"/></svg> 返回
                      </button>
                      <h2 className="text-sm font-medium truncate max-w-[50%] text-center"
                        style={{ color: 'var(--color-text-secondary)' }}>
                        {book?.title || ''}
                      </h2>
                      <button
                        onClick={() => { setShowToc(v => !v); setShowUi(false); }}
                        className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all duration-200 tap-active`}
                        style={{
                          background: showToc ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                          color: showToc ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                        目录
                      </button>
                    </div>
                    <div style={{ borderTop: '0.5px solid var(--color-border)' }} />
                    
                    {/* ── 朗读/缓存 ── */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={ttsState !== 'idle' ? handleStopTTS : handleStartTTS}
                        disabled={ttsState === 'loading'}
                        className={`text-xs px-3 py-1.5 rounded-full font-medium transition-all duration-200 tap-active`}
                        style={{
                          background: ttsState !== 'idle' ? 'var(--color-accent-2-subtle)' : 'var(--color-bg-alt)',
                          color: ttsState !== 'idle' ? 'var(--color-accent-2)' : 'var(--color-text-secondary)',
                        }}
                      >
                        {ttsState === 'playing' ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> 朗读中</> : ttsState === 'paused' ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> 已暂停</> : ttsState === 'loading' ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 animate-spin"><circle cx="12" cy="12" r="10" opacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10"/></svg> 加载中</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> 朗读</>}
                      </button>
                      <button
                        onClick={handleCacheCurrentChapter}
                        disabled={cachingInProgress}
                        className="text-xs px-3 py-1.5 rounded-full transition-all duration-200 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 缓存本章
                      </button>
                      <button
                        onClick={handleCacheFullBook}
                        disabled={cachingInProgress}
                        className="text-xs px-3 py-1.5 rounded-full transition-all duration-200 tap-active"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> 全书缓存
                      </button>
                      {cacheStatus && cacheStatus.chapterCount > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-center gap-2 flex-wrap text-xs">
                                                          <span style={{ color: 'var(--color-accent-2)' }} title="已缓存文字章节">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> {cacheStatus.chapterCount}/{cacheStatus.totalChapters}章 ({formatBytes(cacheStatus.chapterBytes)})
                            </span>
                            {cacheStatus.audioSegmentCount > 0 && (
                              <span className="" title="已缓存语音段"
                                style={{ color: '#AF52DE' }}>
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> {cacheStatus.audioSegmentCount}段 ({formatBytes(cacheStatus.audioBytes)})
                              </span>
                            )}
                              <span style={{ color: 'var(--color-text-muted)' }}>
                                合计 {formatBytes(cacheStatus.totalBytes)}
                              </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={handleClearTextCache}
                              className="text-[10px] px-2 py-1 rounded-full text-orange-500 bg-orange-50 dark:bg-orange-900/20 hover:bg-orange-100 dark:hover:bg-orange-900/40 transition-all duration-150 tap-active"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 清除文字
                            </button>
                            {cacheStatus.audioSegmentCount > 0 && (
                              <button
                                onClick={handleClearAudioCache}
                                className="text-[10px] px-2 py-1 rounded-full text-purple-500 bg-purple-50 dark:bg-purple-900/20 hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-all duration-150 tap-active"
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> 清除语音
                              </button>
                            )}
                            <button
                              onClick={handleClearCache}
                              className="text-[10px] px-2 py-1 rounded-full text-red-500 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 transition-all duration-150 tap-active"
                            >
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> 清除全部
                            </button>
                          </div>
                        </div>
                      )}
                    </div>

                    <div style={{ borderTop: '0.5px solid var(--color-border)' }} />

                    {/* ── 字号 ── */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>字号</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setFontSize(Math.max(12, fontSize - 2))}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all duration-150 tap-icon"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >A-</button>
                      <span className="text-sm w-8 text-center font-medium" style={{ color: 'var(--color-text)' }}>{fontSize}</span>
                      <button
                        onClick={() => setFontSize(Math.min(36, fontSize + 2))}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-all duration-150 tap-icon"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >A+</button>
                    </div>
                  </div>

                  {/* ── 行距 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>行距</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setLineHeight(Math.max(1.2, lineHeight - 0.2))}
                        disabled={lineHeight <= 1.2}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs disabled:opacity-40 transition-colors"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >行-</button>
                      <span className="text-xs w-8 text-center" style={{ color: 'var(--color-text-muted)' }}>{lineHeight.toFixed(1)}</span>
                      <button
                        onClick={() => setLineHeight(Math.min(3.0, lineHeight + 0.2))}
                        disabled={lineHeight >= 3.0}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs disabled:opacity-40 transition-colors"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >行+</button>
                    </div>
                  </div>

                  {/* ── 段落间距 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>段距</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setParagraphSpacing(Math.max(0.2, +(paragraphSpacing - 0.1).toFixed(1)))}
                        disabled={paragraphSpacing <= 0.2}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs disabled:opacity-40 transition-colors"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >段-</button>
                      <span className="text-xs w-8 text-center" style={{ color: 'var(--color-text-muted)' }}>{paragraphSpacing.toFixed(1)}</span>
                      <button
                        onClick={() => setParagraphSpacing(Math.min(2.0, +(paragraphSpacing + 0.1).toFixed(1)))}
                        disabled={paragraphSpacing >= 2.0}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs disabled:opacity-40 transition-colors"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >段+</button>
                    </div>
                  </div>

                  {/* ── 首行缩进 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>首行缩进</span>
                    <button
                      onClick={() => setFirstLineIndent(!firstLineIndent)}
                      className={`relative w-[42px] h-[24px] rounded-full transition-all duration-200 ${firstLineIndent ? '' : 'opacity-50'}`}
                      style={{ background: firstLineIndent ? 'var(--color-primary)' : 'var(--color-border)' }}
                    >
                      <div className={`absolute top-[2px] w-[20px] h-[20px] rounded-full bg-white shadow-sm transition-all duration-200 ${firstLineIndent ? 'left-[20px]' : 'left-[2px]'}`} />
                    </button>
                  </div>

                  <div style={{ borderTop: '0.5px solid var(--color-border)' }} />

                  {/* ── 字体 + 模式 ── */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>样式</span>
                    <div className="flex items-center gap-2">
                      <select
                        value={fontFamily}
                        onChange={(e) => setFontFamily(e.target.value as 'sans' | 'serif' | 'mono')}
                        className="text-xs px-2 py-1.5 rounded-lg border-none cursor-pointer outline-none"
                        style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                      >
                        <option value="sans">无衬线</option>
                        <option value="serif">衬线</option>
                        <option value="mono">等宽</option>
                      </select>
                      <button
                        onClick={() => { setReadingMode(prev => prev === 'scroll' ? 'paginated' : 'scroll'); setPageIndex(0); }}
                        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all duration-200 tap-active`}
                        style={{
                          background: readingMode === 'paginated' ? 'var(--color-primary-subtle)' : 'var(--color-bg-alt)',
                          color: readingMode === 'paginated' ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                        }}
                      >
                        {readingMode === 'paginated' ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> 翻页</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> 滚动</>}
                      </button>
                    </div>
                  </div>


                  {ttsState !== 'idle' && (
                    <div className="space-y-2 pt-1">
                      {/* ── 音色选择器 ── */}
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>音色</span>
                        <select
                          value={ttsVoice}
                          onChange={(e) => {
                            const v = e.target.value;
                            setTtsVoice(v);
                            try { localStorage.setItem('ireader_tts_voice', v); } catch {}
                            const player = ttsPlayerRef.current;
                            if (player) player.setVoice(v);
                          }}
                          className="text-xs px-2 py-1.5 rounded-lg border-none cursor-pointer max-w-[180px] outline-none"
                          style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                        >
                          <option value="zh-CN-XiaoxiaoNeural">Xiaoxiao（女）</option>
                          <option value="zh-CN-YunxiNeural">Yunxi（男）</option>
                          <option value="zh-CN-YunyangNeural">Yunyang（男·新闻）</option>
                          <option value="zh-CN-XiaochenNeural">Xiaochen（女·亲切）</option>
                          <option value="zh-CN-XiaomengNeural">Xiaomeng（女·活泼）</option>
                        </select>
                      </div>
                      <div className="border-t border-gray-100 dark:border-gray-700" />
                      <div className="flex items-center justify-between">
                        <span className="text-xs shrink-0" style={{ color: 'var(--color-text-secondary)' }}>朗读控制</span>
                        <div className="flex items-center justify-evenly flex-1 gap-0.5">
                          {/* 播放控制 */}
                          <div className="flex items-center gap-1">
                            {ttsState === 'playing' ? (
                              <button onClick={handlePauseTTS} className="w-8 h-8 rounded-full" style={{background: 'var(--color-primary)'}} title="暂停"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg></button>
                            ) : (
                              <button onClick={ttsState === 'paused' ? handleResumeTTS : handleStartTTS} className="w-8 h-8 rounded-full" style={{background: 'var(--color-primary)'}} title={ttsState === 'paused' ? '继续' : '播放'}><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>
                            )}
                            <button onClick={handleStopTTS} className="w-8 h-8 rounded-full" style={{background: 'var(--color-bg-alt)'}} title="停止"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
                          </div>
                          {/* 进度 */}
                          <span className="text-xs min-w-[2.5rem]" style={{ color: 'var(--color-text-muted)' }}>{Math.round(ttsProgress * 100)}%</span>
                          {/* 快进/快退 */}
                          <div className="flex items-center gap-1">
                            <button onClick={handleSkipBackward} className="w-8 h-8 rounded-full" style={{background: 'var(--color-bg-alt)'}} title="后退10秒"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg></button>
                            <button onClick={handleSkipForward} className="w-8 h-8 rounded-full" style={{background: 'var(--color-bg-alt)'}} title="快进10秒"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg></button>
                          </div>
                          {/* 睡眠定时 */}
                          <button
                            onClick={() => {
                              const opts: (number | null)[] = [null, 15, 30, 60];
                              const idx = opts.indexOf(sleepTimerMinutes);
                              const next = opts[(idx + 1) % opts.length];
                              handleSetSleepTimer(next);
                            }}
                            className={`text-xs px-2 py-1 rounded transition-all duration-200 tap-active`}
                            style={{
                              background: sleepTimerMinutes ? 'var(--color-accent-2-subtle)' : 'var(--color-bg-alt)',
                              color: sleepTimerMinutes ? 'var(--color-accent-2)' : 'var(--color-text-secondary)',
                            }}
                          >
                            {sleepTimerMinutes ? <span className="inline-flex items-center gap-1"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>{sleepTimerMinutes}分</span> : <span className="inline-flex items-center gap-1"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>定时</span>}
                          </button>
                        </div>
                      </div>
                      {/* 进度条 — 可点击/拖拽 seek */}
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
                        {/* 拖拽手柄 */}
                        <div
                          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                          style={{ left: `calc(${Math.round(ttsProgress * 100)}% - 8px)` }}
                        />
                      </div>
                    </div>
                  )}

                  {/* ── 底部导航（仅保留章节进度信息，导航按钮移至浮动） ── */}
                  <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
                    <div className="flex items-center justify-center">
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        {currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1} / ${chapters.length}` : ''}
                      </span>
                    </div>
                    {book?.format === 'txt' && readingMode === 'paginated' && (
                      <div className="flex items-center justify-between mt-1">
                          <button
                            onClick={() => { if (pageIndex > 0) setPageIndex(i => i - 1); else goToPrevChapter(); }}
                            disabled={pageIndex === 0 && chapters.findIndex(c => c.id === currentChapter?.id) === 0}
                                                          className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                          ><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="15 18 9 12 15 6"/></svg> 上一页</button>
                        <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{pageIndex + 1} / {totalPages}</span>
                          <button
                            onClick={() => { if (pageIndex < totalPages - 1) setPageIndex(i => i + 1); else goToNextChapter(); }}
                            disabled={pageIndex >= totalPages - 1 && chapters.findIndex(c => c.id === currentChapter?.id) === chapters.length - 1}
                            className="text-xs px-3 py-1.5 rounded-lg disabled:opacity-40 transition-all duration-150 tap-active"
                            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
                          >下一页 <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block"><polyline points="9 18 15 12 9 6"/></svg></button>
                      </div>
                    )}
                  </div>

                  {/* ── 服务端统计 ── */}
                  {serverStats && (
                    <div className="pt-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
                      <div className="flex items-center gap-3 flex-wrap text-xs" style={{ color: 'var(--color-text-muted)' }}>
                        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg> 阅读 {Math.round(serverStats.readingPercentage * 100)}%</span>
                        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> {currentChapter ? `${chapters.findIndex(c => c.id === currentChapter.id) + 1}/${serverStats.totalChapters}` : `共${serverStats.totalChapters}`}章</span>
                        <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> 预合成 {Math.round((serverStats.voiceGenerationRate || 0) * serverStats.totalChapters)}/{serverStats.totalChapters}章</span>
                        {serverStats.ttsCacheCount !== undefined && serverStats.ttsCacheCount > 0 && (
                          <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> 语音缓存 {serverStats.ttsCacheCount}条</span>
                        )}
                        {serverStats.cachedChapters > 0 && (
                          <span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 inline-block align-text-bottom"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 内容缓存 {serverStats.cachedChapters}章{serverStats.cacheType ? `（${serverStats.cacheType === 'full_book' ? '全书' : '部分'}）` : ''}</span>
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
