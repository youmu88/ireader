/**
 * useTtsSession — TTS 会话管理 hook
 *
 * 从 ReaderPage 提取的 TTS 全生命周期管理：
 *   - TTS 状态变量（state/progress/segmentText/error/activeSegment）
 *   - TTS 设置（speed/voice，从 localStorage 读取）
 *   - 播放持久化（localStorage，页面刷新后恢复）
 *   - TTS 预热（进入书籍时预初始化播放器 + 预载 IDB 缓存）
 *   - TTS 状态同步（进入书籍时若播放器正在播放本书 → 同步 UI）
 *   - 自动进入下一章（advanceToNextChapterTTS）
 *   - 获取当前章节纯文本（getCurrentChapterText）
 *   - TTS 音频预取（triggerTtsPrefetch）
 *   - 进度条拖拽 seek
 *   - 组件卸载清理（保存进度 + 释放 ref）
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';
import { getDefaultPlayer, splitText, type PlayerState } from '../../services/ttsPlayer';
import { getCachedChapterContent } from '../../services/offlineCacheService';
import { useTtsIntegration } from './useTtsIntegration';
import { stripHtml } from '../utils/stripHtml';
import type { Chapter } from '../types';

const TTS_PLAYBACK_KEY = 'ireader_tts_playback';

interface PlaybackState {
  bookId: string;
  chapterId: string;
  segmentIndex: number;
  bookTitle?: string;
  chapterTitle?: string;
  timestamp: number;
}

function savePlaybackToLocalStorage(state: PlaybackState) {
  try { localStorage.setItem(TTS_PLAYBACK_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}
function clearPlaybackFromLocalStorage() {
  try { localStorage.removeItem(TTS_PLAYBACK_KEY); } catch { /* ignore */ }
}

interface Book {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
  status: 'processing' | 'ready' | 'failed';
}

export interface UseTtsSessionParams {
  bookId: string | undefined;
  book: Book | null;
  chapters: Chapter[];
  currentChapter: Chapter | null;
  loading: boolean;
  txtContent: string;
  txtScrollRef: React.RefObject<HTMLDivElement | null>;
  preloadedChaptersRef: React.RefObject<Map<string, { content: string }>>;
  currentBookIdRef: React.RefObject<string | undefined>;
  accumulatedIdsRef: React.RefObject<Set<string>>;
  setCurrentChapter: (ch: Chapter) => void;
  setDisplayChapter: (ch: Chapter) => void;
  setTxtContent: React.Dispatch<React.SetStateAction<string>>;
  preloadNextChapters: (chapterId: string) => Promise<void>;
  setPosition: (pos: any) => void;
  saveImmediate: (pos: any) => void;
  flushProgress: () => void;
  navigateToChapter: (chapter: Chapter, append?: boolean) => Promise<void>;
}

export interface UseTtsSessionReturn {
  ttsState: PlayerState;
  ttsProgress: number;
  ttsSegmentText: string;
  ttsError: string | null;
  activeSegmentIndex: number;
  ttsSpeed: number;
  ttsVoice: string;
  ttsPlayerRef: React.RefObject<ReturnType<typeof getDefaultPlayer> | null>;
  progressBarRef: React.RefObject<HTMLDivElement | null>;
  isDraggingRef: React.RefObject<boolean>;
  sleepTimerMinutes: number | null;
  handleStartTTS: () => Promise<void>;
  handleStopTTS: () => void;
  handlePauseTTS: () => void;
  handleResumeTTS: () => void;
  handleTTSSeek: (pct: number) => void;
  handleSetSleepTimer: (minutes: number | null) => void;
  setTtsError: (err: string | null) => void;
}

export function useTtsSession(params: UseTtsSessionParams): UseTtsSessionReturn {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [ttsSegmentText, setTtsSegmentText] = useState('');
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsSpeed] = useState(() => {
    try {
      const raw = localStorage.getItem('ireader_tts_synthesisRate') || localStorage.getItem('ireader_tts_speed');
      return raw ? parseFloat(raw) : 1.0;
    } catch { return 1.0; }
  });
  const [ttsVoice] = useState(() => {
    try { return localStorage.getItem('ireader_tts_voice') || 'zh-CN-XiaoxiaoNeural'; } catch { return 'zh-CN-XiaoxiaoNeural'; }
  });

  const ttsPlayerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const advanceToNextChapterTTSRef = useRef<((player: any) => Promise<void>) | null>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const sleepTimerIntervalRef = useRef<any>(null);
  const warmupTriggered = useRef(false);

  const { bookId, book, currentChapter, loading } = params;

  // ── TTS 预热 ──
  useEffect(() => {
    if (warmupTriggered.current) return;
    if (loading || !currentChapter || !bookId || !book) return;
    warmupTriggered.current = true;
    const timer = setTimeout(async () => {
      try {
        let lastPlayback: { bookId: string; chapterId: string } | null = null;
        try {
          const raw = localStorage.getItem('ireader_last_playback');
          if (raw) lastPlayback = JSON.parse(raw);
        } catch { /* ignore */ }
        if (!lastPlayback || lastPlayback.bookId !== bookId) return;
        const player = getDefaultPlayer();
        if (player['audioElement']) return;
        const savedVoice = (() => { try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; } })();
        const savedSpeed = (() => { try { const r = localStorage.getItem('ireader_tts_synthesisRate') || localStorage.getItem('ireader_tts_speed'); return r ? parseFloat(r) : null; } catch { return null; } })();
        const noCachePref = (() => { try { return localStorage.getItem('ireader_tts_noCache') === 'true'; } catch { return true; } })();
        await player.init({
          source: localStorage.getItem('ireader_tts_source') || undefined,
          synthesisRate: savedSpeed || ttsSpeed,
          voice: savedVoice || ttsVoice,
          noCache: noCachePref,
          bookId,
          bookTitle: book?.title || '',
          bookCoverUrl: `/api/books/${bookId}/cover`,
        });
        const cachedContent = await getCachedChapterContent(bookId, currentChapter.id);
        if (cachedContent) {
          const text = book.format === 'epub' ? stripHtml(cachedContent) : cachedContent;
          const splitChunks = text.match(/[^。！？\n]+[。！？\n]?/g);
          if (splitChunks && splitChunks.length > 0) {
            player.preloadCachedAudio(bookId, currentChapter.id, splitChunks);
          }
        }
      } catch { /* 预热失败不阻塞 */ }
    }, 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, currentChapter, bookId, book]);

  // ── TTS 音频预取 ──
  const triggerTtsPrefetch = useCallback(async (nextChapterIndex: number) => {
    const p = paramsRef.current;
    const nextCh = p.chapters[nextChapterIndex];
    if (!nextCh || !p.bookId) return;
    let content = '';
    const preloaded = p.preloadedChaptersRef.current?.get(nextCh.id);
    if (preloaded) {
      content = preloaded.content;
    } else {
      const cached = await getCachedChapterContent(p.bookId, nextCh.id);
      if (cached) {
        content = p.book?.format === 'epub' ? stripHtml(cached) : cached;
      } else {
        try {
          const res = await axios.get(`/api/books/${p.bookId}/chapters/${nextCh.id}/content`);
          const raw = res.data.data?.content || '';
          content = p.book?.format === 'epub' ? stripHtml(raw) : raw;
        } catch { return; }
      }
    }
    if (!content) return;
    const segments = splitText(content);
    if (segments.length === 0) return;
    const player = getDefaultPlayer();
    player.prefetchChapterSegments(segments, nextCh.id).catch(() => {});
  }, []);

  // ── TTS 自动进入下一章 ──
  const advanceToNextChapterTTS = useCallback(async (player: any) => {
    const p = paramsRef.current;
    const curCh = p.currentChapter;
    if (!curCh || !p.chapters.length) return;
    const triggerBookId = p.currentBookIdRef.current;
    const ci = p.chapters.findIndex((c) => c.id === curCh.id);
    if (ci < 0 || ci >= p.chapters.length - 1) {
      player.stop();
      setTtsSegmentText('');
      clearPlaybackFromLocalStorage();
      return;
    }
    const nextCh = p.chapters[ci + 1];
    p.setPosition({ bookId: p.bookId!, chapterId: curCh.id, chapterIndex: ci, ratio: 1 });
    try {
      let content = await getCachedChapterContent(triggerBookId!, nextCh.id);
      if (!content) {
        const res = await axios.get(`/api/books/${triggerBookId}/chapters/${nextCh.id}/content`);
        content = res.data.data?.content || '';
      }
      if (p.currentBookIdRef.current !== triggerBookId) return;
      if (!content) return;
      content = p.book?.format === 'epub' ? stripHtml(content) : content;
      if (!content) return;
      p.setCurrentChapter(nextCh);
      p.setDisplayChapter(nextCh);
      p.accumulatedIdsRef.current?.clear();
      p.accumulatedIdsRef.current?.add(nextCh.id);
      p.setTxtContent(content);
      if (p.txtScrollRef.current) p.txtScrollRef.current.scrollTop = 0;
      const loadedFromPrefetch = await player.loadFromPrefetched();
      if (!loadedFromPrefetch) {
        await player.load(content, false, nextCh.id);
      }
      await player.play();
      p.preloadNextChapters(nextCh.id);
    } catch {
      player.stop();
    }
  }, []);
  advanceToNextChapterTTSRef.current = advanceToNextChapterTTS;

  // ── 获取当前章节纯文本 ──
  const getCurrentChapterText = useCallback(async (): Promise<string> => {
    const p = paramsRef.current;
    if (!p.currentChapter || !p.bookId || !p.book) return '';
    const cachedContent = await getCachedChapterContent(p.bookId, p.currentChapter.id);
    if (cachedContent) {
      return p.book.format === 'epub' ? stripHtml(cachedContent) : cachedContent;
    }
    try {
      const res = await axios.get(`/api/books/${p.bookId}/chapters/${p.currentChapter.id}/content`);
      const rawContent = res.data.data?.content;
      if (!rawContent) return '';
      return p.book.format === 'epub' ? stripHtml(rawContent) : rawContent;
    } catch { /* fallback */ }
    return p.txtContent;
  }, []);

  // ── 进入书籍时同步 TTS UI 状态 ──
  useEffect(() => {
    if (!bookId || !currentChapter || loading) return;
    const player = getDefaultPlayer();
    const state = player.getState();
    if (state === 'idle' || player.currentBookId !== bookId) return;
    ttsPlayerRef.current = player;
    const idx = player.getCurrentIndex();
    if (idx >= 0) {
      setTtsSegmentText(player.getCurrentSegmentText());
    }
    player.setCallbacks({
      onStateChange: (s) => {
        if (s !== 'playing' && sleepTimerIntervalRef.current) {
          clearInterval(sleepTimerIntervalRef.current);
          sleepTimerIntervalRef.current = null;
        }
      },
      onSegmentPlay: (i, total) => {
        setTtsSegmentText(player.getCurrentSegmentText());
        requestAnimationFrame(() => {
          const container = paramsRef.current.txtScrollRef.current;
          if (!container) return;
          const highlighted = container.querySelector('[data-tts-segment="active"]');
          if (highlighted) highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        if (total > 0 && i >= total * 0.75) {
          const p = paramsRef.current;
          const ci = p.chapters.findIndex((c) => c.id === p.currentChapter?.id);
          if (ci >= 0 && ci < p.chapters.length - 1) {
            p.preloadNextChapters(p.currentChapter!.id);
            triggerTtsPrefetch(ci + 1).catch(() => {});
          }
        }
      },
      onError: (err) => {
        console.warn('TTS 朗读错误:', err);
        if ((err.includes('合成失败') || err.includes('无可用音频')) && !err.includes('当前离线且该段语音未缓存')) return;
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
        if (sleepTimerIntervalRef.current) {
          clearInterval(sleepTimerIntervalRef.current);
          sleepTimerIntervalRef.current = null;
        }
        advanceToNextChapterTTSRef.current?.(player);
      },
      onPrevChapter: () => {
        const p = paramsRef.current;
        const idx = p.chapters.findIndex((c) => c.id === (p.currentChapter?.id || ''));
        if (idx > 0) p.navigateToChapter(p.chapters[idx - 1]);
      },
      onNextChapter: () => {
        const p = paramsRef.current;
        const idx = p.chapters.findIndex((c) => c.id === (p.currentChapter?.id || ''));
        if (idx >= 0 && idx < p.chapters.length - 1) p.navigateToChapter(p.chapters[idx + 1]);
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, currentChapter, loading]);

  // ── TTS 控制（委托 useTtsIntegration hook） ──
  const tts = useTtsIntegration({
    bookId,
    getChapterText: getCurrentChapterText,
    currentChapterId: currentChapter?.id,
    currentChapterTitle: currentChapter?.title,
    bookTitle: book?.title,
    onSegmentChange: (_idx, _total) => {
      requestAnimationFrame(() => {
        const container = paramsRef.current.txtScrollRef.current;
        if (!container) return;
        const highlighted = container.querySelector('[data-tts-segment="active"]');
        if (highlighted) highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },
    onChapterEnd: () => { advanceToNextChapterTTSRef.current?.(ttsPlayerRef.current!); },
  });

  // ── 进度条拖拽 seek ──
  const handleTTSSeek = tts.seekTTS;
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
    const onTouchMove = (e: TouchEvent) => { if (e.touches.length > 0) handleGlobalMove(e.touches[0].clientX); };
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

  // ── 组件卸载清理 ──
  useEffect(() => {
    return () => {
      const p = paramsRef.current;
      const chap = p.currentChapter;
      if (ttsPlayerRef.current && chap) {
        const idx = ttsPlayerRef.current.getCurrentIndex();
        const total = ttsPlayerRef.current.getTotalChunks();
        if (idx >= 0 && total > 0) {
          const cIdx = p.chapters.findIndex((c: any) => c.id === chap.id);
          const chapterPct = (idx + 1) / total;
          p.saveImmediate({
            bookId: p.bookId!,
            chapterId: chap.id,
            chapterIndex: cIdx >= 0 ? cIdx : 0,
            ratio: chapterPct,
            textOffset: idx,
            timestamp: Date.now(),
          });
          savePlaybackToLocalStorage({
            bookId: p.bookId || '',
            chapterId: chap.id,
            segmentIndex: idx,
            timestamp: Date.now(),
          });
        }
      }
      p.flushProgress();
      if (ttsPlayerRef.current) ttsPlayerRef.current = null;
    };
  }, []);

  return {
    ttsState: tts.ttsState,
    ttsProgress: tts.ttsProgress,
    ttsSegmentText,
    ttsError,
    activeSegmentIndex: tts.activeSegmentIndex,
    ttsSpeed,
    ttsVoice,
    ttsPlayerRef,
    progressBarRef,
    isDraggingRef,
    sleepTimerMinutes: tts.sleepTimerMinutes,
    handleStartTTS: tts.startTTS,
    handleStopTTS: tts.stopTTS,
    handlePauseTTS: tts.pauseTTS,
    handleResumeTTS: tts.resumeTTS,
    handleTTSSeek: tts.seekTTS,
    handleSetSleepTimer: tts.setSleepTimer,
    setTtsError,
  };
}
