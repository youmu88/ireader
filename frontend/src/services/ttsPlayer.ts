/**
 * TTS Player — 基于 <audio> 元素的分片预生成 TTS 播放引擎
 *
 * 使用 <audio> 元素替代 Web Audio API 的 AudioContext/BufferSource，
 * 以确保在移动端切换到后台时仍能正常播放（浏览器原生媒体管道
 * 配合 Media Session API 保持后台音频）。
 *
 * 功能：
 * 1. 将长文本按句子分段
 * 2. 逐段调用后端 TTS API 合成语音（返回 WAV）
 * 3. 每段通过 <audio> 元素播放，片段间无缝衔接
 * 4. 播放 / 暂停 / 停止 / 语速 / 音量控制
 * 5. 后台播放支持（Media Session + 锁屏控制）
 * 6. 状态事件回调
 */

import { fetchTTSSettings } from './ttsService';
import { getToken } from './authService';

// ===== 类型定义 =====

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused';

// ===== 全局状态订阅（供 BookshelfPage 等外部组件使用） =====

export interface GlobalPlayerInfo {
  state: PlayerState;
  bookId?: string;
  bookTitle?: string;
  chapterTitle?: string;
  progress: number;
  currentIndex: number;
  totalChunks: number;
}

type GlobalStateListener = (info: GlobalPlayerInfo) => void;
const globalListeners: Set<GlobalStateListener> = new Set();

export function subscribeGlobalPlayer(listener: GlobalStateListener): () => void {
  globalListeners.add(listener);
  return () => { globalListeners.delete(listener); };
}

/** 获取当前全局播放器状态快照（用于非响应式场景） */
export function getGlobalPlayerSnapshot(): GlobalPlayerInfo | null {
  // lazy import to avoid circular dependency
  const player = defaultPlayer;
  if (!player || !player.currentBookId) return null;
  return {
    state: player.getState(),
    bookId: player.currentBookId,
    bookTitle: (player as any).bookTitle || '',
    chapterTitle: (player as any).chapterTitle || '',
    progress: player.getTotalChunks() > 0 ? (player.getCurrentIndex() + 1) / player.getTotalChunks() : 0,
    currentIndex: player.getCurrentIndex(),
    totalChunks: player.getTotalChunks(),
  };
}

interface TTSChunk {
  index: number;
  text: string;
  status: 'pending' | 'loading' | 'ready' | 'played' | 'error';
  /** Blob URL 指向合成的 WAV 音频数据 */
  audioBlobUrl?: string;
  error?: string;
}

export interface TTSPlayerOptions {
  source?: string;
  voice?: string;
  speed?: number;
  preGenCount?: number;
  /** 调试：跳过后端 TTS 音频缓存，每次都实时合成 */
  noCache?: boolean;
  /** 书籍标题（用于 Media Session 锁屏显示） */
  bookTitle?: string;
  /** 书籍封面 URL（用于 Media Session 锁屏封面） */
  bookCoverUrl?: string;
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
  /** 隐藏 <audio> 元素，用于播放每段合成的 WAV 音频 */
  private audioElement: HTMLAudioElement | null = null;
  private chunks: TTSChunk[] = [];
  private currentBlobUrl: string | null = null;
  private currentIndex = -1;
  private state: PlayerState = 'idle';
  private callbacks: TTSPlayerCallbacks = {};
  private speed = 1.0;
  private source = 'kokoro';
  private voice = 'zh-CN-XiaoxiaoNeural';
  private preGenCount = 3;
  private noCache = false;
  private isDestroyed = false;
  private currentSegmentText = '';
  private volume = 1.0;
  /** Number of chunks before any appendSegments() call — chapter boundary */
  private originalChunkCount = 0;
  /** Whether next chapter segments have already been appended */
  private nextChapterAppended = false;
  /** Bound visibilitychange handler for cleanup */
  private boundVisibilityHandler: (() => void) | null = null;
  /** 递增的 generation ID，用于丢弃旧 generation 的异步 fetch 结果 */
  private generation = 0;
  /** 所有 blob URL 清单，用于统一清理 */
  private allBlobUrls: string[] = [];
  /** 当前书籍信息（用于 Media Session 锁屏封面） */
  private bookTitle = '';
  private bookCoverUrl = '';
  /** 当前书籍信息（用于全局状态订阅） */
  public currentBookId: string = '';
  public chapterTitle: string = '';


  // ── 初始化 ──

  async init(options?: TTSPlayerOptions): Promise<void> {
    if (options?.speed) this.speed = options.speed;
    if (options?.source) this.source = options.source;
    if (options?.voice) this.voice = options.voice;
    if (options?.preGenCount) this.preGenCount = options.preGenCount;
    if (options?.noCache !== undefined) this.noCache = options.noCache;
    if (options?.bookTitle) this.bookTitle = options.bookTitle;
    if (options?.bookCoverUrl) this.bookCoverUrl = options.bookCoverUrl;

    // 尝试加载后端设置
    try {
      const settings = await fetchTTSSettings();
      this.source = settings.source || this.source;
      this.voice = settings.voiceId || this.voice;
      this.speed = settings.speed ?? this.speed;
    } catch {
      // 使用默认值
    }

    // 创建隐藏 <audio> 元素
    if (!this.audioElement) {
      const el = new Audio();
      el.preload = 'auto';
      el.volume = this.volume;
      el.playbackRate = this.speed;
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audioElement = el;
    }

    // ⭐ 初始化后台播放支持（Media Session API + <audio> 原生后台支持）
    this.setupBackgroundPlayback();
  }

  // ── 设置回调 ──

  setCallbacks(cbs: TTSPlayerCallbacks): void {
    this.callbacks = cbs;
  }

  // ── 设置语速 ──

  setSpeed(speed: number): void {
    this.speed = Math.max(0.5, Math.min(2.0, speed));
    if (this.audioElement && this.state === 'playing') {
      this.audioElement.playbackRate = this.speed;
    }
  }

  getSpeed(): number {
    return this.speed;
  }

  // ── 设置音量 ──

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1.0, volume));
    if (this.audioElement) {
      this.audioElement.volume = this.volume;
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


  /**
   * 跳转到指定分段索引后开始播放
   * 预生成目标分段之前的所有音频，再从目标分段开始播放
   */
  async jumpToSegment(index: number): Promise<void> {
    if (this.isDestroyed || index <= 0 || index >= this.chunks.length) return;

    // 预生成所有到目标分段为止的音频
    const promises: Promise<void>[] = [];
    for (let i = 0; i <= index; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.status === 'pending') {
        promises.push(this.fetchChunk(chunk).catch(() => {}));
      }
    }
    await Promise.all(promises);

    this.currentIndex = index - 1; // playNext 会递增到 index
    this.currentSegmentText = this.chunks[index]?.text || '';
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

  // ── Blob URL 清理 ──

  /** 清理所有缓存的 Blob URL */
  private clearAllBlobUrls(): void {
    for (const url of this.allBlobUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    this.allBlobUrls = [];
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }
  }

  /**
   * 加载要朗读的文本（纯文本或 HTML），准备播放
   */
  async load(text: string, isHtml = false): Promise<void> {
    if (this.isDestroyed) return;

    // 停止当前播放并清理旧 Blob URL
    this.stopInternal();
    this.clearAllBlobUrls();
    this.generation++; // 递增 generation，丢弃旧 fetch 结果

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

    if (this.state === 'paused') {
      // 从暂停恢复：<audio> 元素直接调用 play()
      if (this.audioElement) {
        try {
          await this.audioElement.play();
        } catch (err: any) {
          if (err.name === 'NotAllowedError') {
            this.callbacks.onBackgroundInterrupted?.();
            return;
          }
        }
      }
      this.updateMediaSessionState('playing');
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
    this.audioElement?.pause();
    this.updateMediaSessionState('paused');
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
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }
  }

  destroy(): void {
    this.isDestroyed = true;
    this.stopInternal();
    this.callbacks = {};

    // 清理所有 Blob URL
    this.clearAllBlobUrls();

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

    // 移除 <audio> 元素
    if (this.audioElement && this.audioElement.parentNode) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
      this.audioElement.onended = null;
      this.audioElement.onerror = null;
      this.audioElement.parentNode.removeChild(this.audioElement);
    }
    this.audioElement = null;
    this.chunks = [];
  }

  // ════════════════════════════════════════════
  // 后台播放支持
  // ════════════════════════════════════════════

  /**
   * 初始化后台播放支持：
   * 1. Media Session API — 锁屏/通知栏显示播放控制，浏览器保持音频通道活跃
   * 2. <audio> 元素原生支持后台播放（AudioContext 在后台会被挂起，<audio> 不会）
   * 3. visibilitychange — 从后台切回前台时同步 Media Session 状态
   * 4. onended 事件链 — 播放完成后自动播放下一个分段
   */
  private setupBackgroundPlayback(): void {
    if (this.isDestroyed || !this.audioElement) return;

    // ── 设置 <audio> 事件 ──
    this.audioElement.onended = () => {
      if (this.isDestroyed) return;
      if (this.state === 'playing') {
        this.playNext();
      }
    };

    this.audioElement.onerror = () => {
      if (this.isDestroyed) return;
      this.callbacks.onError?.('音频播放失败');
      // 跳过当前分段，继续播放下一个
      if (this.state === 'playing') {
        this.playNext();
      }
    };

    // ── 1. Media Session API ──
    this.updateMediaSessionMetadata();
    if ('mediaSession' in navigator) {
      try {
        // 注册媒体控制按钮（锁屏/通知栏控制）
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('stop', () => this.stop());
        // 可选：seek 控制
        navigator.mediaSession.setActionHandler('seekbackward', () => { /* 预留 */ });
        navigator.mediaSession.setActionHandler('seekforward', () => { /* 预留 */ });
      } catch { /* Media Session 不可用则静默跳过 */ }
    }

    // ── 2. visibilitychange：从后台切回前台时同步状态 ──
    this.boundVisibilityHandler = () => {
      if (this.isDestroyed) return;
      if (document.visibilityState === 'visible' && this.state === 'playing') {
        this.updateMediaSessionState('playing');
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  /** 更新 Media Session 播放状态（锁屏/通知栏状态同步） */
  private updateMediaSessionState(state: 'playing' | 'paused' | 'none'): void {
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = state; } catch { /* ignore */ }
    }
  }

  /** 更新 Media Session 元数据（锁屏显示书名+封面） */
  private updateMediaSessionMetadata(): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.bookTitle || 'iReader 语音朗读',
        artist: 'iReader',
        album: this.bookTitle || '有声书',
        ...(this.bookCoverUrl ? { artwork: [{ src: this.bookCoverUrl, sizes: '256x256', type: 'image/png' }] } : {}),
      });
    } catch { /* Media Session 不可用则静默跳过 */ }
  }

  // ── 核心播放循环 ──

  private async playNext(): Promise<void> {
    if (this.isDestroyed) return;

    this.currentIndex++;
    if (this.currentIndex >= this.chunks.length) {
      this.setState('idle');
      this.updateMediaSessionState('none');
      this.callbacks.onEnd?.();
      return;
    }

    const chunk = this.chunks[this.currentIndex];

    // 标记已播放的并释放 Blob URL
    for (let i = 0; i < this.currentIndex; i++) {
      if (this.chunks[i].status === 'ready' || this.chunks[i].status === 'played') {
        this.chunks[i].status = 'played';
        // 释放已播放的 Blob URL
        const playedUrl = this.chunks[i].audioBlobUrl;
        if (playedUrl) {
          const idx = this.allBlobUrls.indexOf(playedUrl);
          if (idx >= 0) {
            try { URL.revokeObjectURL(playedUrl); } catch { /* ignore */ }
            this.allBlobUrls.splice(idx, 1);
          }
          this.chunks[i].audioBlobUrl = undefined;
        }
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
    if (chunk.status !== 'ready' || !chunk.audioBlobUrl) {
      this.callbacks.onError?.(`段落 ${chunk.index + 1} 无可用音频`);
      this.playNext();
      return;
    }

    // 播放
    this.currentSegmentText = chunk.text;
    this.playChunk(chunk.audioBlobUrl);

    // 更新进度回调
    const progress = (this.currentIndex + 1) / this.chunks.length;
    this.callbacks.onSegmentPlay?.(this.currentIndex, this.chunks.length);
    this.callbacks.onProgress?.(progress);

    // 预生成后续片段
    this.preGenAhead(this.currentIndex);

    // 标记当前为 played
    chunk.status = 'played';
  }

  /**
   * 通过 <audio> 元素播放指定 Blob URL 的音频数据
   */
  private playChunk(blobUrl: string): void {
    if (!this.audioElement || this.isDestroyed) return;

    this.stopInternal();

    this.audioElement.src = blobUrl;
    this.currentBlobUrl = blobUrl;
    this.audioElement.playbackRate = this.speed;
    this.audioElement.volume = this.volume;

    // 播放时更新 Media Session 元数据（书名+封面）
    this.updateMediaSessionMetadata();
    this.setState('playing');
    this.updateMediaSessionState('playing');

    // 浏览器可能阻止自动播放（特别是恢复播放时），静默处理
    this.audioElement.play().catch((err) => {
      if (err.name === 'NotAllowedError') {
        // 用户尚未交互，播放被阻止 — 在 playNext 已由用户交互触发时不应出现
        this.callbacks.onBackgroundInterrupted?.();
      }
    });
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

    const gen = this.generation; // 记录当前的 generation

    try {
      const arrayBuffer = await this.fetchTTSAudio(chunk.text);

      // generation 守卫：丢弃旧文本的异步 fetch 结果
      if (gen !== this.generation || this.isDestroyed) {
        return;
      }

      // 将服务端返回的 WAV ArrayBuffer 直接创建为 Blob URL
      const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      this.allBlobUrls.push(url);
      chunk.audioBlobUrl = url;
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
        no_cache: this.noCache,
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
    this.notifyGlobalListeners();
  }

  /** 通知全局状态监听器（供 BookshelfPage 等使用） */
  private notifyGlobalListeners(): void {
    const info: GlobalPlayerInfo = {
      state: this.state,
      bookId: this.currentBookId,
      bookTitle: this.bookTitle,
      chapterTitle: this.chapterTitle,
      progress: this.chunks.length > 0 ? (this.currentIndex + 1) / this.chunks.length : 0,
      currentIndex: this.currentIndex,
      totalChunks: this.chunks.length,
    };
    for (const listener of globalListeners) {
      try { listener(info); } catch { /* ignore */ }
    }
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
