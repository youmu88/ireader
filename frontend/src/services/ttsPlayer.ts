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
import { getToken } from './authService';

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
  /** 后台播放被中断时回调（如浏览器阻止继续播放） */
  onBackgroundInterrupted?: () => void;
}

// ===== 文本分段 =====

/**
 * 将长文本按句子边界分成适度长度的段落
 * 每段 < 200 字符，优先按句号 / 段落分
 */
export function splitText(text: string): string[] {
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
 * 完整的 HTML 实体映射表（覆盖 EPUB 中常用实体）
 */
const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': '\u00A0',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&hellip;': '\u2026',
  '&lsquo;': '\u2018',
  '&rsquo;': '\u2019',
  '&sbquo;': '\u201A',
  '&ldquo;': '\u201C',
  '&rdquo;': '\u201D',
  '&bdquo;': '\u201E',
  '&laquo;': '\u00AB',
  '&raquo;': '\u00BB',
  '&copy;': '\u00A9',
  '&reg;': '\u00AE',
  '&trade;': '\u2122',
  '&bull;': '\u2022',
  '&middot;': '\u00B7',
  '&sect;': '\u00A7',
  '&para;': '\u00B6',
  '&deg;': '\u00B0',
  '&plusmn;': '\u00B1',
  '&times;': '\u00D7',
  '&divide;': '\u00F7',
  '&prime;': '\u2032',
  '&Prime;': '\u2033',
  '&euro;': '\u20AC',
  '&pound;': '\u00A3',
  '&yen;': '\u00A5',
  '&cent;': '\u00A2',
};/**
 * 简易 HTML 去标签，提取纯文本
 */
function stripHtml(html: string): string {
  return html
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    // 解码所有 HTML 实体（命名 + 数字）
    .replace(/&[a-zA-Z]+;/g, (match) => HTML_ENTITY_MAP[match] || match)
    .replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m: string, n: string) => String.fromCharCode(parseInt(n, 16)))
    // Remove leading whitespace from each line (artifact of HTML indentation)
    .replace(/^[ \t]+/gm, '')
    // Remove whitespace-only lines
    .replace(/^[ \t]+$/gm, '')
    // Collapse multiple whitespace chars to single space
    .replace(/[\r\n]+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
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
  private voice = 'zh-CN-XiaoxiaoNeural';
  private preGenCount = 3;
  private isDestroyed = false;
  private currentSegmentText = '';
  private volume = 1.0;
  /** Number of chunks before any appendSegments() call — chapter boundary */
  private originalChunkCount = 0;
  /** Whether next chapter segments have already been appended */
  private nextChapterAppended = false;
  /** Bound visibilitychange handler for cleanup */
  private boundVisibilityHandler: (() => void) | null = null;


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

    // ⭐ 初始化后台播放支持（Media Session API + AudioContext 自动恢复）
    this.setupBackgroundPlayback();
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

  // ── 设置音量 ──

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1.0, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }

  getVolume(): number {
    return this.volume;
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
  /** 获取原始章节的分段数量（appendSegments 前的边界） */
  getOriginalChunkCount(): number {
    return this.originalChunkCount;
  }

  /**
   * 追加下一章节的文本分段，实现章节间无缝衔接播放
   * 在朗读当前章节末段时调用，后台预生成下一章节音频
   */
  appendSegments(segments: string[]): void {
    if (this.isDestroyed || segments.length === 0) return;
    if (this.nextChapterAppended) return; // 防止重复追加
    this.nextChapterAppended = true;

    // 记录边界（原始章节分段数）
    this.originalChunkCount = this.chunks.length;

    // 创建新分段，index 从当前末尾继续编号
    const startIdx = this.chunks.length;
    const newChunks: TTSChunk[] = segments.map((text, i) => ({
      index: startIdx + i,
      text,
      status: 'pending' as const,
    }));
    this.chunks.push(...newChunks);

    // 立即预生成前 preGenCount 个追加分段的音频
    const end = Math.min(startIdx + this.preGenCount - 1, this.chunks.length - 1);
    this.preGenRange(startIdx, end);
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
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;
    this.setState('loading');

    // 预生成前 preGenCount 个片段
    await this.preGenRange(0, Math.min(this.preGenCount, this.chunks.length) - 1);
  }

  // ── 播放控制 ──

  async play(): Promise<void> {
    if (this.isDestroyed) return;

    if (this.state === 'paused' && this.sourceNode && this.audioContext) {
      // 恢复播放：如果 AudioContext 被浏览器挂起（切后台等），先恢复
      if (this.audioContext.state === 'suspended') {
        try {
          await this.audioContext.resume();
        } catch {
          // 恢复失败，通知上层
          this.callbacks.onBackgroundInterrupted?.();
          return;
        }
      } else {
        await this.audioContext.resume();
      }
      this.setState('playing');
      return;
    }

    if (this.state === 'loading' || this.state === 'idle') {
      // 确保 AudioContext 未被挂起
      if (this.audioContext?.state === 'suspended') {
        try { await this.audioContext.resume(); } catch { /* silent */ }
      }
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

    // 清理后台播放相关
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    // 清除 Media Session 元数据
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    }

    if (this.audioContext) {
      this.audioContext.onstatechange = null;
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.gainNode = null;
  }

  // ── 核心播放循环 ──

  // ════════════════════════════════════════════
  // 后台播放支持
  // ════════════════════════════════════════════

  /**
   * 初始化后台播放支持：
   * 1. Media Session API — 告诉浏览器正在播放音频，部分浏览器（Android Chrome）会保持播放
   * 2. AudioContext state change — 被挂起时自动尝试恢复
   * 3. visibilitychange — 从后台切回前台时恢复 AudioContext
   */
  private setupBackgroundPlayback(): void {
    if (this.isDestroyed) return;

    // ── 1. Media Session API ──
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: 'iReader 语音朗读',
          artist: 'iReader',
          album: '有声书',
        });
        navigator.mediaSession.playbackState = 'playing';

        // 注册媒体控制按钮（锁屏/通知栏控制）
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('stop', () => this.stop());
      } catch { /* Media Session 不可用则静默跳过 */ }
    }

    // ── 2. AudioContext 状态变化监听 ──
    if (this.audioContext) {
      this.audioContext.onstatechange = () => {
        if (this.isDestroyed || !this.audioContext) return;
        if (this.audioContext.state === 'suspended' && this.state === 'playing') {
          // 浏览器挂起了 AudioContext → 尝试自动恢复
          this.audioContext.resume().catch(() => {
            // 恢复失败，通知上层（如浏览器阻止了自动播放）
            this.callbacks.onBackgroundInterrupted?.();
          });
        }
      };
    }

    // ── 3. visibilitychange：从后台切回前台时恢复 AudioContext ──
    this.boundVisibilityHandler = () => {
      if (this.isDestroyed) return;
      if (document.visibilityState === 'visible' && this.audioContext?.state === 'suspended') {
        this.audioContext.resume().catch(() => {});
        // 更新 Media Session 状态
        if ('mediaSession' in navigator) {
          try { navigator.mediaSession.playbackState = 'playing'; } catch { /* ignore */ }
        }
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
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
    const token = getToken();
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
