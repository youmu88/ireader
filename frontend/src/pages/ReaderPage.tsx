import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { getCachedChapterContent } from '../services/offlineCacheService';
import axios from 'axios';
import EpubViewer from '../components/EpubViewer';
import TxtReaderView, { type TxtReaderViewHandle } from '../components/TxtReaderView';
import { ReaderTopBar } from '../components/ReaderTopBar';
import { ReaderControlPanel } from '../components/ReaderControlPanel';
import { TocDrawer } from '../components/TocDrawer';
import { SearchOverlay } from '../components/SearchOverlay';
import { TtsOverlay } from '../components/TtsOverlay';
import { useReaderSettings } from '../reader/hooks/useReaderSettings';
import { useOfflineFallback } from '../reader/hooks/useOfflineFallback';
import { useProgressRestore } from '../reader/hooks/useProgressRestore';
import { useProgressPersistence } from '../reader/position/useProgressPersistence';
import { useReadingPosition } from '../reader/position/useReadingPosition';
import { useReaderInteraction } from '../interaction/useReaderInteraction';
import { useCacheManager } from '../reader/hooks/useCacheManager';
import { useTtsSession } from '../reader/hooks/useTtsSession';
import { getDefaultPlayer } from '../services/ttsPlayer';
import { useAuth } from '../contexts/AuthContext';
import { stripHtml } from '../reader/utils/stripHtml';
import { toast, confirm } from '../components/ui';
import type { Chapter } from '../reader/types';

interface Book {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
  status: 'processing' | 'ready' | 'failed';
}

function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { isOfflineMode, exitOfflineMode } = useAuth();
  const offlineFallback = useOfflineFallback();
  const progressRestore = useProgressRestore();
  const [book, setBook] = useState<Book | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const { position: readingPosition, setPosition, updatePosition } = useReadingPosition(null);
  const { saveImmediate, flush: flushProgress, syncVersion } = useProgressPersistence(readingPosition, { bookId, totalChapters: chapters.length });
  const [currentChapter, setCurrentChapter] = useState<Chapter | null>(null);
  const [txtContent, setTxtContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [, setChapterLoading] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = useReaderSettings();
  const { fontSize, setFontSize, fontFamily, setFontFamily, lineHeight, setLineHeight, letterSpacing, readingMode, setReadingMode } = settings;

  const [pageIndex, setPageIndex] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const charOffsetRatioRef = useRef<number>(0);
  const epubPageControlRef = useRef<{ prev: () => void; next: () => void } | null>(null);
  const epubChapterNavRef = useRef<((chapterIndex: number) => Promise<void>) | null>(null);
  const epubCfiRef = useRef<string | null>(null);
  const epubChapterRatioRef = useRef<number>(0);

  // ── 悬浮UI控制 ──
  const [showUi, setShowUi] = useState(false);
  const showUiRef = useRef(false);
  useEffect(() => { showUiRef.current = showUi; }, [showUi]);
  const [selectedText, setSelectedText] = useState('');
  const txtPageRef = useRef<HTMLDivElement>(null);

  const chaptersRef = useRef(chapters);
  const currentChapterRef = useRef(currentChapter);
  const loadingNextChapterRef = useRef(false);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const goToNextChapterRef = useRef<((_fromAutoScroll?: boolean) => Promise<void>) | null>(null);
  const goToPrevChapterRef = useRef<(() => Promise<void>) | null>(null);
  const navigateToChapterRef = useRef<((chapter: Chapter, _append?: boolean) => Promise<void>) | null>(null);
  const txtScrollRef = useRef<HTMLDivElement>(null);
  const txtReaderViewRef = useRef<TxtReaderViewHandle>(null);
  const currentBookIdRef = useRef<string | undefined>(bookId);
  const [pendingScrollRestorePct, setPendingScrollRestorePct] = useState<number | null>(null);
  const accumulatedIdsRef = useRef<Set<string>>(new Set());
  const preloadedChaptersRef = useRef<Map<string, { content: string }>>(new Map());
  const [displayChapter, setDisplayChapter] = useState<Chapter | null>(null);

  // ── 搜索浮层开关 ──
  const [showSearch, setShowSearch] = useState(false);
  const showSearchRef = useRef(false);
  useEffect(() => { showSearchRef.current = showSearch; }, [showSearch]);
  const showTocRef = useRef(false);
  useEffect(() => { showTocRef.current = showToc; }, [showToc]);

  // ── 章节预加载 ──
  const preloadNextChapters = useCallback(async (currentChapterId: string) => {
    if (!chapters.length) return;
    const idx = chapters.findIndex(c => c.id === currentChapterId);
    if (idx < 0) return;
    const isEpub = book?.format === 'epub';
    const preloadTasks = [];
    for (let i = 1; i <= 3; i++) {
      const next = chapters[idx + i];
      if (next && !preloadedChaptersRef.current.has(next.id)) {
        preloadTasks.push(
          axios.get(`/api/books/${bookId}/chapters/${next.id}/content`)
            .then(res => {
              const rawContent = res.data.data?.content || '';
              preloadedChaptersRef.current.set(next.id, { content: isEpub ? stripHtml(rawContent) : rawContent });
            })
            .catch(() => {})
        );
      }
    }
    await Promise.all(preloadTasks);
  }, [chapters, bookId, book]);

  // ── 章节导航 ──
  const navigateToChapter = async (chapter: Chapter, _append?: boolean) => {
    setShowToc(false);
    if (book?.format === 'epub') {
      const spineIndex = chapters.indexOf(chapter);
      if (spineIndex >= 0 && epubChapterNavRef.current) await epubChapterNavRef.current(spineIndex);
      await loadChapterContent(chapter, undefined, true);
    } else {
      await loadChapterContent(chapter, undefined, undefined, _append);
    }
    setPosition({ bookId: bookId!, chapterId: chapter.id, chapterIndex: chapter.order, ratio: 0 });
  };
  navigateToChapterRef.current = navigateToChapter;

  // ── TTS 会话（useTtsSession hook） ──
  const ttsSession = useTtsSession({
    bookId, book, chapters, currentChapter, loading, txtContent,
    txtScrollRef, preloadedChaptersRef, currentBookIdRef, accumulatedIdsRef,
    setCurrentChapter, setDisplayChapter, setTxtContent,
    preloadNextChapters, setPosition, saveImmediate, flushProgress,
    navigateToChapter,
  });
  const { ttsState, ttsProgress, ttsSegmentText, ttsError, activeSegmentIndex, ttsSpeed, ttsVoice } = ttsSession;
  const { handleStartTTS, handleStopTTS, handlePauseTTS, handleResumeTTS, handleTTSSeek, handleSetSleepTimer } = ttsSession;

  // ── 播放倍速（本地 playbackRate，不影响缓存身份） ──
  const [playbackRate, setPlaybackRate] = useState(() => getDefaultPlayer().getPlaybackRate());
  const handlePlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    getDefaultPlayer().setPlaybackRate(rate);
  }, []);

  // ── 缓存管理（useCacheManager hook） ──
  const cache = useCacheManager({ bookId, book, chapters, currentChapter, ttsVoice, ttsSpeed });

  // ── 阅读区交互装配 ──
  const ttsStateRef = useRef(ttsState);
  useEffect(() => { ttsStateRef.current = ttsState; }, [ttsState]);

  const toggleFloatMenu = useCallback(() => {
    if (ttsStateRef.current !== 'idle' || showSearchRef.current || showTocRef.current) return;
    if (book?.format === 'txt') setSelectedText(window.getSelection()?.toString().trim() ?? '');
    setShowUi(v => !v);
  }, [book?.format]);

  const closeMenu = useCallback(() => setShowUi(false), []);

  const performPageTurnRef = useRef<(direction: 'prev' | 'next') => Promise<void>>(async (direction) => {
    await txtReaderViewRef.current?.performPageTurn(direction);
  });
  const [isPageTurning] = useState(false);
  const readingModeRef = useRef(readingMode);
  const isPageTurningRef = useRef(isPageTurning);
  useEffect(() => { readingModeRef.current = readingMode; }, [readingMode]);
  useEffect(() => { isPageTurningRef.current = isPageTurning; }, [isPageTurning]);

  const interaction = useReaderInteraction({
    enabled: () => (
      readingModeRef.current === 'paginated'
      && !showUiRef.current && !showTocRef.current && !isPageTurningRef.current
      && ttsStateRef.current === 'idle' && !showSearchRef.current
      && book?.format === 'txt'
    ),
    navigate: (direction) => performPageTurnRef.current(direction === 'next' ? 'next' : 'prev'),
    tap: () => {
      if (showUiRef.current) closeMenu();
      else if (showTocRef.current) setShowToc(false);
    },
  });

  /** 桌面端键盘翻页快捷键 */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;
      if (ttsStateRef.current !== 'idle' || showSearchRef.current || showTocRef.current || isPageTurningRef.current) return;
      e.preventDefault();
      const next = e.key === 'ArrowRight';
      if (book?.format === 'epub') {
        if (next) epubPageControlRef.current?.next(); else epubPageControlRef.current?.prev();
      } else {
        performPageTurnRef.current(next ? 'next' : 'prev');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [book?.format]);

  // Load book and chapters
  useEffect(() => {
    if (!bookId) return;
    currentBookIdRef.current = bookId;
    loadBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // autoPlayTts=1：从书架底部栏续播时自动启动 TTS
  const [searchParams] = useSearchParams();
  const autoPlayTtsTriggered = useRef(false);
  useEffect(() => {
    if (autoPlayTtsTriggered.current) return;
    if (!currentChapter || !book) return;
    if (searchParams.get('autoPlayTts') !== '1') return;
    autoPlayTtsTriggered.current = true;
    const timer = setTimeout(() => { handleStartTTS(); }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter, book, searchParams]);

  const [isReparsing, setIsReparsing] = useState(false);
  const handleReparse = useCallback(async () => {
    if (!bookId || !book || book.format !== 'epub' || isReparsing) return;
    const ok = await confirm({
      title: '重新解析确认',
      message: '重新解析将刷新全部章节信息，确定继续？',
      confirmText: '重新解析',
    });
    if (!ok) return;
    setIsReparsing(true);
    try {
      await axios.post(`/api/books/${bookId}/reparse`);
      const [bookRes, chaptersRes] = await Promise.all([
        axios.get(`/api/books/${bookId}`),
        axios.get(`/api/books/${bookId}/chapters`),
      ]);
      const newBookData = bookRes.data?.data;
      const newChapters = chaptersRes.data?.data || [];
      if (newBookData) setBook(newBookData);
      if (newChapters.length > 0) {
        setChapters(newChapters);
        const stillExists = newChapters.some((c: Chapter) => c.id === currentChapter?.id);
        if (!stillExists && currentChapter) await loadChapterContent(newChapters[0], undefined, newBookData?.format === 'epub');
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || '章节刷新失败，请稍后重试');
    } finally {
      setIsReparsing(false);
    }
  }, [bookId, book, isReparsing, currentChapter]);

  const loadBook = async () => {
    const triggerBookId = bookId;
    try {
      setLoading(true);
      const isOffline = offlineFallback.isOffline(isOfflineMode);
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
        } catch { /* 网络请求失败 → 尝试离线降级 */ }
      }
      if (!bookData || !chaptersData.length) {
        const offlineData = await offlineFallback.loadOffline(bookId!);
        if (offlineData.book) bookData = offlineData.book;
        if (offlineData.chapters.length > 0) chaptersData = offlineData.chapters;
      }
      if (currentBookIdRef.current !== triggerBookId) return;
      if (!bookData || !chaptersData.length) {
        setError(!isOffline ? '加载图书失败' : '当前为离线状态，且该书未缓存到本地');
        setLoading(false);
        return;
      }
      setBook(bookData);
      setChapters(chaptersData);
      const isEpub = bookData.format === 'epub';
      const progressResult = await progressRestore.restore(bookId!, chaptersData, isOffline);
      const targetChapter = progressResult?.targetChapter || chaptersData[0];
      if (currentBookIdRef.current !== triggerBookId) return;
      if (progressResult?.progressVersion != null) syncVersion(progressResult.progressVersion);
      if (targetChapter) {
        if (isEpub) {
          if (progressResult?.cfi) epubCfiRef.current = progressResult.cfi;
        } else {
          if (progressResult && progressResult.restoreRatio > 0) charOffsetRatioRef.current = progressResult.restoreRatio;
          const rawPageIdx = progressResult?.rawProgress?.pageIndex;
          if (rawPageIdx != null) {
            const restorePct = rawPageIdx / 10000;
            if (restorePct > 0) setPendingScrollRestorePct(restorePct);
          }
        }
        await loadChapterContent(targetChapter, undefined, isEpub);
        preloadNextChapters(targetChapter.id);
      }
      cache.checkCacheStatus();
    } catch (err: any) {
      setError(err.response?.data?.error || '加载图书失败');
    } finally {
      setLoading(false);
    }
  };

  const loadChapterContent = async (chapter: Chapter, _offset?: number, _isEpub?: boolean, _append?: boolean, _forcePlainText?: boolean) => {
    try {
      const isEpub = _isEpub ?? (book?.format === 'epub');
      const preloaded = preloadedChaptersRef.current.get(chapter.id);
      if (!preloaded) {
        setTxtContent('');
        if (!_append) setChapterLoading(true);
      }
      setCurrentChapter(chapter);
      if (!_append) setDisplayChapter(chapter);
      preloadNextChapters(chapter.id);
      let content: string;
      if (preloaded) {
        content = preloaded.content;
        preloadedChaptersRef.current.delete(chapter.id);
      } else {
        const cachedContent = await getCachedChapterContent(bookId!, chapter.id);
        if (cachedContent) {
          content = isEpub ? stripHtml(cachedContent) : cachedContent;
          if (!_append) setChapterLoading(false);
        } else {
          if (!_append) setChapterLoading(true);
          const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
          const rawContent = res.data.data?.content || '';
          content = isEpub ? stripHtml(rawContent) : rawContent;
          if (!_append) setChapterLoading(false);
        }
      }
      const displayContent = content || `「${chapter.title}」内容暂未加载，请尝试使用目录切换或联系管理员。`;
      if (_append && !accumulatedIdsRef.current.has(chapter.id)) {
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(prev => prev + '\n\n' + chapter.title + '\n' + '─'.repeat(30) + '\n\n' + displayContent);
      } else {
        accumulatedIdsRef.current.clear();
        accumulatedIdsRef.current.add(chapter.id);
        setTxtContent(displayContent);
      }
    } catch {
      setError('加载章节内容失败');
      setChapterLoading(false);
    }
  };

  const goToNextChapter = async (_fromAutoScroll?: boolean) => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx < chapters.length - 1) await navigateToChapter(chapters[idx + 1], _fromAutoScroll);
  };
  goToNextChapterRef.current = goToNextChapter;

  const goToPrevChapter = async () => {
    if (!currentChapter) return;
    const idx = chapters.findIndex((c) => c.id === currentChapter.id);
    if (idx > 0) await navigateToChapter(chapters[idx - 1]);
  };
  goToPrevChapterRef.current = goToPrevChapter;

  useEffect(() => { chaptersRef.current = chapters; }, [chapters]);
  useEffect(() => { currentChapterRef.current = currentChapter; }, [currentChapter]);

  // ── 滚动到底部时自动加载下一章 ──
  const lastChapterLoadTimeRef = useRef(0);
  useEffect(() => {
    if (readingMode !== 'scroll') return;
    const scrollContainer = txtScrollRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!scrollContainer || !sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || loadingNextChapterRef.current) return;
        const now = Date.now();
        if (now - lastChapterLoadTimeRef.current < 800) return;
        const idx = chaptersRef.current.findIndex((c: Chapter) => c.id === currentChapterRef.current?.id);
        if (idx < 0 || idx >= chaptersRef.current.length - 1) return;
        loadingNextChapterRef.current = true;
        lastChapterLoadTimeRef.current = now;
        goToNextChapterRef.current!(true).finally(() => { loadingNextChapterRef.current = false; });
      },
      { root: scrollContainer, threshold: 0, rootMargin: '0px 0px 400px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [readingMode, book?.format]);

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
            <p className="text-ios-danger mb-4">{error}</p>
            <div className="flex flex-col items-center gap-3">
              <button onClick={() => { setError(null); loadBook(); }} className="px-4 py-2 rounded-lg font-medium" style={{background: 'var(--color-primary)', color: 'white'}}>重试</button>
              {isOfflineMode && (
                <>
                  <button onClick={() => navigate('/login', { replace: true })} className="px-4 py-1.5 border border-ios-border text-ios-text-secondary rounded hover:bg-ios-bg-alt text-sm font-medium">返回登录页</button>
                  <button onClick={exitOfflineMode} className="px-4 py-1.5 border border-ios-danger text-ios-danger rounded hover:bg-ios-danger-subtle text-sm font-medium">退出离线模式</button>
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
        <div className="h-full flex flex-col">
          <div ref={interaction.attachElement} className="flex-1 flex overflow-hidden relative">
            {showToc && (
              <TocDrawer chapters={chapters} currentChapterId={currentChapter?.id} onNavigate={(ch) => navigateToChapter(ch)} bookFormat={book?.format} onReparse={handleReparse} isReparsing={isReparsing} />
            )}

            <TtsOverlay ttsError={ttsError} onDismissError={() => ttsSession.setTtsError(null)} ttsState={ttsState} ttsSegmentText={ttsSegmentText} />

            {book?.format === 'epub' && (
              <EpubViewer
                bookId={book.id} fileUrl={`/api/books/${book.id}/file/`} readingMode={readingMode}
                fontSize={fontSize} fontFamily={fontFamily} lineHeight={lineHeight} letterSpacing={letterSpacing}
                initialCfi={epubCfiRef.current} pageControlRef={epubPageControlRef} chapterNavRef={epubChapterNavRef}
                onTap={closeMenu} interactionBlocked={showUi || showToc || showSearch || ttsState !== 'idle'}
                onSelectionTextChange={setSelectedText}
                onLocationChange={(cfi, chapterRatio) => {
                  epubCfiRef.current = cfi;
                  if (typeof chapterRatio === 'number') epubChapterRatioRef.current = chapterRatio;
                  if (currentBookIdRef.current) updatePosition({ ratio: epubChapterRatioRef.current ?? 0, cfi });
                }}
                onPrevChapter={() => goToPrevChapterRef.current?.()}
                onNextChapter={() => goToNextChapterRef.current?.()}
              />
            )}

            {book?.format === 'epub' && (
              <>
                <button onClick={() => { const idx = chapters.findIndex((c) => c.id === currentChapter?.id); if (idx > 0) navigateToChapter(chapters[idx - 1]); }}
                  disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter?.id) <= 0}
                  className="absolute left-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 opacity-40 hover:opacity-100 disabled:opacity-10 disabled:pointer-events-none"
                  style={{background: 'var(--color-bg-alt)', color: 'var(--color-text)'}} title="上一章">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button onClick={() => { const idx = chapters.findIndex((c) => c.id === currentChapter?.id); if (idx >= 0 && idx < chapters.length - 1) navigateToChapter(chapters[idx + 1]); }}
                  disabled={!currentChapter || chapters.findIndex((c) => c.id === currentChapter?.id) >= chapters.length - 1}
                  className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 opacity-40 hover:opacity-100 disabled:opacity-10 disabled:pointer-events-none"
                  style={{background: 'var(--color-bg-alt)', color: 'var(--color-text)'}} title="下一章">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </>
            )}

            {book?.format === 'txt' && (
              <TxtReaderView
                ref={txtReaderViewRef} content={txtContent} chapterTitle={(displayChapter || currentChapter)?.title || ''}
                readingMode={readingMode} fontSize={fontSize} lineHeight={lineHeight} letterSpacing={letterSpacing} fontFamily={fontFamily}
                ttsSegments={null} activeSegmentIndex={activeSegmentIndex} searchResults={[]}
                onProgress={(ratio) => { charOffsetRatioRef.current = ratio; updatePosition(readingMode === 'scroll' ? { ratio, scrollRatio: ratio } : { ratio }); }}
                onBoundary={(dir) => { if (dir === 'next') goToNextChapterRef.current?.(); else goToPrevChapterRef.current?.(); }}
                onPageInfo={(page, total) => { setPageIndex(page); setTotalPages(total); updatePosition({ page, pageCount: total }); }}
                initialScrollRatio={pendingScrollRestorePct} isPageTurning={isPageTurning}
              />
            )}

            <SearchOverlay
              visible={showSearch} onClose={() => setShowSearch(false)} chapters={chapters}
              bookId={bookId!} bookFormat={book?.format || 'txt'}
              onJump={async (result) => {
                setShowSearch(false);
                const targetChapter = chapters[result.chapterIdx];
                if (!targetChapter) return;
                await loadChapterContent(targetChapter, undefined, undefined, false, true);
                setTimeout(() => {
                  requestAnimationFrame(() => {
                    const container = txtScrollRef.current;
                    if (!container) return;
                    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
                    let charCount = 0;
                    while (walker.nextNode()) {
                      const node = walker.currentNode as Text;
                      const nodeLen = node.textContent?.length || 0;
                      if (charCount + nodeLen > result.offset) {
                        const targetOffset = result.offset - charCount;
                        const range = document.createRange();
                        range.setStart(node, targetOffset);
                        range.setEnd(node, Math.min(nodeLen, targetOffset + 10));
                        const rect = range.getBoundingClientRect();
                        if (rect) container.scrollBy({ top: rect.top - container.clientHeight / 3, behavior: 'smooth' });
                        break;
                      }
                      charCount += nodeLen;
                    }
                  });
                }, 100);
              }}
              getPreloadedContent={(chId) => preloadedChaptersRef.current.get(chId)?.content}
            />
          </div>
        </div>

        <button onClick={(e) => { e.stopPropagation(); toggleFloatMenu(); }}
          className="absolute bottom-6 left-6 z-35 w-11 h-11 rounded-full flex items-center justify-center transition-opacity duration-200 hover:opacity-80 active:scale-90"
          style={{ background: 'rgba(128,128,128,0.5)', opacity: 0.5 }} aria-label="菜单" title="菜单">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>

        {showUi && (
          <ReaderControlPanel
            onBack={() => navigate('/')}
            onSearch={() => { setShowSearch(true); closeMenu(); }}
            onToggleToc={() => { setShowToc(v => !v); closeMenu(); }}
            showToc={showToc}
            chapterTitle={(displayChapter || currentChapter)?.title || book?.title || ''}
            ttsState={ttsState} ttsProgress={ttsProgress}
            onStartTTS={handleStartTTS} onPauseTTS={handlePauseTTS} onResumeTTS={handleResumeTTS} onStopTTS={handleStopTTS}
            onSeek={handleTTSSeek}
            onPrevChapter={() => goToPrevChapterRef.current?.()} onNextChapter={() => goToNextChapterRef.current?.()}
            sleepTimerMinutes={ttsSession.sleepTimerMinutes} onSetSleepTimer={handleSetSleepTimer}
            playbackRate={playbackRate} onPlaybackRateChange={handlePlaybackRateChange}
            fontSize={fontSize} setFontSize={setFontSize} lineHeight={lineHeight} setLineHeight={setLineHeight}
            fontFamily={fontFamily} setFontFamily={setFontFamily} readingMode={readingMode}
            onToggleReadingMode={() => {
              if (readingMode === 'scroll') {
                const scrollEl = txtPageRef.current;
                if (scrollEl && scrollEl.scrollHeight > 0) {
                  const r = Math.min(1, Math.max(0, scrollEl.scrollTop / scrollEl.scrollHeight));
                  charOffsetRatioRef.current = r;
                  updatePosition({ ratio: r, scrollRatio: r });
                }
                setReadingMode('paginated');
              } else {
                setReadingMode('scroll');
              }
            }}
            currentChapterIndex={currentChapter ? chapters.findIndex(c => c.id === currentChapter.id) : -1}
            totalChapters={chapters.length} bookFormat={book?.format}
            pageIndex={pageIndex} totalPages={totalPages}
            onPageTurn={(dir) => performPageTurnRef.current(dir)}
            selectedText={selectedText}
            onCopy={async () => {
              const text = selectedText || window.getSelection()?.toString().trim() || '';
              if (!text) return;
              try {
                await navigator.clipboard.writeText(text);
                toast.success('已复制到剪贴板'); setSelectedText(''); window.getSelection()?.removeAllRanges(); closeMenu();
              } catch { /* Clipboard API unavailable */ }
            }}
            cachingInProgress={cache.cachingInProgress} cacheProgressText={cache.cacheProgressText} cacheStatus={cache.cacheStatus}
            onCacheChapter={cache.handleCacheCurrentChapter} onCacheFullBook={cache.handleCacheFullBook}
            onClearTextCache={cache.handleClearTextCache} onClearAudioCache={cache.handleClearAudioCache}
            onClose={closeMenu}
          />
        )}
      </div>
    </div>
  );
}

export default ReaderPage;
