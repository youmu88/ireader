/**
 * TTS Player — 基于 <audio> 元素的分片预生成 TTS 播放引擎
 *
 * 使用 <audio> 元素替代 Web Audio API 的 AudioContext/BufferSource，
 * 以确保在移动端切换到后台时仍能正常播放（浏览器原生媒体管道
 * 配合 Media Session API 保持后台音频）。
 *
 * 架构：
 * - ttsTextProcessor.ts — 文本分段 / HTML 去标签（纯函数）
 * - ttsGlobalState.ts   — 全局状态订阅 / localStorage 持久化
 * - ttsScheduler.ts     — 分片调度 / 预生成 / TTS API 调用
 * - ttsPlayer.ts        — 音频播放 / Media Session / 播放控制（本文件）
 */

import { fetchTTSSettings } from './ttsService';
import { splitText, stripHtml } from './ttsTextProcessor';
import {
  type PlayerState,
  type GlobalPlayerInfo,
  notifyGlobalListeners,
  setSnapshotProvider,
  savePlaybackToLocalStorage,
  getCachedTTSSettings,
  saveCachedTTSSettings,
} from './ttsGlobalState';
import { TtsScheduler } from './ttsScheduler';

// ===== 向后兼容 re-exports =====
export type { PlayerState, GlobalPlayerInfo } from './ttsGlobalState';
export { subscribeGlobalPlayer, getGlobalPlayerSnapshot, getLastPlaybackFromLocalStorage, clearPlaybackFromLocalStorage } from './ttsGlobalState';
export type { LastPlaybackInfo } from './ttsGlobalState';
export { splitText } from './ttsTextProcessor';

// ===== 类型定义 =====

export interface TTSPlayerOptions {
  source?: string;
  voice?: string;
  /** 合成语速（影响 TTS API 参数和缓存身份） */
  synthesisRate?: number;
  /** 本地播放倍速（不影响缓存身份，仅改变 audio.playbackRate） */
  playbackRate?: number;
  /** @deprecated 使用 synthesisRate 代替 */
  speed?: number;
  preGenCount?: number;
  /** 调试：跳过后端 TTS 音频缓存，每次都实时合成 */
  noCache?: boolean;
  /** 书籍 ID（用于全局播放状态跟踪） */
  bookId?: string;
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
  /** 用户通过锁屏/通知栏请求上一章 */
  onPrevChapter?: () => void;
  /** 用户通过锁屏/通知栏请求下一章 */
  onNextChapter?: () => void;
}

// ===== TTSPlayer =====

export class TTSPlayer {
  /** 隐藏 <audio> 元素，用于播放每段合成的 WAV 音频 */
  private audioElement: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private state: PlayerState = 'idle';
  private callbacks: TTSPlayerCallbacks = {};
  /** 合成语速（影响 TTS API 参数和缓存身份） */
  private synthesisRate = 1.0;
  /** 本地播放倍速（不影响缓存身份） */
  private playbackRate = 1.0;
  private source = 'kokoro';
  private voice = 'zh-CN-XiaoxiaoNeural';
  private preGenCount = 10;
  /** 最大重试次数（后台 fetch 失败时） */
  private maxRetries = 2;
  /** 是否正在后台（visibility hidden） */
  private isBackground = false;
  private noCache = false;
  private isDestroyed = false;
  private volume = 1.0;
  /** Bound visibilitychange handler for cleanup */
  private boundVisibilityHandler: (() => void) | null = null;
  /** Bound pagehide handler for save state on page unload */
  private boundPageHideHandler: (() => void) | null = null;
  /** 当前书籍信息（用于 Media Session 锁屏封面） */
  private bookTitle = '';
  private bookCoverUrl = '';
  /** 当前书籍信息（用于全局状态订阅） */
  public currentBookId: string = '';
  public chapterTitle: string = '';
  /** 当前章节 ID（由 ReaderPage 设置，供持久化恢复用） */
  public chapterId: string = '';
  /** 心跳检测定时器：检测音频被浏览器静默暂停后自动恢复 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 分片调度器（管理 chunks、预生成、TTS API 调用） */
  private scheduler: TtsScheduler;

  constructor() {
    this.scheduler = new TtsScheduler({
      isAlive: () => !this.isDestroyed,
      isBackground: () => this.isBackground,
      getMaxRetries: () => this.maxRetries,
      getPreGenCount: () => this.preGenCount,
      getSynthesisParams: () => ({
        source: this.source,
        voice: this.voice,
        synthesisRate: this.synthesisRate,
        noCache: this.noCache,
        bookId: this.currentBookId,
      }),
    });
  }

  // ── 初始化 ──

  async init(options?: TTSPlayerOptions): Promise<void> {
    if (this.isDestroyed) return;

    if (options?.source) this.source = options.source;
    if (options?.voice) this.voice = options.voice;
    if (options?.synthesisRate) this.synthesisRate = options.synthesisRate;
    if (options?.speed) this.synthesisRate = options.speed;
    if (options?.playbackRate) this.playbackRate = options.playbackRate;
    if (options?.preGenCount) this.preGenCount = options.preGenCount;
    if (options?.noCache) this.noCache = options.noCache;
    if (options?.bookId) this.currentBookId = options.bookId;
    if (options?.bookTitle) this.bookTitle = options.bookTitle;
    if (options?.bookCoverUrl) this.bookCoverUrl = options.bookCoverUrl;

    // ⭐ 如果 audio 元素已存在（预热时已初始化），只更新选项和设置
    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
      this.updateMediaSessionMetadata();
      return;
    }

    // ⭐ 优先从 localStorage 读取缓存的 TTS 设置（零网络延迟）
    const cachedSettings = getCachedTTSSettings();
    if (cachedSettings) {
      this.source = cachedSettings.source || this.source;
      this.voice = cachedSettings.voiceId || this.voice;
      this.synthesisRate = cachedSettings.speed ?? this.synthesisRate;
    }

    // 后台刷新设置，但离线时完全不发请求
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      fetchTTSSettings().then(settings => {
        if (!this.isDestroyed) {
          if (!options?.source) this.source = settings.source || this.source;
          if (!options?.voice) this.voice = settings.voiceId || this.voice;
          if (!options?.synthesisRate && !options?.speed) this.synthesisRate = settings.speed ?? this.synthesisRate;
          saveCachedTTSSettings(settings);
          if (this.audioElement) this.audioElement.playbackRate = this.playbackRate;
        }
      }).catch(() => {});
    }

    // 创建隐藏 <audio> 元素
    const el = new Audio();
    el.preload = 'auto';
    el.volume = this.volume;
    el.playbackRate = this.playbackRate;
    el.style.display = 'none';
    document.body.appendChild(el);
    this.audioElement = el;

    // ⭐ 初始化后台播放支持（Media Session API + <audio> 原生后台支持）
    this.setupBackgroundPlayback();
  }

  // ── 设置回调 ──

  setCallbacks(cbs: TTSPlayerCallbacks): void {
    this.callbacks = cbs;
  }

  // ── 语速 / 音量 ──

  /** 设置本地播放倍速（即时生效，不影响缓存身份） */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.max(0.5, Math.min(3.0, rate));
    if (this.audioElement) {
      this.audioElement.playbackRate = this.playbackRate;
    }
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  /** 设置合成语速（影响后续合成的缓存身份） */
  setSynthesisRate(rate: number): void {
    this.synthesisRate = Math.max(0.5, Math.min(2.0, rate));
  }

  getSynthesisRate(): number {
    return this.synthesisRate;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.audioElement) this.audioElement.volume = this.volume;
  }

  getVolume(): number {
    return this.volume;
  }

  // ── 状态查询 ──

  /** 获取当前音色 */
  getVoice(): string { return this.voice; }
  /** 设置当前音色 */
  setVoice(voice: string): void { this.voice = voice; }
  /** 获取当前语音源 */
  getSource(): string { return this.source; }
  /** 设置当前语音源 */
  setSource(source: string): void { this.source = source; }

  getState(): PlayerState {
    return this.state;
  }

  getCurrentIndex(): number {
    return this.scheduler.getIndex();
  }

  getTotalChunks(): number {
    return this.scheduler.totalChunks;
  }

  /** 获取当前正在朗读的段落文本 */
  getCurrentSegmentText(): string {
    return this.scheduler.getCurrentSegmentText();
  }

  /** 获取当前章节ID */
  getChapterId(): string { return this.chapterId; }
  /** 获取书籍标题 */
  getBookTitle(): string { return this.bookTitle; }

  /** 获取原始章节的分段数量（appendSegments 前的边界） */
  getOriginalChunkCount(): number {
    return this.scheduler.getOriginalChunkCount();
  }

  // ── 加载文本 ──

  /**
   * 加载要朗读的文本（纯文本或 HTML），准备播放
   */
  async load(text: string, isHtml = false, chapterId?: string): Promise<void> {
    if (this.isDestroyed) return;

    // 停止当前播放并清理旧资源
    this.stopInternal();
    this.scheduler.reset();

    const plainText = isHtml ? stripHtml(text) : text;
    const segments = splitText(plainText);

    if (segments.length === 0) {
      this.callbacks.onError?.('没有可朗读的文本内容');
      return;
    }

    this.scheduler.loadChunks(segments, chapterId);
    this.setState('loading');

    // ⭐ 批量检查 IDB 中已缓存的 TTS 音频分片
    if (this.currentBookId && chapterId) {
      await this.scheduler.batchLoadCachedAudio(this.currentBookId, chapterId);
      if (this.isDestroyed) return;
    }

    // 预生成前 preGenCount 个片段
    await this.scheduler.preGenInitial();

    // 后台启动全量预取（不阻塞 load 返回）
    this.scheduler.prefetchAllRemaining().catch(() => {});
  }

  /**
   * 追加下一章节的文本分段，实现章节间无缝衔接播放
   */
  appendSegments(segments: string[], chapterId?: string): void {
    if (this.isDestroyed || segments.length === 0) return;
    this.scheduler.appendSegments(segments, chapterId);
  }

  // ── 播放控制 ──

  async play(): Promise<void> {
    if (this.isDestroyed) return;

    if (this.state === 'paused') {
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
      this.setState('playing');
      this.updateMediaSessionState('playing');
      this.startHeartbeat();
      return;
    }

    if (this.state === 'playing') return;

    // idle / loading → 开始播放
    this.setState('playing');
    this.updateMediaSessionState('playing');
    this.startHeartbeat();
    this.playNext();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    if (this.audioElement) this.audioElement.pause();
    this.setState('paused');
    this.updateMediaSessionState('paused');
    this.clearHeartbeat();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.play();
  }

  stop(): void {
    this.stopInternal();
    this.setState('idle');
    this.scheduler.setIndex(-1);
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
    this.clearHeartbeat();
    this.stopInternal();
    this.callbacks = {};

    // 清理调度器资源（Blob URL 等）
    this.scheduler.clearAllBlobUrls();

    // 清理后台播放相关
    if (this.boundVisibilityHandler) {
      document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
      this.boundVisibilityHandler = null;
    }
    if (this.boundPageHideHandler) {
      window.removeEventListener('pagehide', this.boundPageHideHandler);
      this.boundPageHideHandler = null;
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
    this.scheduler.reset();
  }

  // ── Seek / Jump ──

  /**
   * 跳转到指定分段索引后开始播放
   */
  async jumpToSegment(index: number): Promise<void> {
    if (this.isDestroyed || index < 0 || index >= this.scheduler.totalChunks) return;
    await this.scheduler.prepareAndSeekTo(index);
    this.stopInternal();
    this.setState('loading');
    this.playNext();
  }

  /**
   * 按进度百分比（0~1）跳转到对应分段
   */
  async seekTo(progress: number): Promise<void> {
    if (this.isDestroyed || this.scheduler.totalChunks === 0) return;
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const targetIndex = Math.round(clampedProgress * (this.scheduler.totalChunks - 1));
    await this.jumpToSegment(targetIndex);
  }

  // ════════════════════════════════════════════
  // 后台播放支持
  // ════════════════════════════════════════════

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
      if (this.state === 'playing') {
        this.playNext();
      }
    };

    // ── Media Session API ──
    this.updateMediaSessionMetadata();
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => this.play());
        navigator.mediaSession.setActionHandler('pause', () => this.pause());
        navigator.mediaSession.setActionHandler('stop', () => this.stop());
        navigator.mediaSession.setActionHandler('previoustrack', () => { this.callbacks.onPrevChapter?.(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { this.callbacks.onNextChapter?.(); });
        navigator.mediaSession.setActionHandler('seekbackward', () => { /* 预留 */ });
        navigator.mediaSession.setActionHandler('seekforward', () => { /* 预留 */ });
      } catch { /* Media Session 不可用则静默跳过 */ }
    }

    // ── visibilitychange：后台时预取全部 + 切回前台时同步状态 ──
    this.boundVisibilityHandler = () => {
      if (this.isDestroyed) return;
      if (document.visibilityState === 'hidden') {
        this.isBackground = true;
        // 后台时预取所有剩余分段
        if (this.state === 'playing') {
          this.scheduler.prefetchAllRemaining().catch(() => {});
        }
        this.persistPlaybackState();
      } else {
        this.isBackground = false;
        // 切回前台时同步 Media Session 状态
        if (this.state === 'playing') {
          this.updateMediaSessionState('playing');
        } else if (this.state === 'paused') {
          this.updateMediaSessionState('paused');
        }
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // ── pagehide：页面卸载前保存状态 ──
    this.boundPageHideHandler = () => {
      if (!this.isDestroyed) this.persistPlaybackState();
    };
    window.addEventListener('pagehide', this.boundPageHideHandler);
  }

  /** 更新 Media Session 播放状态 */
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

    const chunk = this.scheduler.advance();
    if (!chunk) {
      this.setState('idle');
      this.updateMediaSessionState('none');
      this.callbacks.onEnd?.();
      return;
    }

    // 释放已播放分段的 Blob URL
    this.scheduler.releasePlayedBlobUrls();

    // 确保当前分片音频就绪
    const ready = await this.scheduler.ensureChunkReady(chunk);
    if (!ready) {
      if (chunk.status === 'error') {
        const message = `段落 ${chunk.index + 1} 合成失败: ${chunk.error || '未知错误'}`;
        this.callbacks.onError?.(message);
        if (chunk.error?.includes('当前离线且该段语音未缓存')) {
          this.setState('idle');
          this.updateMediaSessionState('none');
          return;
        }
      } else {
        this.callbacks.onError?.(`段落 ${chunk.index + 1} 无可用音频`);
      }
      this.playNext();
      return;
    }

    // 播放
    this.playChunk(chunk.audioBlobUrl!);

    // 更新进度回调
    const idx = this.scheduler.getIndex();
    const total = this.scheduler.totalChunks;
    this.callbacks.onSegmentPlay?.(idx, total);
    this.callbacks.onProgress?.((idx + 1) / total);

    // 预生成后续片段
    this.scheduler.preGenAhead();

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
    this.audioElement.playbackRate = this.playbackRate;
    this.audioElement.volume = this.volume;

    this.updateMediaSessionMetadata();
    this.setState('playing');
    this.updateMediaSessionState('playing');

    this.audioElement.play().catch((err) => {
      if (err.name === 'NotAllowedError') {
        this.callbacks.onBackgroundInterrupted?.();
      }
    });
  }

  // ── 跨章预取 ──

  /**
   * 预取下一章节的 TTS 音频分段
   */
  async prefetchChapterSegments(segments: string[], chapterId?: string): Promise<void> {
    if (this.isDestroyed || segments.length === 0) return;
    await this.scheduler.prefetchChapterSegments(segments, chapterId);
  }

  /**
   * 从预取缓冲区加载章节内容（无需 TTS API 调用，播放立即开始）
   */
  async loadFromPrefetched(): Promise<boolean> {
    const chunks = this.scheduler.consumePrefetched();
    if (!chunks) return false;

    // 最小化停止：只暂停和清空 audio src
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }

    this.scheduler.loadPrefetchedChunks(chunks);
    this.setState('loading');

    // 后台预取剩余分段
    this.scheduler.prefetchAllRemaining().catch(() => {});

    return true;
  }

  hasPrefetchedChapter(): boolean {
    return this.scheduler.hasPrefetchedChapter();
  }

  /**
   * 预加载 IDB 中已缓存的 TTS 音频分片（预热时调用）
   */
  async preloadCachedAudio(bookId: string, chapterId: string, segments: string[]): Promise<void> {
    if (this.isDestroyed || segments.length === 0) return;
    await this.scheduler.preloadCachedAudio(bookId, chapterId, segments);
  }

  // ── 状态管理 ──

  private setState(s: PlayerState): void {
    if (this.state === s) return;
    this.state = s;
    this.callbacks.onStateChange?.(s);
    this.notifyGlobal();
  }

  /** 通知全局状态监听器 */
  private notifyGlobal(): void {
    const info: GlobalPlayerInfo = {
      state: this.state,
      bookId: this.currentBookId,
      bookTitle: this.bookTitle,
      chapterTitle: this.chapterTitle,
      progress: this.scheduler.totalChunks > 0 ? (this.scheduler.getIndex() + 1) / this.scheduler.totalChunks : 0,
      currentIndex: this.scheduler.getIndex(),
      totalChunks: this.scheduler.totalChunks,
    };
    notifyGlobalListeners(info);
    // ⭐ 每次通知时自动持久化到 localStorage
    this.persistPlaybackState();
  }

  /** 持久化当前播放状态到 localStorage */
  private persistPlaybackState(): void {
    if (this.state !== 'idle' && this.currentBookId) {
      savePlaybackToLocalStorage({
        bookId: this.currentBookId,
        bookTitle: this.bookTitle,
        chapterId: this.chapterId,
        chapterTitle: this.chapterTitle,
        progress: this.scheduler.totalChunks > 0 ? (this.scheduler.getIndex() + 1) / this.scheduler.totalChunks : 0,
        currentIndex: this.scheduler.getIndex(),
      });
    }
  }

  // ── 心跳检测 ──

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'playing' || !this.audioElement || this.isDestroyed) return;
      try {
        if (this.audioElement.paused && !this.audioElement.ended) {
          const dur = this.audioElement.duration;
          const ct = this.audioElement.currentTime;
          const naturallyEnding = dur > 0 && ct > 0 && ct >= dur - 0.5;
          if (!naturallyEnding) {
            this.audioElement.play().catch(() => {});
          }
        }
      } catch { /* 静默 */ }
    }, 3000);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ===== 辅助：创建默认播放器实例 =====

let defaultPlayer: TTSPlayer | null = null;

// 注册全局快照 provider（避免循环依赖）
setSnapshotProvider(() => {
  const player = defaultPlayer;
  if (!player || !player.currentBookId) return null;
  return {
    state: player.getState(),
    bookId: player.currentBookId,
    bookTitle: player.getBookTitle(),
    chapterTitle: player.chapterTitle,
    progress: player.getTotalChunks() > 0 ? (player.getCurrentIndex() + 1) / player.getTotalChunks() : 0,
    currentIndex: player.getCurrentIndex(),
    totalChunks: player.getTotalChunks(),
  };
});

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
