/**
 * TTS 调度器 — 分片预生成与音频获取引擎
 *
 * 负责：
 * 1. 文本分段 → TTSChunk 生命周期管理
 * 2. 预生成（preGen）调度与并发池控制
 * 3. TTS API 调用 + IndexedDB 缓存读写
 * 4. 跨章节预取缓冲区
 * 5. Blob URL 资源管理
 *
 * 不负责：音频播放、Media Session、UI 状态
 */

import { getToken } from './authService';
import { getCachedTTSAudio, cacheTTSAudio, getAllCachedTTSAudioForChapter, type TTSAudioIdentity } from './offlineCacheService';

// ===== 类型定义 =====

export interface TTSChunk {
  index: number;
  text: string;
  status: 'pending' | 'loading' | 'ready' | 'played' | 'error';
  /** Blob URL 指向合成的 WAV 音频数据 */
  audioBlobUrl?: string;
  error?: string;
  /** 章节 ID（用于 IDB 缓存查找） */
  chapterId?: string;
}

/** 调度器从播放器获取运行时参数的接口 */
export interface SchedulerConfig {
  isAlive: () => boolean;
  isBackground: () => boolean;
  getMaxRetries: () => number;
  getPreGenCount: () => number;
  getSynthesisParams: () => {
    source: string;
    voice: string;
    synthesisRate: number;
    noCache: boolean;
    bookId: string;
  };
}

// ===== TtsScheduler =====

export class TtsScheduler {
  chunks: TTSChunk[] = [];
  private currentIndex = -1;
  private generation = 0;
  private allBlobUrls: string[] = [];
  private prefetchedChunks: TTSChunk[] | null = null;
  private prefetchedGeneration = 0;
  private originalChunkCount = 0;
  private nextChapterAppended = false;
  private config: SchedulerConfig;

  /** 并发 fetch 的最大并发数（后台受限时限制，避免被浏览器完全限流） */
  static readonly MAX_CONCURRENT_FETCHES = 6;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  // ── 生命周期 ──

  /** 重置所有状态（load/stop/destroy 时调用） */
  reset(): void {
    this.clearAllBlobUrls();
    this.generation++;
    this.chunks = [];
    this.currentIndex = -1;
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;
    this.prefetchedChunks = null;
  }

  /** 从分段文本创建 chunks */
  loadChunks(segments: string[], chapterId?: string): void {
    this.chunks = segments.map((seg, i) => ({
      index: i,
      text: seg,
      status: 'pending' as const,
      chapterId,
    }));
    this.currentIndex = -1;
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;
  }

  /**
   * 追加下一章节的文本分段，实现章节间无缝衔接播放
   */
  appendSegments(segments: string[], chapterId?: string): void {
    if (!this.config.isAlive() || segments.length === 0) return;
    if (this.nextChapterAppended) return;
    this.nextChapterAppended = true;

    this.originalChunkCount = this.chunks.length;

    const startIdx = this.chunks.length;
    const newChunks: TTSChunk[] = segments.map((text, i) => ({
      index: startIdx + i,
      text,
      status: 'pending' as const,
      chapterId,
    }));
    this.chunks.push(...newChunks);

    const end = Math.min(startIdx + this.config.getPreGenCount() - 1, this.chunks.length - 1);
    this.preGenRange(startIdx, end);
  }

  // ── 索引管理 ──

  /** 前进到下一个 chunk，返回该 chunk；若已到末尾返回 null */
  advance(): TTSChunk | null {
    this.currentIndex++;
    if (this.currentIndex >= this.chunks.length) return null;
    return this.chunks[this.currentIndex];
  }

  getIndex(): number { return this.currentIndex; }
  setIndex(i: number): void { this.currentIndex = i; }
  get totalChunks(): number { return this.chunks.length; }
  getOriginalChunkCount(): number { return this.originalChunkCount; }

  getCurrentChunk(): TTSChunk | null {
    return this.chunks[this.currentIndex] ?? null;
  }

  getCurrentSegmentText(): string {
    return this.chunks[this.currentIndex]?.text ?? '';
  }

  getCurrentChapterId(): string | undefined {
    return this.chunks[this.currentIndex]?.chapterId;
  }

  // ── 预生成 ──

  /** 初始预生成（load 后调用） */
  async preGenInitial(): Promise<void> {
    const end = Math.min(this.config.getPreGenCount(), this.chunks.length) - 1;
    await this.preGenRange(0, end);
  }

  /** 预生成 [start, end] 范围内的 pending chunks */
  async preGenRange(start: number, end: number): Promise<void> {
    const pendingChunks: TTSChunk[] = [];
    for (let i = start; i <= end; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.status === 'pending') {
        pendingChunks.push(chunk);
      }
    }
    await this.runWithConcurrency(
      pendingChunks,
      (chunk) => this.fetchChunk(chunk).catch(() => {}),
      TtsScheduler.MAX_CONCURRENT_FETCHES
    );
  }

  /** 预生成当前索引之后的片段 */
  preGenAhead(): void {
    const start = this.currentIndex + 1;
    const end = Math.min(this.currentIndex + this.config.getPreGenCount(), this.chunks.length - 1);
    this.preGenRange(start, end);
  }

  /**
   * 后台预取所有剩余 pending chunks（进入后台时调用）
   */
  prefetchAllRemaining(): Promise<void> {
    if (!this.config.isAlive() || this.chunks.length === 0) return Promise.resolve();
    const pendingChunks = this.chunks.filter(
      c => c.status === 'pending' && c.index > this.currentIndex
    );
    if (pendingChunks.length === 0) return Promise.resolve();
    return this.runWithConcurrency(
      pendingChunks,
      (chunk) => this.fetchChunk(chunk).catch(() => {}),
      TtsScheduler.MAX_CONCURRENT_FETCHES
    );
  }

  // ── Chunk 就绪 ──

  /** 确保 chunk 就绪（fetch if pending, wait if loading），返回是否成功 */
  async ensureChunkReady(chunk: TTSChunk): Promise<boolean> {
    if (chunk.status === 'pending') {
      await this.fetchChunk(chunk);
    } else if (chunk.status === 'loading') {
      await this.waitForChunk(chunk);
    }
    return chunk.status === 'ready' && !!chunk.audioBlobUrl;
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

  // ── 音频获取 ──

  private async fetchChunk(chunk: TTSChunk, retryCount = 0): Promise<void> {
    if (chunk.status !== 'pending') return;
    chunk.status = 'loading';

    const gen = this.generation;

    try {
      const params = this.config.getSynthesisParams();

      // ⭐ 优先从 IndexedDB 缓存读取
      if (params.bookId && chunk.chapterId) {
        const cachedAudio = await getCachedTTSAudio(
          params.bookId,
          chunk.chapterId,
          chunk.index,
          this.getAudioIdentity(chunk.text),
        );
        if (cachedAudio) {
          if (gen !== this.generation || !this.config.isAlive()) return;
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
      if (gen !== this.generation || !this.config.isAlive()) {
        return;
      }

      // ⭐ 写入 IndexedDB 缓存（非阻塞、静默失败）
      if (params.bookId && chunk.chapterId) {
        cacheTTSAudio(
          params.bookId,
          chunk.chapterId,
          chunk.index,
          arrayBuffer,
          undefined,
          this.getAudioIdentity(chunk.text),
        ).catch(() => {});
      }

      const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      this.allBlobUrls.push(url);
      chunk.audioBlobUrl = url;
      chunk.status = 'ready';
    } catch (err: any) {
      // ⭐ 后台取失败时自动重试（最多 maxRetries 次）
      if (retryCount < this.config.getMaxRetries() && this.config.isBackground()) {
        await new Promise(r => setTimeout(r, 1000 * (retryCount + 1)));
        if (!this.config.isAlive() || gen !== this.generation) return;
        chunk.status = 'pending';
        return this.fetchChunk(chunk, retryCount + 1);
      }
      chunk.status = 'error';
      chunk.error = err?.message || '合成失败';
    }
  }

  private async fetchTTSAudio(text: string): Promise<ArrayBuffer> {
    const params = this.config.getSynthesisParams();
    const token = getToken();
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        input: text,
        voice: params.voice,
        speed: params.synthesisRate,
        response_format: 'wav',
        tts_source: params.source,
        no_cache: params.noCache,
        book_id: params.bookId || undefined,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '未知错误');
      throw new Error(`TTS 合成失败 (${res.status}): ${errBody.slice(0, 100)}`);
    }

    return res.arrayBuffer();
  }

  // ── IDB 缓存批量加载 ──

  /** 批量从 IDB 加载已缓存的分片音频（在 load() 的 preGenRange 前异步执行） */
  async batchLoadCachedAudio(bookId: string, chapterId: string): Promise<void> {
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

  /**
   * 预加载 IDB 中已缓存的 TTS 音频分片（预热时调用）
   */
  async preloadCachedAudio(bookId: string, chapterId: string, segments: string[]): Promise<void> {
    if (!this.config.isAlive() || segments.length === 0) return;

    const gen = this.generation;
    const cached = await getAllCachedTTSAudioForChapter(
      bookId,
      chapterId,
      segments.map(text => this.getAudioIdentity(text)),
    );
    if (cached.length === 0) return;

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
        status: (cachedEntry ? 'ready' : 'pending') as TTSChunk['status'],
        audioBlobUrl,
        chapterId,
      };
    });

    if (gen !== this.generation || !this.config.isAlive()) {
      chunks.forEach(c => { if (c.audioBlobUrl) { try { URL.revokeObjectURL(c.audioBlobUrl); } catch { /* ignore */ } } });
      return;
    }

    this.prefetchedChunks = chunks;
    this.prefetchedGeneration = gen;
  }

  // ── 跨章预取 ──

  /**
   * 预取下一章节的 TTS 音频分段
   */
  async prefetchChapterSegments(segments: string[], chapterId?: string): Promise<void> {
    if (!this.config.isAlive() || segments.length === 0) return;

    const gen = this.generation;
    const chunks: TTSChunk[] = segments.map((text, i) => ({
      index: i,
      text,
      status: 'pending' as const,
      chapterId,
    }));

    const params = this.config.getSynthesisParams();
    if (params.bookId && chapterId) {
      const identities = chunks.map(chunk => this.getAudioIdentity(chunk.text));
      const cached = await getAllCachedTTSAudioForChapter(params.bookId, chapterId, identities);
      for (const entry of cached) {
        const chunk = chunks[entry.segmentIndex];
        if (!chunk) continue;
        const url = URL.createObjectURL(new Blob([entry.audioData], { type: 'audio/wav' }));
        this.allBlobUrls.push(url);
        chunk.audioBlobUrl = url;
        chunk.status = 'ready';
      }
    }

    // 预取前 preGenCount 个分段
    const end = Math.min(this.config.getPreGenCount() - 1, chunks.length - 1);
    const pending = chunks.slice(0, end + 1).filter(c => c.status === 'pending');

    await this.runWithConcurrency(
      pending,
      async (chunk) => {
        if (gen !== this.generation || !this.config.isAlive()) return;
        try {
          const arrayBuffer = await this.fetchTTSAudio(chunk.text);
          if (gen !== this.generation || !this.config.isAlive()) return;
          const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          this.allBlobUrls.push(url);
          chunk.audioBlobUrl = url;
          chunk.status = 'ready';
        } catch {
          chunk.status = 'error';
        }
      },
      TtsScheduler.MAX_CONCURRENT_FETCHES
    );

    this.prefetchedChunks = chunks;
    this.prefetchedGeneration = gen;
  }

  /**
   * 消费预取缓冲区（返回 chunks 或 null）
   */
  consumePrefetched(): TTSChunk[] | null {
    if (!this.prefetchedChunks || this.prefetchedGeneration !== this.generation) {
      this.prefetchedChunks = null;
      return null;
    }
    const chunks = this.prefetchedChunks;
    this.prefetchedChunks = null;
    return chunks;
  }

  hasPrefetchedChapter(): boolean {
    return this.prefetchedChunks !== null && this.prefetchedGeneration === this.generation;
  }

  // ── 跳转与预取加载 ──

  /** 预生成目标分段之前的所有音频，再设置索引（供 jumpToSegment 使用） */
  async prepareAndSeekTo(index: number): Promise<void> {
    const promises: Promise<void>[] = [];
    for (let i = 0; i <= index; i++) {
      const chunk = this.chunks[i];
      if (chunk && chunk.status === 'pending') {
        promises.push(this.fetchChunk(chunk).catch(() => {}));
      }
    }
    await Promise.all(promises);
    this.currentIndex = index - 1;
  }

  /** 将预取缓冲区的 chunks 加载为当前播放队列（供 loadFromPrefetched 使用） */
  loadPrefetchedChunks(chunks: TTSChunk[]): void {
    this.generation++;
    this.chunks = chunks;
    this.currentIndex = -1;
    this.originalChunkCount = 0;
    this.nextChapterAppended = false;
  }

  // ── Blob URL 管理 ──

  /** 释放已播放 chunks 的 Blob URL（playNext 中调用） */
  releasePlayedBlobUrls(): void {
    for (let i = 0; i < this.currentIndex; i++) {
      const c = this.chunks[i];
      if (c && (c.status === 'ready' || c.status === 'played')) {
        c.status = 'played';
        const playedUrl = c.audioBlobUrl;
        if (playedUrl) {
          const idx = this.allBlobUrls.indexOf(playedUrl);
          if (idx >= 0) {
            try { URL.revokeObjectURL(playedUrl); } catch { /* ignore */ }
            this.allBlobUrls.splice(idx, 1);
          }
          c.audioBlobUrl = undefined;
        }
      }
    }
  }

  /** 清理所有缓存的 Blob URL */
  clearAllBlobUrls(): void {
    for (const url of this.allBlobUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    this.allBlobUrls = [];
  }

  // ── 工具 ──

  private getAudioIdentity(text: string): TTSAudioIdentity {
    const { voice, synthesisRate, source } = this.config.getSynthesisParams();
    return { voice, synthesisRate, source, text };
  }

  /**
   * 简易并发池：限制异步操作的最大并发数
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
}
