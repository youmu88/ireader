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
import { getCachedTTSAudio, cacheTTSAudio, getAllCachedTTSAudioForChapter, type TTSAudioIdentity } from './offlineCacheService';

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
  /** 章节 ID（用于 IDB 缓存查找） */
  chapterId?: string;
}

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

// ===== 文本分段 =====

/**
 * 将长文本按句子边界分成适度长度的段落
 * 每段 < 200 字符，优先按句号 / 段落分
 */
export function splitText(text: string): string[] {
  const segments: string[] = [];

  // ⭐ 前置清理：移除可能导致 TTS 合成失败的 Unicode 特殊字符
  // 零宽字符（ZWSP/ZWNJ/ZWJ/BOM）、控制字符、装饰性私用区字符
  let cleaned = text
    .replace(/[\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    // 保留常见装饰符号（◆◇■●※☆★○◎等），但移除纯符号段落首尾的孤立符号
    .replace(/(?:[◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑☯☰☱☲☳☴☵☶☷♠♣♥♦♤♧♡♢♔♕♖♗♘♙♚♛♜♝♞♟]+[\s　]*){3,}/g, '\n')
    .trim();

  // 按双换行分段（段落级）
  const paragraphs = cleaned.split(/\n\s*\n/);

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
          // ⭐ 过滤纯符号/纯空白分段（TTS 合成这类空段会失败）
          if (pt && !/^[\s\u00A0◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑♠♣♥♦♤♧♡♢♔♕♖♗♘♙\u2000-\u206F\u2100-\u214F\u3000\u3001-\u303F]+$/.test(pt)) {
            segments.push(pt);
          }
        }
      } else {
        // ⭐ 过滤纯符号/纯空白分段
        if (!/^[\s\u00A0◆◇■●※☆★○◎▷▶△▲▽▼□▣◈◐◑♠♣♥♦♤♧♡♢♔♕♖♗♘♙\u2000-\u206F\u2100-\u214F\u3000\u3001-\u303F]+$/.test(st)) {
          segments.push(st);
        }
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
  private currentSegmentText = '';
  private volume = 1.0;
  /** Number of chunks before any appendSegments() call — chapter boundary */
  private originalChunkCount = 0;
  /** Whether next chapter segments have already been appended */
  private nextChapterAppended = false;
  /** Bound visibilitychange handler for cleanup */
  private boundVisibilityHandler: (() => void) | null = null;
  /** Bound pagehide handler for save state on page unload */
  private boundPageHideHandler: (() => void) | null = null;
  /** 递增的 generation ID，用于丢弃旧 generation 的异步 fetch 结果 */
  private generation = 0;
  /** 所有 blob URL 清单，用于统一清理 */
  private allBlobUrls: string[] = [];

  /** 并发 fetch 的最大并发数（后台受限时限制，避免被浏览器完全限流） */
  private static readonly MAX_CONCURRENT_FETCHES = 6;
  /** 当前书籍信息（用于 Media Session 锁屏封面） */
  private bookTitle = '';
  private bookCoverUrl = '';
  /** 当前书籍信息（用于全局状态订阅） */
  public currentBookId: string = '';
  public chapterTitle: string = '';

  /** 获取当前音色 */
  /** 当前章节 ID（由 ReaderPage 设置，供持久化恢复用） */
  public chapterId: string = '';
  /** 心跳检测定时器：检测音频被浏览器静默暂停后自动恢复 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** 获取当前音色 */
  getVoice(): string { return this.voice; }
  /** 获取当前语音源 */
  getSource(): string { return this.source; }
  /** 设置当前语音源 */
  setSource(source: string): void { this.source = source; }
  /** 设置音色 */
  setVoice(v: string): void { this.voice = v; }

  private prefetchedChunks: TTSChunk[] | null = null;
  /** 预取时的 generation 标记，loadFromPrefetched 据此校验一致性 */
  private prefetchedGeneration: number = 0;


  // ── 初始化 ──

  async init(options?: TTSPlayerOptions): Promise<void> {
    if (options?.synthesisRate) this.synthesisRate = options.synthesisRate;
    else if (options?.speed) this.synthesisRate = options.speed; // backward compat
    if (options?.playbackRate) this.playbackRate = options.playbackRate;
    if (options?.source) this.source = options.source;
    if (options?.voice) this.voice = options.voice;
    if (options?.preGenCount) this.preGenCount = options.preGenCount;
    if (options?.noCache !== undefined) this.noCache = options.noCache;
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
    // 注意：未命中缓存时不再 await 网络取设置（避免冷启动阻塞点击朗读 1~2s），
    // 直接用默认值继续创建 <audio> 元素，设置随后由下方后台异步刷新补齐。

    // 后台刷新设置，但离线时完全不发请求。仅在调用方没有显式传值时才采用远端值，
    // 避免点击播放后配置被异步改写，造成缓存身份和实际合成参数不一致。
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

  // ── 设置语速 ──

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

  /** @deprecated 使用 setPlaybackRate 代替 */
  setSpeed(speed: number): void {
    this.setPlaybackRate(speed);
  }

  /** @deprecated 使用 getPlaybackRate 代替 */
  getSpeed(): number {
    return this.playbackRate;
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

  private getAudioIdentity(text: string): TTSAudioIdentity {
    return { voice: this.voice, synthesisRate: this.synthesisRate, source: this.source, text };
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


  /** 获取当前章节ID */
  getChapterId(): string { return this.chapterId; }
  /** 获取书籍标题 */
  getBookTitle(): string { return this.bookTitle; }


  /**
   * 跳转到指定分段索引后开始播放
   * 预生成目标分段之前的所有音频，再从目标分段开始播放
   */
  async jumpToSegment(index: number): Promise<void> {
    if (this.isDestroyed || index < 0 || index >= this.chunks.length) return;

    // 预生成所有到目标分段为止的音频
    const promises: Promise<void>[] = [];
    for (let i = 0; i <= index; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.status === 'pending') {
        promises.push(this.fetchChunk(chunk).catch(() => {}));
      }
    }
    await Promise.all(promises);

    // ⭐ 停止当前播放，跳到目标分段
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
      try { this.audioElement.load(); } catch { /* ignore */ }
    }

    this.currentIndex = Math.max(0, index - 1); // playNext 会递增到 index
    this.currentSegmentText = this.chunks[index]?.text || '';

    // 释放目标索引之前分段的 Blob URL
    for (let i = 0; i < index; i++) {
      const chunk = this.chunks[i];
      if (chunk.audioBlobUrl) {
        const urlIdx = this.allBlobUrls.indexOf(chunk.audioBlobUrl);
        if (urlIdx >= 0) {
          try { URL.revokeObjectURL(chunk.audioBlobUrl); } catch { /* ignore */ }
          this.allBlobUrls.splice(urlIdx, 1);
        }
        chunk.audioBlobUrl = undefined;
        chunk.status = 'played';
      }
    }

    // 立即从目标分段开始播放
    this.playNext();
  }

  /**
   * 按进度百分比（0~1）跳转到对应分段
   * 用于拖动进度条 seek
   */
  async seekTo(progress: number): Promise<void> {
    if (this.isDestroyed || this.chunks.length === 0) return;
    const clampedProgress = Math.max(0, Math.min(1, progress));
    const targetIndex = Math.round(clampedProgress * (this.chunks.length - 1));

    await this.jumpToSegment(targetIndex);
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
  appendSegments(segments: string[], chapterId?: string): void {
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
      chapterId,
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
  async load(text: string, isHtml = false, chapterId?: string): Promise<void> {
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
      chapterId,
    }));

    this.currentIndex = -1;
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;
    this.setState('loading');

    // ⭐ 批量检查 IDB 中已缓存的 TTS 音频分片。
    // 必须等待查询完成，确保本地缓存真正优先于网络合成。
    if (this.currentBookId && chapterId) {
      await this.batchLoadCachedAudio(this.currentBookId, chapterId);
      if (this.isDestroyed) return;
    }

    // 预生成前 preGenCount 个片段（已缓存的 chunk 跳过网络请求）
    await this.preGenRange(0, Math.min(this.preGenCount, this.chunks.length) - 1);

    // 后台启动全量预取（不阻塞 load 返回，play 时判断就绪状态）
    this.prefetchAllRemaining().catch(() => {});
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
      // ⭐ 恢复播放后启动心跳检测
      this.startHeartbeat();
      return;
    }

    if (this.state === 'loading' || this.state === 'idle') {
      // ⭐ 方案2b: 如果已有跳转位置（jumpToSegment 设置），保留不重置
      if (this.currentIndex < 0) {
        this.currentIndex = -1;
      }
      // 从第一个分段开始播放
      this.playNext();
      return;
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.audioElement?.pause();
    this.updateMediaSessionState('paused');
    this.setState('paused');
    this.clearHeartbeat();
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
    this.clearHeartbeat();
    this.stopInternal();
    this.callbacks = {};

    // 清理所有 Blob URL
    this.clearAllBlobUrls();

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
        navigator.mediaSession.setActionHandler('previoustrack', () => { this.callbacks.onPrevChapter?.(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { this.callbacks.onNextChapter?.(); });
        navigator.mediaSession.setActionHandler('seekbackward', () => { /* 预留 */ });
        navigator.mediaSession.setActionHandler('seekforward', () => { /* 预留 */ });
      } catch { /* Media Session 不可用则静默跳过 */ }
    }

    // ── 2. visibilitychange：后台时切换到拼接单源 + 切回前台时自动续播 ──
    this.boundVisibilityHandler = () => {
      if (this.isDestroyed) return;
      if (document.visibilityState === 'hidden') {
        this.isBackground = true;

      } else if (document.visibilityState === 'visible') {
        this.isBackground = false;
        // ⭐ 回到前台时检查是否需要续播：
        //    移动端后台时 onended 可能被节流，导致播完上一个 chunk 后
        //    playNext() 未被调用，播放链断裂。
        if (this.state === 'playing' && this.audioElement) {
          const dur = this.audioElement.duration;
          const ct = this.audioElement.currentTime;
          const isEnded = this.audioElement.ended ||
            (dur > 0 && ct > 0 && ct >= dur - 0.3);
          if (isEnded) {
            this.playNext();
          } else if (this.audioElement.paused) {
            // ⭐ 音频被浏览器意外暂停（如 PWA 切换/关闭回收音频焦点）→ 立即恢复
            this.audioElement.play().catch(() => {});
          }
        }
        this.updateMediaSessionState('playing');
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // ⭐ 页面隐藏时持久化播放状态（浏览器回收/刷新时保护进度）
    this.boundPageHideHandler = () => {
      if (this.state === 'playing' || this.state === 'paused') {
        this.persistPlaybackState();
      }
    };
    window.addEventListener('pagehide', this.boundPageHideHandler);
  }

  /**
   * 预取所有尚未准备好的音频片段（进入后台时调用）
   * 确保移动端后台播放时无需再发起 fetch 请求
   *
   * 使用并发池限制最大并发数，避免移动端后台一次性发起数百个 fetch
   * 导致浏览器完全限流（通常后台仅允许 4-6 个并发请求）
   * @returns 所有 pending chunk 预取完毕的 Promise
   */
  private prefetchAllRemaining(): Promise<void> {
    if (this.isDestroyed || this.chunks.length === 0) return Promise.resolve();
    const pendingChunks = this.chunks.filter(
      c => c.status === 'pending' && c.index > this.currentIndex
    );
    if (pendingChunks.length === 0) return Promise.resolve();
    // 用并发池预取，限制最大并发数
    return this.runWithConcurrency(
      pendingChunks,
      (chunk) => this.fetchChunk(chunk).catch(() => {}),
      TTSPlayer.MAX_CONCURRENT_FETCHES
    );
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
      const message = `段落 ${chunk.index + 1} 合成失败: ${chunk.error || '未知错误'}`;
      this.callbacks.onError?.(message);
      if (chunk.error?.includes('当前离线且该段语音未缓存')) {
        this.setState('idle');
        this.updateMediaSessionState('none');
        return;
      }
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
   *
   * （无 timeupdate 兜底 — 该机制已被 WAV 拼接模式替代。
   *   拼接模式下整章为单音频源，浏览器原生管道持续播放，无需 JS 驱动 chunk 切换。）
   */
  private playChunk(blobUrl: string): void {
    if (!this.audioElement || this.isDestroyed) return;

    this.stopInternal();

    this.audioElement.src = blobUrl;
    this.currentBlobUrl = blobUrl;
    this.audioElement.playbackRate = this.playbackRate;
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





  // ── 跨章预取：提前合成下一章 TTS 音频，后台无缝过渡 ──

  /**
   * 预取下一章节的 TTS 音频分段
   * 在当前章节播放到 75% 时调用，提前合成下一章节音频并缓存到内部缓冲区
   * 跨章节过渡时调用 loadFromPrefetched() 无需等待 TTS API 即可播放
   * @param segments 已经 splitText 分段后的文本数组
   */
  async prefetchChapterSegments(segments: string[], chapterId?: string): Promise<void> {
    if (this.isDestroyed || segments.length === 0) return;

    const gen = this.generation;
    const chunks: TTSChunk[] = segments.map((text, i) => ({
      index: i,
      text,
      status: 'pending' as const,
      chapterId,
    }));

    if (this.currentBookId && chapterId) {
      const identities = chunks.map(chunk => this.getAudioIdentity(chunk.text));
      const cached = await getAllCachedTTSAudioForChapter(this.currentBookId, chapterId, identities);
      for (const entry of cached) {
        const chunk = chunks[entry.segmentIndex];
        if (!chunk) continue;
        const url = URL.createObjectURL(new Blob([entry.audioData], { type: 'audio/wav' }));
        this.allBlobUrls.push(url);
        chunk.audioBlobUrl = url;
        chunk.status = 'ready';
      }
    }

    // 预取前 preGenCount 个分段（与标准 preGenRange 相同逻辑）
    const end = Math.min(this.preGenCount - 1, chunks.length - 1);
    const pending = chunks.slice(0, end + 1).filter(c => c.status === 'pending');

    // 用并发池预取 TTS 音频（不阻塞当前播放）
    await this.runWithConcurrency(
      pending,
      async (chunk) => {
        if (gen !== this.generation || this.isDestroyed) return;
        try {
          const arrayBuffer = await this.fetchTTSAudio(chunk.text);
          if (gen !== this.generation || this.isDestroyed) return;
          const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          this.allBlobUrls.push(url);
          chunk.audioBlobUrl = url;
          chunk.status = 'ready';
          if (this.currentBookId && chapterId) {
            await cacheTTSAudio(this.currentBookId, chapterId, chunk.index, arrayBuffer, undefined, this.getAudioIdentity(chunk.text));
          }
        } catch {
          chunk.status = 'error';
        }
      },
      TTSPlayer.MAX_CONCURRENT_FETCHES
    );

    // 存储预取结果（无论 fetch 成功与否，后续 loadFromPrefetched 会用已就绪的 chunk）
    this.prefetchedChunks = chunks;
    this.prefetchedGeneration = gen;
  }

  /**
   * 从预取缓冲区加载章节内容（无需 TTS API 调用，播放立即开始）
   * 在 advanceToNextChapterTTS 中优先调用，实现后台无缝跨章
   * @returns 是否成功加载预取数据（false 时调用方应回退到标准 load）
   */
  async loadFromPrefetched(): Promise<boolean> {
    if (!this.prefetchedChunks || this.prefetchedGeneration !== this.generation) {
      this.prefetchedChunks = null;
      return false;
    }

    const chunks = this.prefetchedChunks;
    this.prefetchedChunks = null;

    // 最小化停止：只暂停和清空 audio src，不清除 allBlobUrls（预取的 blob 在里面）
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.removeAttribute('src');
    }
    if (this.currentBlobUrl) {
      try { URL.revokeObjectURL(this.currentBlobUrl); } catch { /* ignore */ }
      this.currentBlobUrl = null;
    }


    this.generation++;
    this.chunks = chunks;
    this.currentIndex = -1;
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;

    this.setState('loading');

    // 后台预取剩余分段（已就绪的 chunk 直接可用，无需等待）
    this.prefetchAllRemaining().catch(() => {});

    return true;
  }

  private preGenAhead(currentIndex: number): void {
    const start = currentIndex + 1;
    const end = Math.min(currentIndex + this.preGenCount, this.chunks.length - 1);
    this.preGenRange(start, end);
  }

  /**
   * 预加载 IDB 中已缓存的 TTS 音频分片（预热时调用）
   * 在用户点击播放前，将之前缓存到 IndexedDB 的音频批量加载到播放器
   * 后续 load() 调用时，已就绪的 chunk 在 preGenRange 中直接命中缓存，跳过网络
   */
  async preloadCachedAudio(bookId: string, chapterId: string, segments: string[]): Promise<void> {
    if (this.isDestroyed || segments.length === 0) return;

    const gen = this.generation;
    // 批量从 IDB 获取该章节所有缓存的音频
    const cached = await getAllCachedTTSAudioForChapter(
      bookId,
      chapterId,
      segments.map(text => this.getAudioIdentity(text)),
    );
    if (cached.length === 0) return;

    // 将缓存的音频加载到 chunks 缓冲区（不依赖外部 load 调用）
    const chunks: TTSChunk[] = segments.map((text, i) => {
      const cachedEntry = cached.find(c => c.segmentIndex === i);
      let audioBlobUrl: string | undefined;
      if (cachedEntry) {
        const blob = new Blob([cachedEntry.audioData], { type: 'audio/wav' });
        audioBlobUrl = URL.createObjectURL(blob);
        this.allBlobUrls.push(audioBlobUrl);
      }
      return {
        index: i,
        text,
        status: cachedEntry ? 'ready' : 'pending',
        audioBlobUrl,
        chapterId,
      };
    });

    if (gen !== this.generation || this.isDestroyed) {
      // 清理已分配的 blob URL
      chunks.forEach(c => { if (c.audioBlobUrl) { try { URL.revokeObjectURL(c.audioBlobUrl); } catch { /* ignore */ } } });
      return;
    }

    // 存储预取结果，供后续 load 检测
    this.prefetchedChunks = chunks;
    this.prefetchedGeneration = gen;
  }

  /** 批量从 IDB 加载已缓存的分片音频（在 load() 的 preGenRange 前异步执行） */
  private async batchLoadCachedAudio(bookId: string, chapterId: string): Promise<void> {
    const cached = await getAllCachedTTSAudioForChapter(
      bookId,
      chapterId,
      this.chunks.map(chunk => this.getAudioIdentity(chunk.text)),
    );
    if (cached.length === 0) return;
    for (const entry of cached) {
      const chunk = this.chunks[entry.segmentIndex];
      if (chunk && chunk.status === 'pending') {
        const blob = new Blob([entry.audioData], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        this.allBlobUrls.push(url);
        chunk.audioBlobUrl = url;
        chunk.status = 'ready';
      }
    }
  }

  private async preGenRange(start: number, end: number): Promise<void> {
    const pendingChunks: TTSChunk[] = [];
    for (let i = start; i <= end; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.status === 'pending') {
        pendingChunks.push(chunk);
      }
    }
    // 用并发池预生成，限制最大并发数避免浏览器限流
    await this.runWithConcurrency(
      pendingChunks,
      (chunk) => this.fetchChunk(chunk).catch(() => {}),
      TTSPlayer.MAX_CONCURRENT_FETCHES
    );
  }

  private async fetchChunk(chunk: TTSChunk, retryCount = 0): Promise<void> {
    if (chunk.status !== 'pending') return;
    chunk.status = 'loading';

    const gen = this.generation; // 记录当前的 generation

    try {
      // ⭐ 优先从 IndexedDB 缓存读取
      if (this.currentBookId && chunk.chapterId) {
        const cachedAudio = await getCachedTTSAudio(
          this.currentBookId,
          chunk.chapterId,
          chunk.index,
          this.getAudioIdentity(chunk.text),
        );
        if (cachedAudio) {
          if (gen !== this.generation || this.isDestroyed) return;
          const blob = new Blob([cachedAudio], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          this.allBlobUrls.push(url);
          chunk.audioBlobUrl = url;
          chunk.status = 'ready';
          return;
        }
      }

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error('当前离线且该段语音未缓存');
      }
      const arrayBuffer = await this.fetchTTSAudio(chunk.text);

      // generation 守卫：丢弃旧文本的异步 fetch 结果
      if (gen !== this.generation || this.isDestroyed) {
        return;
      }

      // ⭐ 写入 IndexedDB 缓存（非阻塞、静默失败）
      if (this.currentBookId && chunk.chapterId) {
        cacheTTSAudio(
          this.currentBookId,
          chunk.chapterId,
          chunk.index,
          arrayBuffer,
          undefined,
          this.getAudioIdentity(chunk.text),
        ).catch(() => {});
      }

      // 将服务端返回的 WAV ArrayBuffer 直接创建为 Blob URL
      // 将服务端返回的 WAV ArrayBuffer 直接创建为 Blob URL
      const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      this.allBlobUrls.push(url);
      chunk.audioBlobUrl = url;
      chunk.status = 'ready';
    } catch (err: any) {
      // ⭐ 后台取失败时自动重试（最多 maxRetries 次），避免移动端后台临时网络波动导致中断
      if (retryCount < this.maxRetries && this.isBackground) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1))); // 递增延迟
        if (this.isDestroyed || gen !== this.generation) return;
        chunk.status = 'pending'; // 重置为 pending 以允许重试
        return this.fetchChunk(chunk, retryCount + 1);
      }
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

  /**
   * 简易并发池：限制异步操作的最大并发数
   * 用于后台预取时避免一次性发起数百个 fetch 被浏览器限流
   */
  private async runWithConcurrency<T extends { index: number }>(
    items: T[],
    fn: (item: T) => Promise<void>,
    concurrency: number
  ): Promise<void> {
    if (items.length === 0) return;
    let i = 0;
    const next = async (): Promise<void> => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx]);
      }
    };
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(workers);
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
        speed: this.synthesisRate,
        response_format: 'wav',
        tts_source: this.source,
        no_cache: this.noCache,
        book_id: this.currentBookId || undefined,
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
    // ⭐ 每次通知时自动持久化到 localStorage（供退出重进后恢复使用）
    this.persistPlaybackState();
  }

  /** 持久化当前播放状态到 localStorage（页面隐藏/心跳/状态变更时均会调用） */
  private persistPlaybackState(): void {
    if (this.state !== 'idle' && this.currentBookId) {
      try {
        localStorage.setItem('ireader_last_playback', JSON.stringify({
          bookId: this.currentBookId,
          bookTitle: this.bookTitle,
          chapterId: this.chapterId,
          chapterTitle: this.chapterTitle,
          progress: this.chunks.length > 0 ? (this.currentIndex + 1) / this.chunks.length : 0,
          currentIndex: this.currentIndex,
          totalChunks: this.chunks.length,
          timestamp: Date.now(),
        }));
      } catch { /* localStorage 不可用时静默失败 */ }
    }
  }

  /**
   * 启动心跳检测：定期检查 <audio> 是否被浏览器静默暂停
   * 如果状态为 playing 但音频意外暂停，自动恢复播放
   */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'playing' || !this.audioElement || this.isDestroyed) return;
      try {
        // 检测音频是否被浏览器意外暂停（如另一个 PWA 关闭时触发音频焦点回收）
        if (this.audioElement.paused && !this.audioElement.ended) {
          const dur = this.audioElement.duration;
          const ct = this.audioElement.currentTime;
          const naturallyEnding = dur > 0 && ct > 0 && ct >= dur - 0.5;
          if (!naturallyEnding) {
            // 尝试恢复播放
            this.audioElement.play().catch(() => {
              // 恢复失败不处理，可能正在切换 chunk
            });
          }
        }
      } catch { /* 静默 */ }
    }, 3000);
  }

  /** 清除心跳检测定时器 */
  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

/** localStorage key：最后播放记录 */
const LS_LAST_PLAYBACK = 'ireader_last_playback';
/** localStorage key：TTS 设置缓存（减少播放启动时的网络请求） */
const TTS_SETTINGS_CACHE_KEY = 'ireader_tts_settings_cache';
/** TTS 设置缓存有效期（毫秒） */
const TTS_SETTINGS_CACHE_TTL = 5 * 60 * 1000; // 5分钟

/** 从 localStorage 读取缓存的 TTS 设置 */
function getCachedTTSSettings(): { source: string; voiceId: string; speed: number } | null {
  try {
    const raw = localStorage.getItem(TTS_SETTINGS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed._cachedAt > TTS_SETTINGS_CACHE_TTL) {
      localStorage.removeItem(TTS_SETTINGS_CACHE_KEY);
      return null;
    }
    return { source: parsed.source, voiceId: parsed.voiceId, speed: parsed.speed };
  } catch {
    return null;
  }
}

/** 保存 TTS 设置到 localStorage 缓存 */
function saveCachedTTSSettings(settings: { source: string; voiceId: string; speed: number }): void {
  try {
    localStorage.setItem(TTS_SETTINGS_CACHE_KEY, JSON.stringify({ ...settings, _cachedAt: Date.now() }));
  } catch { /* 静默 */ }
}

export interface LastPlaybackInfo {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  progress: number;
  currentIndex: number;
  totalChunks: number;
  timestamp: number;
}

/**
 * 保存最后播放记录到 localStorage
 * 供书架底部栏在播放器空闲时显示状态
 */
export function savePlaybackToLocalStorage(info: LastPlaybackInfo): void {
  try {
    localStorage.setItem(LS_LAST_PLAYBACK, JSON.stringify({ ...info, timestamp: Date.now() }));
  } catch { /* 静默 */ }
}

/**
 * 从 localStorage 读取最后播放记录
 */
export function getLastPlaybackFromLocalStorage(): LastPlaybackInfo | null {
  try {
    const raw = localStorage.getItem(LS_LAST_PLAYBACK);
    if (!raw) return null;
    return JSON.parse(raw) as LastPlaybackInfo;
  } catch { return null; }
}

/**
 * 清除最后播放记录（用户在 ReaderPage 主动停止时调用）
 */
export function clearPlaybackFromLocalStorage(): void {
  try {
    localStorage.removeItem(LS_LAST_PLAYBACK);
  } catch { /* 静默 */ }
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