/**
 * DefaultTtsController —— TtsController 接口实现（Phase 4.2）
 *
 * 职责：
 *   - 从 ReadingPosition 推算起播段（ratio * totalSegments）
 *   - 管理 SequentialPlayer 生命周期
 *   - 广播分段变化 / 状态变化 / 章节播完事件
 *   - 章节续播由外部通过 onChapterEnd 订阅处理
 */
import type { TtsController, TtsState } from './types';
import type { ReadingPosition } from '../position/types';
import type { ReaderEngine } from '../engine/types';
import { SequentialPlayer } from './SequentialPlayer';
import { splitText } from '../../services/ttsPlayer';

type SegmentListener = (index: number, text: string) => void;
type StateListener = (state: TtsState) => void;
type ChapterEndListener = () => void;

export interface DefaultTtsControllerOptions {
  bookId: string;
  engine: ReaderEngine;
  /** 合成语速（影响缓存身份） */
  synthesisRate?: number;
  /** 本地播放倍速（不影响缓存） */
  playbackRate?: number;
  voice?: string;
  source?: string;
  noCache?: boolean;
}

export class DefaultTtsController implements TtsController {
  private player: SequentialPlayer | null = null;
  private engine: ReaderEngine;
  private bookId: string;
  private opts: DefaultTtsControllerOptions;
  private segments: string[] = [];

  private segmentListeners = new Set<SegmentListener>();
  private stateListeners = new Set<StateListener>();
  private chapterEndListeners = new Set<ChapterEndListener>();

  private _state: TtsState = 'idle';
  private _currentSegmentIndex = 0;

  constructor(options: DefaultTtsControllerOptions) {
    this.opts = options;
    this.engine = options.engine;
    this.bookId = options.bookId;
  }

  get state(): TtsState { return this._state; }
  get currentSegmentIndex(): number { return this._currentSegmentIndex; }
  get totalSegments(): number { return this.segments.length; }

  async startFromPosition(pos: ReadingPosition): Promise<void> {
    // 获取当前章节全文
    const text = await this.engine.getFullChapterText();
    this.segments = splitText(text);
    if (this.segments.length === 0) return;

    // 推算起播段
    const startIdx = Math.min(
      Math.floor(pos.ratio * this.segments.length),
      this.segments.length - 1,
    );

    // 创建播放器
    this.destroyPlayer();
    this.player = new SequentialPlayer(
      {
        bookId: this.bookId,
        chapterId: pos.chapterId,
        synthesisRate: this.opts.synthesisRate,
        playbackRate: this.opts.playbackRate,
        voice: this.opts.voice,
        source: this.opts.source,
        noCache: this.opts.noCache,
      },
      {
        onStateChange: (s) => this.handleStateChange(s),
        onSegmentChange: (idx, segText) => this.handleSegmentChange(idx, segText),
        onEnd: () => this.handleEnd(),
        onError: () => {},
      },
    );

    this.player.load(this.segments, startIdx);
    await this.player.play(startIdx);
  }

  pause(): void { this.player?.pause(); }
  resume(): void { this.player?.resume(); }

  stop(): void {
    this.destroyPlayer();
    this.setState('idle');
  }

  async jumpToSegment(index: number): Promise<void> {
    await this.player?.jumpToSegment(index);
  }

  setPlaybackRate(rate: number): void {
    this.opts.playbackRate = rate;
    this.player?.setPlaybackRate(rate);
  }

  setSynthesisRate(rate: number): void {
    this.opts.synthesisRate = rate;
    this.player?.setSynthesisRate(rate);
  }

  setVoice(voice: string): void {
    this.opts.voice = voice;
  }

  onSegmentChange(cb: SegmentListener): () => void {
    this.segmentListeners.add(cb);
    return () => { this.segmentListeners.delete(cb); };
  }

  onStateChange(cb: StateListener): () => void {
    this.stateListeners.add(cb);
    return () => { this.stateListeners.delete(cb); };
  }

  onChapterEnd(cb: ChapterEndListener): () => void {
    this.chapterEndListeners.add(cb);
    return () => { this.chapterEndListeners.delete(cb); };
  }

  destroy(): void {
    this.destroyPlayer();
    this._state = 'idle';
    this.segmentListeners.clear();
    this.stateListeners.clear();
    this.chapterEndListeners.clear();
  }

  // ── 内部 ──────────────────────────────────────────────

  private setState(s: TtsState): void {
    if (this._state === s) return;
    this._state = s;
    this.stateListeners.forEach((cb) => cb(s));
  }

  private handleStateChange(s: string): void {
    this.setState(s as TtsState);
  }

  private handleSegmentChange(idx: number, text: string): void {
    this._currentSegmentIndex = idx;
    this.segmentListeners.forEach((cb) => cb(idx, text));
  }

  private handleEnd(): void {
    this.setState('idle');
    this.chapterEndListeners.forEach((cb) => cb());
  }

  private destroyPlayer(): void {
    if (this.player) {
      this.player.destroy();
      this.player = null;
    }
  }
}
