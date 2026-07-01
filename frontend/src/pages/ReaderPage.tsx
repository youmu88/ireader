import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  getDefaultPlayer,
  destroyDefaultPlayer,
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

function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null);
  const [txtContent, setTxtContent] = useState<string>('');
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

  const [fontSize, setFontSize] = useState(initialPrefs.fontSize ?? 18);
  const [fontFamily, setFontFamily] = useState<'sans' | 'serif' | 'mono'>(initialPrefs.fontFamily ?? 'sans');
  const [lineHeight, setLineHeight] = useState(initialPrefs.lineHeight ?? 1.8);
  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsSpeed, setTtsSpeed] = useState(1.0);
  const [ttsVolume, setTtsVolume] = useState(() => {
    try { const v = localStorage.getItem('ireader_tts_volume'); return v ? parseFloat(v) : 1.0; } catch { return 1.0; }
  });
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [readingMode, setReadingMode] = useState<'scroll' | 'paginated'>(initialPrefs.readingMode ?? 'scroll');
  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [showEpubView, setShowEpubView] = useState(false); // toggle epubjs vs text view
  const [showTtsResumeBanner, setShowTtsResumeBanner] = useState(false); // show resume prompt
  const txtPageRef = useRef<HTMLDivElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const epubRef = useRef<any>(null);
  const renditionRef = useRef<any>(null);
  const progressSaveTimer = useRef<any>(null);
  const ttsProgressSaveTimer = useRef<any>(null);
  const ttsPlayerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const chaptersRef = useRef(chapters);
  const currentChapterRef = useRef(currentChapter);
  const prevShowEpubViewRef = useRef(showEpubView);
  const loadingNextChapterRef = useRef(false);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const goToNextChapterRef = useRef<((_fromAutoScroll?: boolean) => Promise<void>) | null>(null);
  const epubTextScrollRef = useRef<HTMLDivElement>(null);
  const txtScrollRef = useRef<HTMLDivElement>(null);
  const savedTtsProgressRef = useRef<{chapterId: string; segmentIndex: number; progress: number} | null>(null);
  /** Preloaded next-chapter contents for smooth scroll transitions */
  /** Track chapter IDs accumulated during auto-scroll for continuous reading */
  const accumulatedIdsRef = useRef<Set<string>>(new Set());
  /** Preloaded next-chapter contents for smooth scroll transitions */
  const preloadedChaptersRef = useRef<Map<string, {content: string}>>(new Map());
  /** Saved reading progress from API, consumed by loadEpub */
  const savedProgressRef = useRef<any>(null);
  /** Display chapter title — stays on original chapter during append mode */
  const [displayChapter, setDisplayChapter] = useState<Chapter | null>(null);

  // Load book and chapters
  useEffect(() => {
    if (!bookId) return;
    loadBook();
  }, [bookId]);
  // Load book and chapters
  useEffect(() => {
    if (!bookId) return;
    loadBook();
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
    try {
      setLoading(true);
      const [bookRes, chaptersRes] = await Promise.all([
        axios.get(`/api/books/${bookId}`),
        axios.get(`/api/books/${bookId}/chapters`),
      ]);
      const bookData = bookRes.data.data;
      setBook(bookData);
      const chaptersData = chaptersRes.data.data || [];
      setChapters(chaptersData);

      // ── 恢复阅读进度：尝试跳转到上次阅读的章节 ──
      let targetChapter = chaptersData[0];
      const isEpub = bookData.format === 'epub';
      try {
        const progRes = await axios.get(`/api/books/${bookId}/progress`);
        const progress = progRes.data.data;
        if (progress?.chapterId) {
          const saved = chaptersData.find((c: Chapter) => c.id === progress.chapterId);
          if (saved) {
            targetChapter = saved;
            savedProgressRef.current = progress; // 供 loadEpub 恢复精确位置
          }
        }
      } catch { /* 无保存的进度 */ }

      if (targetChapter) {
        await loadChapterContent(targetChapter, undefined, isEpub);
        // 首次加载后立即预加载后续章节
        preloadNextChapters(targetChapter.id);
      }
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

      // Track location changes for progress saving + auto-advance to next chapter
      rendition.on('relocated', (location: any) => {
        const cfi = location?.start?.cfi;
        if (cfi) {
          debounceSaveProgress({ cfi, percentage: location?.start?.percentage || 0 });
        }
        // 自动跳转下一章：检测到当前 spine item 接近末尾（比例 > 95%）时自动跳转
        const start = location?.start;
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
    return html
      .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_m: any, n: string) => String.fromCharCode(parseInt(n, 10)))
      .replace(/\s+/g, ' ')
      .trim();
  }, []);

  // Load chapter content
  const loadChapterContent = async (chapter: Chapter, _offset?: number, _isEpub?: boolean, _append?: boolean) => {
    try {
      setCurrentChapter(chapter);
      // append 模式下不更新显示标题（保持显示原始章节名，避免标题跳跃）
      if (!_append) {
        setDisplayChapter(chapter);
      }

      // 获取章节内容（优先使用预加载内容）
      let content: string;
      const preloaded = preloadedChaptersRef.current.get(chapter.id);
      if (preloaded) {
        content = preloaded.content;
        preloadedChaptersRef.current.delete(chapter.id);
      } else {
        // append 模式下不显示「加载中...」闪烁：保持现有内容可见，静默加载
        if (!_append) setChapterLoading(true);
        const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
        const rawContent = res.data.data?.content || '';
        const isEpub = _isEpub ?? (book?.format === 'epub');
        content = isEpub ? stripHtml(rawContent) : rawContent;
        if (!_append) setChapterLoading(false);
      }

      // 追加模式（滚动自动加载）：内容接在已有内容后面，实现平滑连续阅读
      if (_append && !accumulatedIdsRef.current.has(chapter.id)) {
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(prev => {
          const separator = '\n\n' + chapter.title + '\n' + '─'.repeat(30) + '\n\n';
          return prev + separator + content;
        });
      } else {
        // 手动跳转：替换内容，重置累积记录
        accumulatedIdsRef.current.clear();
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(content);
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
              preloadedChaptersRef.current.set(next.id, {
                content: isEpub ? stripHtml(rawContent) : rawContent,
              });
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

    // For EPUB: also navigate epubjs rendition
    if (book?.format === 'epub' && renditionRef.current && chapter.href) {
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

  // ════════════════════════════════════════════
  // TTS 朗读控制
  // ════════════════════════════════════════════

  /** 获取当前章节的纯文本内容（用于 TTS 朗读） */
  const getCurrentChapterText = useCallback(async (): Promise<string> => {
    if (!currentChapter || !bookId || !book) return '';

    if (book.format === 'txt') {
      return txtContent;
    }

    // EPUB: 从后端获取章节内容（HTML 格式，需去标签）
    try {
      const res = await axios.get(`/api/books/${bookId}/chapters/${currentChapter.id}/content`);
      const rawContent = res.data.data?.content;
      if (rawContent) return rawContent;
    } catch { /* fallback */ }

    // 尝试从 epubjs 获取当前显示内容
    try {
      if (renditionRef.current) {
        const contents = renditionRef.current.getContents();
        if (contents?.length > 0) {
          const bodyText = contents[0].document?.body?.innerText;
          if (bodyText) return bodyText;
        }
      }
    } catch { /* fallback */ }

    return '';
  }, [currentChapter, bookId, book, txtContent]);

  /** 保存 TTS 播放进度 */
  const saveTtsProgress = useCallback((chapterId: string, segmentIndex: number, progress: number) => {
    debounceSaveProgress({
      chapterId,
      textOffset: segmentIndex,
      percentage: progress,
    });
  }, [debounceSaveProgress]);

  /** 启动 TTS 进度定期保存 */
  const startTtsProgressSaver = useCallback((chapterId: string, player: any) => {
    if (ttsProgressSaveTimer.current) clearInterval(ttsProgressSaveTimer.current);
    ttsProgressSaveTimer.current = setInterval(() => {
      const idx = player.getCurrentIndex();
      const total = player.getTotalChunks();
      if (idx >= 0 && total > 0) {
        const pct = (idx + 1) / total;
        saveTtsProgress(chapterId, idx, pct);
      }
    }, TTS_PROGRESS_SAVE_INTERVAL);
  }, [saveTtsProgress]);

  /** 开始 TTS 朗读 */
  const handleStartTTS = useCallback(async () => {
    if (!bookId || !currentChapter) return;

    const text = await getCurrentChapterText();
    if (!text) return;

    try {
      const player = getDefaultPlayer();
      ttsPlayerRef.current = player;

      player.setCallbacks({
        onStateChange: (s) => setTtsState(s),
        onSegmentPlay: (idx, _total) => {
          setTtsSegmentText(player.getCurrentSegmentText());
          setActiveSegmentIndex(idx);
        },
        onProgress: (p) => setTtsProgress(p),
        onError: (err) => console.warn('TTS 朗读错误:', err),
        onEnd: () => {
          setTtsProgress(1);
          // Save final progress
          if (currentChapter) saveTtsProgress(currentChapter.id, -1, 1);
          if (ttsProgressSaveTimer.current) clearInterval(ttsProgressSaveTimer.current);
          // 自动下一章（有累积内容时使用追加模式，保持连续滚动）
          if (accumulatedIdsRef.current.size > 0) {
            goToNextChapter(true);
          } else {
            goToNextChapter();
          }
        },
      });

      await player.init({
        speed: ttsSpeed,
      });
      player.setVolume(ttsVolume);

      const isHtml = book?.format === 'epub';
      await player.load(text, isHtml);

      // Start periodic TTS progress saving
      startTtsProgressSaver(currentChapter.id, player);

      await player.play();
    } catch (err) {
      console.error('TTS 启动失败:', err);
    }
  }, [bookId, currentChapter, book, ttsSpeed, getCurrentChapterText, goToNextChapter, saveTtsProgress, startTtsProgressSaver]);

  /** 暂停 TTS */
  const handlePauseTTS = useCallback(() => {
    ttsPlayerRef.current?.pause();
  }, []);

  /** 恢复 TTS */
  const handleResumeTTS = useCallback(() => {
    ttsPlayerRef.current?.resume();
  }, []);

  /** 停止 TTS */
  const handleStopTTS = useCallback(() => {
    // Save current TTS position before stopping
    if (ttsPlayerRef.current && currentChapter) {
      const idx = ttsPlayerRef.current.getCurrentIndex();
      const total = ttsPlayerRef.current.getTotalChunks();
      if (idx >= 0 && total > 0) {
        saveTtsProgress(currentChapter.id, idx, (idx + 1) / total);
      }
    }
    if (ttsProgressSaveTimer.current) {
      clearInterval(ttsProgressSaveTimer.current);
      ttsProgressSaveTimer.current = null;
    }
    ttsPlayerRef.current?.stop();
    setTtsState('idle');
    setTtsProgress(0);
    setTtsSegmentText('');
    setActiveSegmentIndex(-1);
  }, [currentChapter, saveTtsProgress]);

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
  useEffect(() => {
    if (!currentChapter || !chapters.length) return;
    const saved = savedTtsProgressRef.current;
    if (saved && saved.progress > 0 && saved.progress < 1) {
      setShowTtsResumeBanner(true);
    }
  }, [currentChapter, chapters]);

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

  // ── Fix Bug 1: 从「原版」切换到「文本」时重新加载当前章节内容 ──
  useEffect(() => {
    const wasOriginal = prevShowEpubViewRef.current === true;
    prevShowEpubViewRef.current = showEpubView;

    if (wasOriginal && !showEpubView && book?.format === 'epub') {
      // 从 epubjs 视图切回纯文本视图 → 获取当前章节并加载内容
      if (renditionRef.current) {
        const location = (renditionRef.current as any).currentLocation?.();
        const href = location?.start?.href;
        if (href) {
          const matched = chapters.find((c: Chapter) => c.href && href.startsWith(c.href));
          if (matched) {
            loadChapterContent(matched);
          }
        }
      }
    }
  }, [showEpubView]);

  // ── Fix Bug 2: 滚动到底部时自动加载下一章 ──
  useEffect(() => {
    if (readingMode !== 'scroll') return;

    // 找到当前可见的滚动容器（EPUB 文本视图 或 TXT 视图，只存在一个）
    const scrollContainer = epubTextScrollRef.current || txtScrollRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!scrollContainer || !sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingNextChapterRef.current) return;
        const idx = chaptersRef.current.findIndex(
          (c: Chapter) => c.id === currentChapterRef.current?.id
        );
        if (idx < 0 || idx >= chaptersRef.current.length - 1) return;

        // 动态加载门控：仅在章节实际加载完成前阻止重复触发
        // 加载完成后立即允许下一触发，无需等待固定超时
        loadingNextChapterRef.current = true;
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
      const idx = chapters.findIndex(c => c.id === currentChapter.id);
      debounceSaveProgress({
        chapterId: currentChapter.id,
        percentage: (idx + 1) / chapters.length,
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
      // 停止 TTS
      if (ttsPlayerRef.current) {
        destroyDefaultPlayer();
        ttsPlayerRef.current = null;
      }
    };
  }, [currentChapter]);

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
    <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
      {/* Top Bar */}
      <ReaderTopBar
        title={book?.title || ''}
        onBack={() => {
          handleStopTTS();
          navigate('/');
        }}
        onToggleToc={() => setShowToc(!showToc)}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        fontFamily={fontFamily}
        onFontFamilyChange={setFontFamily}
        lineHeight={lineHeight}
        onLineHeightChange={setLineHeight}
        ttsState={ttsState}
        ttsActive={ttsState !== 'idle'}
        onStartTTS={handleStartTTS}
        onStopTTS={handleStopTTS}
        readingMode={readingMode}
        onToggleReadingMode={() => {
          setReadingMode(prev => prev === 'scroll' ? 'paginated' : 'scroll');
          setPageIndex(0);
        }}
        bookFormat={book?.format}
        showEpubView={showEpubView}
        onToggleEpubView={() => setShowEpubView(v => !v)}
      />

      {/* Reader Content */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* TOC Sidebar */}
        {showToc && (
          <div className="w-72 border-r border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 overflow-y-auto">
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
            className="flex-1 px-6 py-4 max-w-3xl mx-auto overflow-y-auto"
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
              ) : txtContent ? (
                ttsState !== 'idle' && activeSegmentIndex >= 0 ? (
                  <div className="whitespace-pre-wrap">
                    {renderHighlightedContent(txtContent)}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{txtContent}</div>
                )
              ) : (
                <div className="flex items-center justify-center py-12">
                  <span className="text-gray-400">暂无内容</span>
                </div>
              )}
            </div>
            {/* 底部哨兵元素：用于 IntersectionObserver 检测滚动到末尾 */}
            <div ref={bottomSentinelRef} className="h-4" />
          </div>
        )}

        {/* TTS Resume Banner */}
        {showTtsResumeBanner && ttsState === 'idle' && savedTtsProgressRef.current && (
          <div className="absolute top-0 left-0 right-0 z-10 mx-auto max-w-xl mt-2">
            <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 rounded-lg px-4 py-2 flex items-center justify-between shadow-sm">
              <span className="text-sm text-green-800 dark:text-green-200">
                🔊 上次播放到 {Math.round(savedTtsProgressRef.current.progress * 100)}%
                {savedTtsProgressRef.current.chapterId !== currentChapter?.id ? '（不同章节）' : ''}
              </span>
              <div className="flex gap-2">
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
                  className="text-xs px-3 py-1 rounded bg-green-600 text-white hover:bg-green-700"
                >
                  继续播放
                </button>
                <button
                  onClick={() => setShowTtsResumeBanner(false)}
                  className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300"
                >
                  关闭
                </button>
              </div>
            </div>
          </div>
        )}

        {/* TXT Reader */}
        {book?.format === 'txt' && (
          <div
            ref={txtScrollRef}
            className={`flex-1 px-6 py-4 max-w-3xl mx-auto ${readingMode === 'scroll' ? 'overflow-y-auto' : 'overflow-hidden flex flex-col'}`}
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
            <div className="mx-auto max-w-3xl px-6 pb-16">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                <p className="text-sm text-blue-800 dark:text-blue-200 line-clamp-2">
                  🔊 {ttsSegmentText}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── TTS 控制条 ── */}
      {ttsState !== 'idle' && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
          <div className="flex items-center gap-4 max-w-3xl mx-auto">
            {/* 播放控制 */}
            <div className="flex items-center gap-2">
              {ttsState === 'playing' ? (
                <button
                  onClick={handlePauseTTS}
                  className="w-9 h-9 rounded-full bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 transition-colors"
                  title="暂停"
                >
                  ⏸
                </button>
              ) : (
                <button
                  onClick={ttsState === 'paused' ? handleResumeTTS : handleStartTTS}
                  className="w-9 h-9 rounded-full bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 transition-colors"
                  title={ttsState === 'paused' ? '继续' : '播放'}
                >
                  ▶
                </button>
              )}
              <button
                onClick={handleStopTTS}
                className="w-9 h-9 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 flex items-center justify-center hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                title="停止"
              >
                ⏹
              </button>
            </div>

            {/* 进度条 */}
            <div className="flex-1">
              <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                <div
                  className="bg-blue-500 h-full rounded-full transition-all duration-300"
                  style={{ width: `${Math.round(ttsProgress * 100)}%` }}
                />
              </div>
            </div>

            {/* 进度文字 */}
            <span className="text-xs text-gray-500 dark:text-gray-400 min-w-[3rem] text-right">
              {Math.round(ttsProgress * 100)}%
            </span>

            {/* 语速控制 */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleTTSSpeedChange(Math.max(0.5, ttsSpeed - 0.1))}
                className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40"
                disabled={ttsSpeed <= 0.5}
              >
                慢
              </button>
              <span className="text-xs text-gray-500 dark:text-gray-400 min-w-[2.5rem] text-center">
                {ttsSpeed.toFixed(1)}x
              </span>
              <button
                onClick={() => handleTTSSpeedChange(Math.min(2.0, ttsSpeed + 0.1))}
                className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-40"
                disabled={ttsSpeed >= 2.0}
              >
                快
              </button>
            </div>

            {/* 音量控制 */}
            <div className="flex items-center gap-1">
              <span className="text-xs text-gray-500 dark:text-gray-400 mr-1" title="音量">🔊</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={ttsVolume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-20 h-1.5 rounded-full accent-blue-500 cursor-pointer"
              />
            </div>
          </div>
        </div>
      )}

      {/* Bottom Bar (TXT only) */}
      {book?.format === 'txt' && readingMode === 'scroll' && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2 flex items-center justify-between text-sm">
          <button
            onClick={goToPrevChapter}
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
            onClick={() => goToNextChapter()}
            disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter.id) === chapters.length - 1}
            className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            下一章 →
          </button>
        </div>
      )}
      {/* TXT 翻页模式底栏 */}
      {book?.format === 'txt' && readingMode === 'paginated' && (
        <div className="border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2 flex items-center justify-between text-sm">
          <button
            onClick={() => {
              if (pageIndex > 0) setPageIndex((i) => i - 1);
              else goToPrevChapter();
            }}
            disabled={pageIndex === 0 && chapters.findIndex((c) => c.id === currentChapter?.id) === 0}
            className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            ← 上一页
          </button>
          <span className="text-gray-500 dark:text-gray-400">
            {`${pageIndex + 1} / ${totalPages} · 章 ${currentChapter ? chapters.findIndex((c) => c.id === currentChapter.id) + 1 : '-'}/${chapters.length}`}
          </span>
          <button
            onClick={() => {
              if (pageIndex < totalPages - 1) setPageIndex((i) => i + 1);
              else goToNextChapter();
            }}
            disabled={pageIndex >= totalPages - 1 && chapters.findIndex((c) => c.id === currentChapter?.id) === chapters.length - 1}
            className="px-3 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 disabled:opacity-40 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            下一页 →
          </button>
        </div>
      )}
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
  bookFormat,
  showEpubView,
  onToggleEpubView,
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
}) {
  const ttsLabel = ttsState === 'playing' ? '🔊 朗读中' :
    ttsState === 'paused' ? '🔇 已暂停' :
    ttsState === 'loading' ? '⏳ 加载中' :
    '🔊 朗读本章';

  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-blue-600 dark:text-blue-400 hover:underline text-sm">
          ← 返回书架
        </button>
        <h1 className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate max-w-xs">
          {title}
        </h1>
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
        {onToggleToc && (
          <button
            onClick={onToggleToc}
            className="text-xs px-2 py-1 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600"
          >
            📑 目录
          </button>
        )}
        {/* EPUB 视图切换 */}
        {bookFormat === 'epub' && onToggleEpubView && (
          <button
            onClick={onToggleEpubView}
            className={`text-xs px-2 py-1 rounded transition-colors ${
              showEpubView
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
            }`}
            title={showEpubView ? '切换到纯文本视图' : '切换到原版渲染'}
          >
            {showEpubView ? '📄 文本' : '📖 原版'}
          </button>
        )}
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
