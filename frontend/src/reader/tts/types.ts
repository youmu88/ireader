/**
 * TtsController 接口定义（Phase 1.5）
 *
 * 设计原则：
 *   - 单模式：只有逐段顺序播放 + 预取缓冲，删除拼接模式
 *   - 起点由 ReadingPosition.ratio 决定，不再有多路启发式
 *   - 段间间隙通过预取下 N 段消除（<30ms）
 */
import type { ReadingPosition } from '../position/types';

/** TTS 播放状态 */
export type TtsState = 'idle' | 'loading' | 'playing' | 'paused';

/** TTS 控制器接口 */
export interface TtsController {
  /** 当前播放状态 */
  readonly state: TtsState;
  /** 当前播放分段索引 */
  readonly currentSegmentIndex: number;
  /** 总分段数 */
  readonly totalSegments: number;

  /**
   * 从阅读位置开始播放。
   * 起点 = floor(position.ratio * totalSegments)
   */
  startFromPosition(pos: ReadingPosition): Promise<void>;

  /** 暂停 */
  pause(): void;
  /** 恢复 */
  resume(): void;
  /** 停止（释放资源） */
  stop(): void;

  /** 跳转到指定分段 */
  jumpToSegment(index: number): Promise<void>;

  /** 设置语速 */
  setSpeed(speed: number): void;
  /** 设置音色 */
  setVoice(voice: string): void;

  // ── 事件订阅 ─────────────────────────────────────────

  /** 分段变化回调（用于 UI 高亮 + 自动翻页） */
  onSegmentChange(cb: (index: number, text: string) => void): () => void;
  /** 状态变化回调 */
  onStateChange(cb: (state: TtsState) => void): () => void;
  /** 章节播完回调（触发跨章续播） */
  onChapterEnd(cb: () => void): () => void;
}
