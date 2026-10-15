/**
 * useTtsSession — 听书会话状态机（Phase 2 D2 播放层核心编排）
 *
 * 状态流转：idle → loading(拉设置/章节/分段/缓存索引) → playing ⇄ paused → idle
 * 章节推进：按后端章节表顺序 goTo(displayHref) → 拉分段 → 逐段播放；
 * 段推进：缓存优先/合成兜底（失败重试 1 次后跳过并计数，不中断整章）；
 * 联动：每段开始回调 onSegmentStart（驱动段落高亮 + overlay 文本）；
 *       章播完自动 goTo 下一章（scrolled/paged 通用，paged 为章粒度自动翻页）。
 * 依赖全部可注入（单测不发网络、player 用 stub 立即结束）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EpubBookController } from '../EpubBookController';
import {
  fetchBookChapters,
  fetchChapterSegments,
  fetchBatchCache,
  fetchPlaybackSettings,
  getNoCachePref,
  type TtsSegmentInfo,
} from './ttsApi';
import {
  buildChapterList,
  findStartChapterIndex,
  resolveSegmentAudio,
  type TtsChapterEntry,
} from './ttsScheduler';
import { TtsPlayer, type TtsPlayerLike } from './ttsPlayer';
import {
  setMediaActionHandlers,
  setMediaPlaybackState,
  updateMediaMetadata,
} from './ttsMediaSession';

export type TtsStatus = 'idle' | 'loading' | 'playing' | 'paused';

export interface TtsSessionState {
  status: TtsStatus;
  /** 当前朗读段文本（overlay 展示） */
  currentText: string;
  currentSegmentIndex: number;
  currentChapterTitle: string;
  /** 整书段进度（当前章/全部章估算） */
  progress: number;
  failedCount: number;
  rate: number;
}

export interface UseTtsSessionOptions {
  bookId: string;
  bookTitle: string;
  format: 'epub' | 'txt';
  controllerRef: { current: EpubBookController | null };
  /** 当前阅读位置章节 href（location.chapterHref） */
  chapterHref: string | null;
  /** 段开始回调：返回 false 表示高亮失败（供跟踪，不阻塞） */
  onSegmentStart?: (seg: TtsSegmentInfo) => void;
  /** 依赖注入（测试） */
  deps?: Partial<TtsSessionDeps>;
}

export interface TtsSessionDeps {
  fetchChapters: typeof fetchBookChapters;
  fetchSegments: typeof fetchChapterSegments;
  fetchCache: typeof fetchBatchCache;
  fetchSettings: typeof fetchPlaybackSettings;
  resolveAudio: typeof resolveSegmentAudio;
  createPlayer: () => TtsPlayerLike;
}

const defaultDeps: TtsSessionDeps = {
  fetchChapters: fetchBookChapters,
  fetchSegments: fetchChapterSegments,
  fetchCache: fetchBatchCache,
  fetchSettings: fetchPlaybackSettings,
  resolveAudio: resolveSegmentAudio,
  createPlayer: () => new TtsPlayer(),
};

const INITIAL_STATE: TtsSessionState = {
  status: 'idle',
  currentText: '',
  currentSegmentIndex: -1,
  currentChapterTitle: '',
  progress: 0,
  failedCount: 0,
  rate: 1.0,
};

export function useTtsSession(options: UseTtsSessionOptions) {
  const { bookId, bookTitle, format, controllerRef, chapterHref, onSegmentStart, deps } = options;
  const d = { ...defaultDeps, ...deps };

  const [state, setState] = useState<TtsSessionState>(INITIAL_STATE);
  /** 会话代际：stop/重开时 +1，旧异步循环凭代际退出 */
  const sessionGenRef = useRef(0);
  const abortRef = useRef(false);
  const playerRef = useRef<TtsPlayerLike | null>(null);
  /** 最新 chapterHref/章节表快照（异步循环内读取，避免闭包过期） */
  const chapterHrefRef = useRef(chapterHref);
  chapterHrefRef.current = chapterHref;
  const chapterListRef = useRef<TtsChapterEntry[]>([]);
  const onSegmentStartRef = useRef(onSegmentStart);
  onSegmentStartRef.current = onSegmentStart;
  const stateRef = useRef(state);
  stateRef.current = state;

  const stop = useCallback(() => {
    sessionGenRef.current += 1;
    abortRef.current = true;
    playerRef.current?.stop();
    playerRef.current?.destroy();
    playerRef.current = null;
    setMediaActionHandlers(null);
    setMediaPlaybackState('none');
    controllerRef.current?.clearHighlight();
    setState({ ...INITIAL_STATE });
    // 允许下次 start：abort 标志在 start 内重置
  }, [controllerRef]);

  /** 会话自然结束/中断归位：与 stop 同构但保留 failedCount 等统计（用户可感知跳段数） */
  const finishSession = useCallback(() => {
    sessionGenRef.current += 1;
    abortRef.current = true;
    playerRef.current?.stop();
    playerRef.current?.destroy();
    playerRef.current = null;
    setMediaActionHandlers(null);
    setMediaPlaybackState('none');
    controllerRef.current?.clearHighlight();
    setState(s => ({ ...INITIAL_STATE, failedCount: s.failedCount }));
  }, [controllerRef]);

  /** 单章播放：返回是否完整播完（false=会话被中断） */
  const playChapter = useCallback(async (
    chapter: TtsChapterEntry,
    chapterIndex: number,
    totalChapters: number,
    voice: string,
    speed: number,
    gen: number,
  ): Promise<boolean> => {
    const controller = controllerRef.current;
    const player = playerRef.current;
    if (!controller || !player) return false;

    setState(s => ({ ...s, currentChapterTitle: chapter.title }));
    // 跳转到章首（paged：自动翻页为章粒度；scrolled：滚动跟随到章首）
    if (chapter.displayHref) {
      try { await controller.goTo(chapter.displayHref); } catch { /* 跳转失败继续播 */ }
    }
    if (abortRef.current || sessionGenRef.current !== gen) return false;

    let segments: TtsSegmentInfo[];
    try {
      segments = await d.fetchSegments(bookId, chapter.chapterId);
    } catch {
      setState(s => ({ ...s, failedCount: s.failedCount + 1 }));
      return true; // 分段拉取失败：视作本章跳过，继续下一章
    }
    if (abortRef.current || sessionGenRef.current !== gen) return false;
    if (segments.length === 0) return true; // 空章直接过

    let cacheMap = new Map<string, string>();
    try {
      cacheMap = await d.fetchCache(bookId, voice, speed);
    } catch { /* 缓存索引失败 → 全部走实时合成 */ }
    if (abortRef.current || sessionGenRef.current !== gen) return false;

    const noCache = getNoCachePref();
    const baseProgress = chapterIndex / totalChapters;
    const chapterWeight = 1 / totalChapters;

    for (let i = 0; i < segments.length; i++) {
      if (abortRef.current || sessionGenRef.current !== gen) return false;
      const seg = segments[i];
      setState(s => ({
        ...s,
        status: 'playing',
        currentText: seg.text,
        currentSegmentIndex: seg.segmentIndex,
        progress: baseProgress + chapterWeight * (i / segments.length),
      }));
      onSegmentStartRef.current?.(seg);

      const blob = await d.resolveAudio(seg, {
        cacheMap, voice, speed, bookId, chapterId: chapter.chapterId, noCache,
      });
      if (abortRef.current || sessionGenRef.current !== gen) return false;
      if (!blob) {
        setState(s => ({ ...s, failedCount: s.failedCount + 1 }));
        continue; // 跳过坏段，不中断整章
      }

      const finish = await player.playBlob(blob, stateRef.current.rate);
      if (finish === 'aborted' || abortRef.current || sessionGenRef.current !== gen) return false;
    }
    return true;
  }, [bookId, controllerRef, d]);

  /** 启动听书（幂等：进行中重复调用先停旧会话） */
  const start = useCallback(async () => {
    // 停掉旧会话
    sessionGenRef.current += 1;
    abortRef.current = true;
    playerRef.current?.stop();
    const gen = sessionGenRef.current;
    abortRef.current = false;
    setState({ ...INITIAL_STATE, status: 'loading' });

    const player = d.createPlayer();
    playerRef.current = player;

    try {
      const [chaptersRaw, settings] = await Promise.all([
        d.fetchChapters(bookId),
        d.fetchSettings().catch(() => ({ voiceId: 'alloy', speed: 1.0 })),
      ]);
      if (abortRef.current || sessionGenRef.current !== gen) return;

      const chapterList = buildChapterList(
        chaptersRaw.map(c => ({ id: c.id, title: c.title, href: c.href })),
        format,
      );
      chapterListRef.current = chapterList;
      if (chapterList.length === 0) {
        setState({ ...INITIAL_STATE, status: 'idle' });
        return;
      }

      const startIndex = findStartChapterIndex(chapterList, chapterHrefRef.current);
      setState(s => ({ ...s, rate: settings.speed }));

      setMediaActionHandlers({
        play: () => { void resume(); },
        pause: () => { pause(); },
        stop: () => { stop(); },
        nextSegment: () => { playerRef.current?.stop(); },
        prevSegment: () => { playerRef.current?.stop(); },
      });
      updateMediaMetadata({ bookTitle, chapterTitle: chapterList[startIndex].title });

      for (let ci = startIndex; ci < chapterList.length; ci++) {
        if (abortRef.current || sessionGenRef.current !== gen) return;
        updateMediaMetadata({ bookTitle, chapterTitle: chapterList[ci].title });
        const done = await playChapter(chapterList[ci], ci, chapterList.length, settings.voiceId, settings.speed, gen);
        if (!done || abortRef.current || sessionGenRef.current !== gen) {
          // 中断归位（用户主动 stop 已清，幂等）
          finishSession();
          return;
        }
      }
      // 全书播完：保留统计归位
      finishSession();
    } catch {
      if (sessionGenRef.current === gen) {
        finishSession();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, bookTitle, format, chapterHref, playChapter, finishSession, d]);

  const pause = useCallback(() => {
    playerRef.current?.pause();
    setMediaPlaybackState('paused');
    setState(s => (s.status === 'playing' ? { ...s, status: 'paused' } : s));
  }, []);

  const resume = useCallback(() => {
    setMediaPlaybackState('playing');
    setState(s => (s.status === 'paused' ? { ...s, status: 'playing' } : s));
    const player = playerRef.current;
    if (!player) return Promise.resolve();
    return player.resume().then(() => undefined);
  }, []);

  const skipSegment = useCallback(() => {
    // 中断当前段音频 → 循环进入下一段（'aborted' 视为段中断但会话延续）
    playerRef.current?.stop();
  }, []);

  const setRate = useCallback((rate: number) => {
    // 未启动时仅记忆（start 后首段即生效：playBlob 读取会话 rate）
    playerRef.current?.setRate(rate);
    setState(s => ({ ...s, rate }));
  }, []);

  // 卸载清理
  useEffect(() => {
    return () => {
      sessionGenRef.current += 1;
      abortRef.current = true;
      playerRef.current?.stop();
      playerRef.current?.destroy();
      playerRef.current = null;
      setMediaActionHandlers(null);
      setMediaPlaybackState('none');
    };
  }, []);

  // MediaSession 播放状态同步
  useEffect(() => {
    if (state.status === 'playing') setMediaPlaybackState('playing');
    else if (state.status === 'paused') setMediaPlaybackState('paused');
  }, [state.status]);

  return {
    session: state,
    start: () => { void start(); },
    pause,
    resume: () => { void resume(); },
    stop,
    skipSegment,
    setRate,
  };
}
