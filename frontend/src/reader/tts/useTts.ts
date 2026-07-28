/**
 * useTts —— React hook 封装 DefaultTtsController
 *
 * 提供：
 *   - 响应式 state / currentSegmentIndex / totalSegments
 *   - start / pause / resume / stop / jumpToSegment
 *   - onSegmentChange 回调（UI 高亮 + 自动滚动）
 *   - onChapterEnd 回调（跨章续播）
 *   - 自动清理（组件卸载时 destroy）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DefaultTtsController } from './DefaultTtsController';
import type { TtsState } from './types';
import type { ReadingPosition } from '../position/types';
import type { ReaderEngine } from '../engine/types';

export interface UseTtsOptions {
  bookId: string | undefined;
  engine: ReaderEngine | null;
  speed?: number;
  voice?: string;
  source?: string;
  noCache?: boolean;
}

export interface UseTtsResult {
  state: TtsState;
  currentSegmentIndex: number;
  totalSegments: number;
  /** 当前播放分段文本 */
  segmentText: string;
  /** 从阅读位置开始播放 */
  start: (pos: ReadingPosition) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  jumpToSegment: (index: number) => Promise<void>;
  setSpeed: (speed: number) => void;
  setVoice: (voice: string) => void;
  /** 获取控制器实例（供高级场景） */
  getController: () => DefaultTtsController | null;
}

export function useTts(options: UseTtsOptions): UseTtsResult {
  const { bookId, engine, speed, voice, source, noCache } = options;

  const controllerRef = useRef<DefaultTtsController | null>(null);
  const [state, setState] = useState<TtsState>('idle');
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [totalSegments, setTotalSegments] = useState(0);
  const [segmentText, setSegmentText] = useState('');

  // 创建/销毁控制器
  useEffect(() => {
    if (!bookId || !engine) return;

    const ctrl = new DefaultTtsController({
      bookId,
      engine,
      speed,
      voice,
      source,
      noCache,
    });
    controllerRef.current = ctrl;

    const unsubState = ctrl.onStateChange((s) => setState(s));
    const unsubSegment = ctrl.onSegmentChange((idx, text) => {
      setCurrentSegmentIndex(idx);
      setSegmentText(text);
    });

    return () => {
      unsubState();
      unsubSegment();
      ctrl.destroy();
      controllerRef.current = null;
      setState('idle');
      setCurrentSegmentIndex(-1);
      setSegmentText('');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, engine]);

  // 同步 speed/voice 变化
  useEffect(() => {
    if (speed != null) controllerRef.current?.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    if (voice) controllerRef.current?.setVoice(voice);
  }, [voice]);

  const start = useCallback(async (pos: ReadingPosition) => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    await ctrl.startFromPosition(pos);
    setTotalSegments(ctrl.totalSegments);
  }, []);

  const pause = useCallback(() => { controllerRef.current?.pause(); }, []);
  const resume = useCallback(() => { controllerRef.current?.resume(); }, []);

  const stop = useCallback(() => {
    controllerRef.current?.stop();
    setCurrentSegmentIndex(-1);
    setSegmentText('');
  }, []);

  const jumpToSegment = useCallback(async (index: number) => {
    await controllerRef.current?.jumpToSegment(index);
  }, []);

  const setSpeedFn = useCallback((s: number) => {
    controllerRef.current?.setSpeed(s);
  }, []);

  const setVoiceFn = useCallback((v: string) => {
    controllerRef.current?.setVoice(v);
  }, []);

  const getController = useCallback(() => controllerRef.current, []);

  return {
    state,
    currentSegmentIndex,
    totalSegments,
    segmentText,
    start,
    pause,
    resume,
    stop,
    jumpToSegment,
    setSpeed: setSpeedFn,
    setVoice: setVoiceFn,
    getController,
  };
}
