/**
 * useTtsSession — 听书会话状态机（Phase 2 D2 播放层核心编排；ai-agent 移植）
 *
 * 状态流转：idle → loading(拉设置/章节/分段/缓存索引) → playing ⇄ paused → idle
 * 章节推进：按后端章节表顺序 goTo(displayHref) → 拉分段 → 逐段播放；
 * 段推进：解码缓存优先（预解码 + 下一段预取，命中零等待）→ 合成兜底
 *         （失败重试 1 次后跳过并计数，不中断整章）；
 * 段级中断 vs 会话级中断：seek（章内拖动）/skip（跳段）只换播放位置，会话延续；
 *         stop/finishSession 才终止会话（旧实现 skip 实为终止会话，已修正）。
 * 章内进度：段时长 = 已解码真实 duration / 未解码按语速估算；elapsed/duration 每 250ms 上报，
 *         seekTo(fraction) 换算「段 + 段内偏移」后中断当前段、循环从目标位置续播。
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
  findStartByAnchorRatio,
  normalizeHref,
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

/** 中文播报语速估算（ai-agent 实测 Kokoro 4.3~5 字/s 取中值）：未解码段的时长估算基准 */
const SPEECH_CHARS_PER_SECOND = 4.7;
/** 解码缓存上限（段）：400 字段 ≈ 85s ≈ 4MB，8 段 ≈ 32MB，LRU 淘汰 */
const DECODED_CACHE_MAX = 8;
/** 章内进度上报周期（ms） */
const PROGRESS_TICK_MS = 250;

export interface TtsSessionState {
  status: TtsStatus;
  /** 当前朗读段文本（overlay 展示） */
  currentText: string;
  currentSegmentIndex: number;
  currentChapterTitle: string;
  /** 整书段进度（当前章/全部章估算） */
  progress: number;
  /** 章内已播秒数（进度条 seek 用） */
  elapsed: number;
  /** 章内总时长（秒，进度条 seek 用） */
  duration: number;
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
  /** 当前阅读位置全书百分比 0~1（location.percentage；合辑 EPUB 多章共文件时占比定位唯一可靠） */
  bookPercentage: number | null;
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
  elapsed: 0,
  duration: 0,
  failedCount: 0,
  rate: 1.0,
};

/** 段解码缓存键（章内唯一） */
const segKeyOf = (chapterId: string, segmentIndex: number): string => `${chapterId}:${segmentIndex}`;

export function useTtsSession(options: UseTtsSessionOptions) {
  const { bookId, bookTitle, format, controllerRef, chapterHref, bookPercentage, onSegmentStart, deps } = options;
  const d = { ...defaultDeps, ...deps };

  const [state, setState] = useState<TtsSessionState>(INITIAL_STATE);
  /** 会话代际：stop/重开时 +1，旧异步循环凭代际退出 */
  const sessionGenRef = useRef(0);
  const abortRef = useRef(false);
  const playerRef = useRef<TtsPlayerLike | null>(null);
  /** 最新 chapterHref/bookPercentage/章节表快照（异步循环内读取，避免闭包过期） */
  const chapterHrefRef = useRef(chapterHref);
  chapterHrefRef.current = chapterHref;
  const bookPercentageRef = useRef(bookPercentage);
  bookPercentageRef.current = bookPercentage;
  const chapterListRef = useRef<TtsChapterEntry[]>([]);
  const onSegmentStartRef = useRef(onSegmentStart);
  onSegmentStartRef.current = onSegmentStart;
  const stateRef = useRef(state);
  stateRef.current = state;

  /** 段解码缓存（ai-agent 移植）：命中零等待起播；LRU 淘汰 */
  const decodedCacheRef = useRef(new Map<string, AudioBuffer>());
  /** 当前章段时长表（秒）：解码后回写真值，未解码按语速估算 */
  const segDurationsRef = useRef<number[]>([]);
  const chapterTotalRef = useRef(0);
  /** 当前段之前累计秒数（章内 elapsed 基座） */
  const elapsedBaseRef = useRef(0);
  const currentSegDurRef = useRef(0);
  /** 段级中断请求（章内 seek）：播放循环捕获 aborted 后消费、从目标位置续播 */
  const seekRequestRef = useRef<{ index: number; offset: number } | null>(null);
  /** 段级中断请求（跳段）：播放循环捕获 aborted 后进下一段，会话延续 */
  const skipRequestRef = useRef(false);

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

  /** 会话自然结束/中断归位：保留 failedCount 等统计（用户可感知跳段数） */
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

    // 章切换：重置章内进度模型与解码缓存（跨章不复用，防累积）
    decodedCacheRef.current.clear();
    segDurationsRef.current = segments.map(s => s.text.length / SPEECH_CHARS_PER_SECOND);
    chapterTotalRef.current = segDurationsRef.current.reduce((a, b) => a + b, 0);
    elapsedBaseRef.current = 0;
    currentSegDurRef.current = segDurationsRef.current[0] ?? 0;

    /** 解码缓存优先：命中零等待；合成→解码→缓存；并发去重（预取与消费共享同一 promise） */
    const inFlight = new Map<string, Promise<AudioBuffer | null>>();
    const ensureDecoded = (idx: number, seg: TtsSegmentInfo): Promise<AudioBuffer | null> => {
      const key = segKeyOf(chapter.chapterId, seg.segmentIndex);
      const hit = decodedCacheRef.current.get(key);
      if (hit) return Promise.resolve(hit);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const task = (async (): Promise<AudioBuffer | null> => {
        const blob = await d.resolveAudio(seg, {
          cacheMap, voice, speed, bookId, chapterId: chapter.chapterId, noCache,
        });
        if (!blob) return null;
        try {
          const buffer = await player.decodeBlob(blob);
          decodedCacheRef.current.set(key, buffer);
          while (decodedCacheRef.current.size > DECODED_CACHE_MAX) {
            const oldest = decodedCacheRef.current.keys().next().value;
            if (oldest === undefined) break;
            decodedCacheRef.current.delete(oldest);
          }
          // 真实时长回写 → 章内进度模型随播放逐步校准
          if (segDurationsRef.current[idx] !== buffer.duration) {
            segDurationsRef.current[idx] = buffer.duration;
            chapterTotalRef.current = segDurationsRef.current.reduce((a, b) => a + (b || 0), 0);
          }
          return buffer;
        } catch {
          return null; // 解码失败按坏段跳过
        }
      })();
      inFlight.set(key, task);
      void task.finally(() => inFlight.delete(key));
      return task;
    };

    const elapsedBaseOf = (idx: number): number => {
      let acc = 0;
      for (let k = 0; k < idx; k++) acc += segDurationsRef.current[k] || 0;
      return acc;
    };

    let i = 0;
    let startOffset = 0;
    while (i < segments.length) {
      if (abortRef.current || sessionGenRef.current !== gen) return false;
      const seg = segments[i];
      currentSegDurRef.current =
        segDurationsRef.current[i] || seg.text.length / SPEECH_CHARS_PER_SECOND;
      setState(s => ({
        ...s,
        status: 'playing',
        currentText: seg.text,
        currentSegmentIndex: seg.segmentIndex,
        progress: baseProgress + chapterWeight * (i / segments.length),
      }));
      onSegmentStartRef.current?.(seg);
      elapsedBaseRef.current = elapsedBaseOf(i);

      const buffer = await ensureDecoded(i, seg);
      if (abortRef.current || sessionGenRef.current !== gen) return false;
      if (!buffer) {
        setState(s => ({ ...s, failedCount: s.failedCount + 1 }));
        i++;
        continue; // 跳过坏段，不中断整章
      }

      // 预取下一段（合成+解码不阻塞当前段播放）
      if (i + 1 < segments.length) void ensureDecoded(i + 1, segments[i + 1]);

      const finish = await player.playBuffer(segKeyOf(chapter.chapterId, seg.segmentIndex), buffer, {
        offset: startOffset,
        rate: stateRef.current.rate,
      });
      startOffset = 0;
      if (finish === 'aborted') {
        // 会话级中断（stop/finishSession/代际失效）：会话终止
        if (abortRef.current || sessionGenRef.current !== gen) return false;
        // 段级中断①：章内 seek → 从目标位置续播
        const seekReq = seekRequestRef.current;
        if (seekReq) {
          seekRequestRef.current = null;
          i = Math.max(0, Math.min(seekReq.index, segments.length - 1));
          startOffset = seekReq.offset;
          continue;
        }
        // 段级中断②：跳段（skipSegment / 耳机下一曲）→ 下一段，会话延续
        if (skipRequestRef.current) {
          skipRequestRef.current = false;
          i++;
          continue;
        }
        return false;
      }
      i++;
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
    seekRequestRef.current = null;
    skipRequestRef.current = false;
    decodedCacheRef.current.clear();
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

      // 起始章定位：①合辄书（多章共文件靠 fragment 区分）用渲染文档内锚点像素占比（同源同基准）；
      // ②回退 findStartChapterIndex：全书占比（TXT offset/字长累计）→ href 匹配
      let startIndex = -1;
      const curHref = chapterHrefRef.current;
      if (curHref) {
        const curFile = curHref.split('#')[0].trim().replace(/^\/+/, '');
        const sameFile = chapterList.filter(c => c.displayHref.includes('#') && normalizeHref(c.displayHref) === curFile);
        if (sameFile.length >= 2) {
          const layout = controllerRef.current?.getAnchorLayout?.(sameFile.map(c => c.displayHref));
          if (layout && layout.viewportRatio != null) {
            startIndex = findStartByAnchorRatio(chapterList, layout.ratios, layout.viewportRatio);
          }
        }
      }
      if (startIndex < 0) {
        startIndex = findStartChapterIndex(chapterList, chapterHrefRef.current, bookPercentageRef.current);
      }
      setState(s => ({ ...s, rate: settings.speed }));
      // async 播放链同步读 stateRef（playBuffer rate）；setState 的 render 时机滞后一拍，这里同步回写
      stateRef.current = { ...stateRef.current, rate: settings.speed };

      setMediaActionHandlers({
        play: () => { void resume(); },
        pause: () => { pause(); },
        stop: () => { stop(); },
        // 耳机下一曲/上一曲 = 跳段（会话延续），而非终止会话
        nextSegment: () => {
          skipRequestRef.current = true;
          playerRef.current?.stop();
        },
        prevSegment: () => {
          skipRequestRef.current = true;
          playerRef.current?.stop();
        },
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
    // 段级中断：标记后停当前段 → 播放循环进下一段（会话延续；旧实现误终止会话，已修正）
    skipRequestRef.current = true;
    playerRef.current?.stop();
  }, []);

  /** 章内拖动跳转：fraction∈[0,1] → 换算段+段内偏移 → 中断当前段，循环从目标位置续播 */
  const seekTo = useCallback((fraction: number) => {
    const durations = segDurationsRef.current;
    if (durations.length === 0) return;
    const total =
      chapterTotalRef.current > 0 ? chapterTotalRef.current : durations.reduce((a, b) => a + b, 0);
    const target = Math.max(0, Math.min(1, fraction)) * total;
    let acc = 0;
    let idx = durations.length - 1;
    let offset = 0;
    for (let k = 0; k < durations.length; k++) {
      const segDur = durations[k] || 0;
      if (acc + segDur > target) {
        idx = k;
        offset = target - acc;
        break;
      }
      acc += segDur;
    }
    seekRequestRef.current = { index: idx, offset };
    elapsedBaseRef.current = acc;
    setState(s => ({
      ...s,
      status: s.status === 'idle' ? s.status : 'playing',
      elapsed: target,
      duration: total,
    }));
    playerRef.current?.stop();
  }, []);

  const setRate = useCallback((rate: number) => {
    // 未启动时仅记忆（playBuffer 读取会话 rate）；播放中热切换重锚进度
    playerRef.current?.setRate(rate);
    setState(s => ({ ...s, rate }));
    stateRef.current = { ...stateRef.current, rate }; // async 链同步读取，避免 setState render 滞后
  }, []);

  // 章内进度上报（playing 时 250ms 轮询；paused 冻结在最后值）
  useEffect(() => {
    if (state.status !== 'playing') return;
    const timer = setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      const inSeg = Math.max(0, Math.min(player.getElapsed(), currentSegDurRef.current));
      setState(s => {
        const duration = chapterTotalRef.current;
        if (duration <= 0) return s;
        return { ...s, elapsed: elapsedBaseRef.current + inSeg, duration };
      });
    }, PROGRESS_TICK_MS);
    return () => clearInterval(timer);
  }, [state.status]);

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
    seekTo,
    setRate,
  };
}
