/**
 * useTtsIntegration —— TTS 集成 hook（Phase 6.2, ready for 6.2b integration）
 *
 * 职责：
 *   - 管理 TTS 播放状态（state/progress/activeSegment）
 *   - 提供 start/stop/pause/resume/seek 操作
 *   - 睡眠定时器管理
 *   - 章节切换时自动续播
 *
 * 从 ReaderPage 提取的核心 TTS 控制逻辑。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDefaultPlayer, type PlayerState } from '../../services/ttsPlayer';

export interface UseTtsIntegrationOptions {
  bookId: string | undefined;
  /** 获取当前章节文本的函数 */
  getChapterText: () => Promise<string>;
  /** 当前章节 ID */
  currentChapterId: string | undefined;
  /** 当前章节标题 */
  currentChapterTitle: string | undefined;
  /** 书籍标题 */
  bookTitle: string | undefined;
  /** 分段高亮回调 */
  onSegmentChange?: (index: number, total: number) => void;
  /** 章节播完回调 */
  onChapterEnd?: () => void;
}

export interface UseTtsIntegrationResult {
  ttsState: PlayerState;
  ttsProgress: number;
  activeSegmentIndex: number;
  sleepTimerMinutes: number | null;
  /** 启动/切换 TTS */
  startTTS: () => Promise<void>;
  stopTTS: () => void;
  pauseTTS: () => void;
  resumeTTS: () => void;
  seekTTS: (progress: number) => void;
  setSleepTimer: (minutes: number | null) => void;
  /** 获取播放器实例 */
  getPlayer: () => ReturnType<typeof getDefaultPlayer> | null;
}

export function useTtsIntegration(options: UseTtsIntegrationOptions): UseTtsIntegrationResult {
  const { } = options; // 通过 optsRef 访问，避免闭包过期

  const [ttsState, setTtsState] = useState<PlayerState>('idle');
  const [ttsProgress, setTtsProgress] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [sleepTimerMinutes, setSleepTimerMinutes] = useState<number | null>(null);

  const playerRef = useRef<ReturnType<typeof getDefaultPlayer> | null>(null);
  const sleepTimerEndRef = useRef<number | null>(null);
  const sleepTimerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  // 清理睡眠定时器
  const clearSleepTimer = useCallback(() => {
    if (sleepTimerIntervalRef.current) {
      clearInterval(sleepTimerIntervalRef.current);
      sleepTimerIntervalRef.current = null;
    }
    sleepTimerEndRef.current = null;
    setSleepTimerMinutes(null);
  }, []);

  // 设置睡眠定时器
  const setSleepTimer = useCallback((minutes: number | null) => {
    clearSleepTimer();
    if (minutes == null) return;
    setSleepTimerMinutes(minutes);
    sleepTimerEndRef.current = Date.now() + minutes * 60 * 1000;
    sleepTimerIntervalRef.current = setInterval(() => {
      if (sleepTimerEndRef.current && Date.now() >= sleepTimerEndRef.current) {
        playerRef.current?.pause();
        clearSleepTimer();
      }
    }, 1000);
  }, [clearSleepTimer]);

  // 启动 TTS
  const startTTS = useCallback(async () => {
    const opts = optsRef.current;
    if (!opts.bookId) return;

    const player = getDefaultPlayer();
    playerRef.current = player;

    // Toggle: 同一本书正在播放 → 暂停
    const currentState = player.getState();
    if ((currentState === 'playing' || currentState === 'paused') && player.currentBookId === opts.bookId) {
      if (currentState === 'playing') player.pause();
      else player.resume();
      return;
    }

    // 不同书 → 停止旧的
    if (currentState !== 'idle') player.stop();

    // ⭐ 确保 audio 元素已创建（首次播放时 init 尚未被预热触发）
    await player.init({
      bookId: opts.bookId,
      bookTitle: opts.bookTitle || '',
      bookCoverUrl: `/api/books/${opts.bookId}/cover`,
    });

    // 设置元数据
    player.chapterTitle = opts.currentChapterTitle || '';
    player.chapterId = opts.currentChapterId || '';
    (player as any).bookTitle = opts.bookTitle || '';

    // 设置音色
    const savedVoice = (() => {
      try { return localStorage.getItem('ireader_tts_voice'); } catch { return null; }
    })();
    if (savedVoice) player.setVoice(savedVoice);

    // 注册回调
    player.setCallbacks({
      onStateChange: (s: PlayerState) => {
        setTtsState(s);
        if (s !== 'playing' && sleepTimerIntervalRef.current) {
          clearInterval(sleepTimerIntervalRef.current);
          sleepTimerIntervalRef.current = null;
        }
      },
      onSegmentPlay: (idx: number, total: number) => {
        setActiveSegmentIndex(idx);
        optsRef.current.onSegmentChange?.(idx, total);
      },
      onProgress: (p: number) => setTtsProgress(p),
      onError: () => { /* 静默 */ },
      onEnd: () => {
        setTtsProgress(1);
        clearSleepTimer();
        optsRef.current.onChapterEnd?.();
      },
    });

    // 获取文本并加载
    const text = await opts.getChapterText();
    if (!text) return;
    await player.load(text, false, opts.currentChapterId);
    setActiveSegmentIndex(0);
    setTtsProgress(0);
    await player.play();
  }, [clearSleepTimer]);

  // 停止
  const stopTTS = useCallback(() => {
    playerRef.current?.stop();
    setTtsState('idle');
    setTtsProgress(0);
    setActiveSegmentIndex(-1);
    clearSleepTimer();
  }, [clearSleepTimer]);

  // 暂停/恢复
  const pauseTTS = useCallback(() => { playerRef.current?.pause(); }, []);
  const resumeTTS = useCallback(() => { playerRef.current?.resume(); }, []);

  // Seek
  const seekTTS = useCallback((progress: number) => {
    const player = playerRef.current;
    if (!player || player.getState() === 'idle') return;
    player.seekTo(progress);
  }, []);

  const getPlayer = useCallback(() => playerRef.current, []);

  // 卸载清理
  useEffect(() => {
    return () => {
      if (sleepTimerIntervalRef.current) clearInterval(sleepTimerIntervalRef.current);
    };
  }, []);

  return {
    ttsState,
    ttsProgress,
    activeSegmentIndex,
    sleepTimerMinutes,
    startTTS,
    stopTTS,
    pauseTTS,
    resumeTTS,
    seekTTS,
    setSleepTimer,
    getPlayer,
  };
}
