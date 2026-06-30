/**
 * TTS Player — Web Audio API 驱动的分片预生成 TTS 播放引擎
 *
 * 功能：
 * 1. 将长文本按句子分段
 * 2. 逐段调用后端 TTS API 合成语音
 * 3. 边播边预生成后续段落
 * 4. 播放 / 暂停 / 停止 / 语速控制
 * 5. 状态事件回调
 */

import { fetchTTSSettings } from './ttsService';

// ===== 类型定义 =====

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

interface TTSChunk {
  index: number;
  text: string;
  status: 'pending' | 'loading' | 'ready' | 'played' | 'error';
  audioBuffer?: AudioBuffer;
  error?: string;
}

export interface TTSPlayerOptions {
  source?: string;
  voice?: string;
  speed?: number;
  preGenCount?: number;
}

export interface TTSPlayerCallbacks {
  onStateChange?: (state: PlayerState) => void;
  /** 当前播放到第几段（0-based），共几段 */
  onSegmentPlay?: (currentIndex: number, total: number) => void;
  /** 总体进度 0~1 */
  onProgress?: (progress: number) => void;
  onError?: (error: string) => void;
  onEnd?: () => void;
}

// ===== 文本分段 =====

/**
 * 将长文本按句子边界分成适度长度的段落
 * 每段 < 200 字符，优先按句号 / 段落分
 */
function splitText(text: string): string[] {
  const segments: string[] = [];

  // 按双换行分段（段落级）
  const paragraphs = text.split(/\n\s*\n/);

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // 按句子分割
    const sentences = trimmed.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [trimmed];
    for (const sentence of sentences) {
      const st = sentence.trim();
      if (!st) continue;

      if (st.length > 200) {
        // 超长句子按逗号分割
        const subParts = st.match(/[^，、,；;：:]+[，、,；;：:]?/g) || [st];
        for (const part of subParts) {
          const pt = part.trim();
          if (pt) segments.push(pt);
        }
      } else {
        segments.push(st);
      }
    }
  }

  return segments.filter((s) => s.length > 0);
}

/**
 * 简易 HTML 去标签，提取纯文本
 */
function stripHtml(html: string): string {
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
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== TTSPlayer =====

export class TTSPlayer {
  private audioContext: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private chunks: TTSChunk[] = [];
  private currentIndex = -1;
  private state: PlayerState = 'idle';
  private callbacks: TTSPlayerCallbacks = {};
  private speed = 1.0;
  private source = 'kokoro';
  private voice = 'zf_xiaobei';
  private preGenCount = 3;
  private isDestroyed = false;
  private currentSegmentText = '';

  // ── 初始化 ──

  async init(options?: TTSPlayerOptions): Promise<void> {
    if (options?.speed) this.speed = options.speed;
    if (options?.source) this.source = options.source;
    if (options?.voice) this.voice = options.voice;
    if (options?.preGenCount) this.preGenCount = options.preGenCount;

    // 尝试加载后端设置
    try {
      const settings = await fetchTTSSettings();
      this.source = settings.source || this.source;
      this.voice = settings.voiceId || this.voice;
      this.speed = settings.speed ?? this.speed;
    } catch {
      // 使用默认值
    }

    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    if (!this.gainNode) {
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
    }
  }

  // ── 设置回调 ──

  setCallbacks(cbs: TTSPlayerCallbacks): void {
    this.callbacks = cbs;
  }

  // ── 设置语速 ──

  setSpeed(speed: number): void {
    this.speed = Math.max(0.5, Math.min(2.0, speed));
    // 如果正在播放，实时调整
    if (this.sourceNode && this.state === 'playing') {
      this.sourceNode.playbackRate.value = this.speed;
    }
  }

  getSpeed(): number {
    return this.speed;
  }

  getState(): PlayerState {
    return this.state;
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getTotalChunks(): number {
    return this.chunks.length;
  }

  /** 获取当前正在朗读的段落文本 */
  getCurrentSegmentText(): string {
    return this.currentSegmentText;
  }

  // ── 加载文本 ──

  /**
   * 加载要朗读的文本（纯文本或 HTML），准备播放
   */
  async load(text: string, isHtml = false): Promise<void> {
    if (this.isDestroyed) return;

    // 停止当前播放
    this.stopInternal();

    const plainText = isHtml ? stripHtml(text) : text;
    const segments = splitText(plainText);

    if (segments.length === 0) {
      this.callbacks.onError?.('没有可朗读的文本内容');
      return;
    }

    this.chunks = segments.map((seg, i) => ({
      index: i,
      text: seg,
      status: 'pending' as const,
    }));

    this.currentIndex = -1;
    this.setState('loading');

    // 预生成前 preGenCount 个片段
    await this.preGenRange(0, Math.min(this.preGenCount, this.chunks.length) - 1);
  }

  // ── 播放控制 ──

  async play(): Promise<void> {
    if (this.isDestroyed) return;

    if (this.state === 'paused' && this.sourceNode && this.audioContext) {
      // 恢复播放
      await this.audioContext.resume();
      this.setState('playing');
      return;
    }

    if (this.state === 'loading' || this.state === 'idle') {
      // 开始播放
      this.currentIndex = -1;
      this.playNext();
      return;
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    if (this.audioContext) {
      this.audioContext.suspend();
    }
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.play();
  }

  stop(): void {
    this.stopInternal();
    this.setState('idle');
    this.currentIndex = -1;
    this.currentSegmentText = '';
  }

  private stopInternal(): void {
    try {
      this.sourceNode?.stop();
    } catch { /* 已停止则忽略 */ }
    this.sourceNode?.disconnect();
    this.sourceNode = null;
  }

  destroy(): void {
    this.isDestroyed = true;
    this.stopInternal();
    this.callbacks = {};
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.gainNode = null;
  }

  // ── 核心播放循环 ──

  private async playNext(): Promise<void> {
    if (this.isDestroyed) return;

    this.currentIndex++;
    if (this.currentIndex >= this.chunks.length) {
      this.setState('idle');
      this.callbacks.onEnd?.();
      return;
    }

    const chunk = this.chunks[this.currentIndex];

    // 标记已播放的
    for (let i = 0; i < this.currentIndex; i++) {
      if (this.chunks[i].status === 'ready') {
        this.chunks[i].status = 'played';
      }
    }

    // 如果当前片段还没准备好，等待
    if (chunk.status === 'pending') {
      await this.fetchChunk(chunk);
    } else if (chunk.status === 'loading') {
      // 等待加载完成
      await this.waitForChunk(chunk);
    } else if (chunk.status === 'error') {
      // 跳过错误片段，尝试下一个
      this.callbacks.onError?.(`段落 ${chunk.index + 1} 合成失败: ${chunk.error || '未知错误'}`);
      this.playNext();
      return;
    }

    // 再次检查状态
    if (chunk.status !== 'ready' || !chunk.audioBuffer) {
      this.callbacks.onError?.(`段落 ${chunk.index + 1} 无可用音频`);
      this.playNext();
      return;
    }

    // 播放
    this.currentSegmentText = chunk.text;
    this.playAudioBuffer(chunk.audioBuffer);

    // 更新进度回调
    const progress = (this.currentIndex + 1) / this.chunks.length;
    this.callbacks.onSegmentPlay?.(this.currentIndex, this.chunks.length);
    this.callbacks.onProgress?.(progress);

    // 预生成后续片段
    this.preGenAhead(this.currentIndex);

    // 标记当前为 played
    chunk.status = 'played';
  }

  private playAudioBuffer(buffer: AudioBuffer): void {
    if (!this.audioContext || this.isDestroyed) return;

    this.stopInternal();

    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.speed;
    source.connect(this.gainNode!);

    this.sourceNode = source;
    this.setState('playing');

    source.start(0);

    // 监听结束
    source.onended = () => {
      if (this.isDestroyed) return;
      // 检查是否是自然结束
      if (this.state === 'playing') {
        this.playNext();
      }
    };
  }

  // ── 预生成 ──

  private preGenAhead(currentIndex: number): void {
    const start = currentIndex + 1;
    const end = Math.min(currentIndex + this.preGenCount, this.chunks.length - 1);
    this.preGenRange(start, end);
  }

  private async preGenRange(start: number, end: number): Promise<void> {
    for (let i = start; i <= end; i++) {
      const chunk = this.chunks[i];
      if (!chunk || chunk.status !== 'pending') continue;
      // 不等待，后台异步生成
      this.fetchChunk(chunk).catch(() => {});
    }
  }

  private async fetchChunk(chunk: TTSChunk): Promise<void> {
    if (chunk.status !== 'pending') return;
    chunk.status = 'loading';

    try {
      const arrayBuffer = await this.fetchTTSAudio(chunk.text);
      if (!this.audioContext) return;

      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      chunk.audioBuffer = audioBuffer;
      chunk.status = 'ready';
    } catch (err: any) {
      chunk.status = 'error';
      chunk.error = err.message || '合成失败';
    }
  }

  private waitForChunk(chunk: TTSChunk): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (chunk.status === 'ready' || chunk.status === 'error') {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  private async fetchTTSAudio(text: string): Promise<ArrayBuffer> {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: text,
        voice: this.voice,
        speed: this.speed,
        response_format: 'wav',
        tts_source: this.source,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '未知错误');
      throw new Error(`TTS 合成失败 (${res.status}): ${errBody.slice(0, 100)}`);
    }

    return res.arrayBuffer();
  }

  // ── 状态管理 ──

  private setState(s: PlayerState): void {
    if (this.state === s) return;
    this.state = s;
    this.callbacks.onStateChange?.(s);
  }
}

// ===== 辅助：创建默认播放器实例 =====

let defaultPlayer: TTSPlayer | null = null;

/**
 * 获取/创建单例 TTSPlayer（应用中只有一个播放器实例）
 */
export function getDefaultPlayer(): TTSPlayer {
  if (!defaultPlayer) {
    defaultPlayer = new TTSPlayer();
  }
  return defaultPlayer;
}

/**
 * 销毁默认播放器
 */
export function destroyDefaultPlayer(): void {
  if (defaultPlayer) {
    defaultPlayer.destroy();
    defaultPlayer = null;
  }
}
