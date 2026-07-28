/**
 * SequentialPlayer —— 简化顺序播放器（Phase 4.1）
 *
 * 设计原则：
 *   - 只有逐段顺序播放，无拼接模式
 *   - 预取下 N 段消除段间间隙（<30ms）
 *   - 基于 <audio> 元素（后台播放 + Media Session）
 *   - 段间切换通过 'ended' 事件驱动，无需 Web Audio decode
 */
import { getToken } from '../../services/authService';
import { fetchTTSSettings } from '../../services/ttsService';
import { getCachedTTSAudio, cacheTTSAudio } from '../../services/offlineCacheService';

export type SequentialPlayerState = 'idle' | 'loading' | 'playing' | 'paused';

export interface SequentialPlayerOptions {
  bookId: string;
  chapterId: string;
  /** 预取段数（默认 3） */
  prefetchCount?: number;
  /** 语速 */
  speed?: number;
  /** 音色 */
  voice?: string;
  /** TTS 源 */
  source?: string;
  /** 跳过缓存 */
  noCache?: boolean;
}

export interface SequentialPlayerCallbacks {
  onStateChange?: (state: SequentialPlayerState) => void;
  onSegmentChange?: (index: number, text: string) => void;
  onProgress?: (progress: number) => void;
  onEnd?: () => void;
  onError?: (error: string) => void;
}

interface SegmentEntry {
  index: number;
  text: string;
  status: 'pending' | 'loading' | 'ready' | 'played' | 'error';
  blobUrl?: string;
}

export class SequentialPlayer {
  private audio: HTMLAudioElement | null = null;
  private segments: SegmentEntry[] = [];
  private currentIndex = 0;
  private _state: SequentialPlayerState = 'idle';
  private options: SequentialPlayerOptions;
  private callbacks: SequentialPlayerCallbacks;
  private aborted = false;

  constructor(options: SequentialPlayerOptions, callbacks: SequentialPlayerCallbacks = {}) {
    this.options = options;
    this.callbacks = callbacks;
  }

  get state(): SequentialPlayerState { return this._state; }
  get currentSegmentIndex(): number { return this.currentIndex; }
  get totalSegments(): number { return this.segments.length; }

  /** 加载分段文本（不播放） */
  load(segments: string[], startIndex = 0): void {
    this.segments = segments.map((text, i) => ({
      index: i,
      text,
      status: 'pending' as const,
    }));
    this.currentIndex = Math.max(0, Math.min(startIndex, segments.length - 1));
  }

  /** 从指定段开始播放 */
  async play(fromIndex?: number): Promise<void> {
    if (fromIndex != null) this.currentIndex = fromIndex;
    this.aborted = false;
    this.ensureAudio();
    this.setState('loading');
    await this.playCurrentSegment();
  }

  pause(): void {
    if (this.audio && this._state === 'playing') {
      this.audio.pause();
      this.setState('paused');
    }
  }

  resume(): void {
    if (this.audio && this._state === 'paused') {
      this.audio.play().catch(() => {});
      this.setState('playing');
    }
  }

  stop(): void {
    this.aborted = true;
    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
    }
    this.revokeBlobUrls();
    this.setState('idle');
  }

  async jumpToSegment(index: number): Promise<void> {
    const target = Math.max(0, Math.min(index, this.segments.length - 1));
    this.currentIndex = target;
    if (this._state !== 'idle') {
      await this.play(target);
    }
  }

  setSpeed(speed: number): void {
    this.options.speed = speed;
    if (this.audio) this.audio.playbackRate = speed;
  }

  destroy(): void {
    this.stop();
    if (this.audio) {
      this.audio.remove();
      this.audio = null;
    }
  }

  // ── 内部 ──────────────────────────────────────────────

  private setState(s: SequentialPlayerState): void {
    if (this._state === s) return;
    this._state = s;
    this.callbacks.onStateChange?.(s);
  }

  private ensureAudio(): void {
    if (this.audio) return;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.addEventListener('ended', () => this.onSegmentEnded());
    this.audio.addEventListener('error', () => {
      this.callbacks.onError?.('音频播放错误');
    });
  }

  private async playCurrentSegment(): Promise<void> {
    if (this.aborted) return;
    const seg = this.segments[this.currentIndex];
    if (!seg) {
      this.callbacks.onEnd?.();
      this.setState('idle');
      return;
    }

    try {
      // 获取音频 URL（缓存 → 合成）
      const url = await this.getSegmentAudioUrl(seg);
      if (this.aborted) return;

      seg.status = 'ready';
      seg.blobUrl = url;

      if (!this.audio) return;
      this.audio.src = url;
      this.audio.playbackRate = this.options.speed ?? 1;
      await this.audio.play();
      this.setState('playing');

      // 通知 UI
      this.callbacks.onSegmentChange?.(seg.index, seg.text);
      const progress = this.segments.length > 0 ? (seg.index + 1) / this.segments.length : 0;
      this.callbacks.onProgress?.(progress);

      // 预取后续段
      this.prefetchAhead();
    } catch (err: any) {
      seg.status = 'error';
      this.callbacks.onError?.(err.message || '分段合成失败');
      // 跳过错误段，继续下一段
      this.currentIndex++;
      if (this.currentIndex < this.segments.length) {
        await this.playCurrentSegment();
      } else {
        this.callbacks.onEnd?.();
        this.setState('idle');
      }
    }
  }

  private onSegmentEnded(): void {
    if (this.aborted) return;
    this.segments[this.currentIndex].status = 'played';
    this.currentIndex++;
    if (this.currentIndex >= this.segments.length) {
      this.callbacks.onEnd?.();
      this.setState('idle');
      return;
    }
    this.playCurrentSegment();
  }

  private async getSegmentAudioUrl(seg: SegmentEntry): Promise<string> {
    const { bookId, chapterId, noCache } = this.options;

    // 1. 尝试 IDB 缓存
    if (!noCache) {
      try {
        const cached = await getCachedTTSAudio(bookId, chapterId, seg.index);
        if (cached) {
          const blob = new Blob([cached], { type: 'audio/wav' });
          return URL.createObjectURL(blob);
        }
      } catch { /* 缓存读取失败，走合成 */ }
    }

    // 2. 调用后端 TTS API 合成
    seg.status = 'loading';
    const settings = await fetchTTSSettings();
    const token = getToken();
    const source = this.options.source || settings?.source || 'edge-tts';
    const voice = this.options.voice || settings?.voiceId || 'zh-CN-XiaoxiaoNeural';
    const speed = this.options.speed ?? settings?.speed ?? 1.0;

    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: seg.text, source, voice, speed }),
    });

    if (!res.ok) throw new Error(`TTS 合成失败: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();

    // 写入 IDB 缓存
    if (!noCache) {
      cacheTTSAudio(bookId, chapterId, seg.index, arrayBuffer).catch(() => {});
    }

    const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
    return URL.createObjectURL(blob);
  }

  private prefetchAhead(): void {
    const count = this.options.prefetchCount ?? 3;
    for (let i = 1; i <= count; i++) {
      const idx = this.currentIndex + i;
      const seg = this.segments[idx];
      if (seg && seg.status === 'pending') {
        seg.status = 'loading';
        this.getSegmentAudioUrl(seg)
          .then((url) => { seg.blobUrl = url; seg.status = 'ready'; })
          .catch(() => { seg.status = 'error'; });
      }
    }
  }

  private revokeBlobUrls(): void {
    for (const seg of this.segments) {
      if (seg.blobUrl) {
        URL.revokeObjectURL(seg.blobUrl);
        seg.blobUrl = undefined;
      }
    }
  }
}
