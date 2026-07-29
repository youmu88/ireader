/**
 * TTS Media Session — Media Session API 管理 + 心跳检测 + 页面可见性生命周期
 *
 * 从 ttsPlayer.ts 提取，职责：
 * 1. Media Session 元数据 / 播放状态 / 锁屏操作按钮
 * 2. 心跳定时器：检测浏览器静默暂停后自动恢复
 * 3. visibilitychange / pagehide 事件监听
 */

// ===== 类型定义 =====

export interface MediaSessionCallbacks {
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onPrevChapter?: () => void;
  onNextChapter?: () => void;
  /** 页面进入后台（visibilityState=hidden） */
  onHidden?: () => void;
  /** 页面回到前台（visibilityState=visible） */
  onVisible?: () => void;
  /** 页面即将卸载（pagehide） */
  onPageHide?: () => void;
}

export interface MediaSessionMetadataConfig {
  title: string;
  coverUrl?: string;
}

// ===== TtsMediaSession =====

export class TtsMediaSession {
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private boundVisibilityHandler: (() => void) | null = null;
  private boundPageHideHandler: (() => void) | null = null;
  private destroyed = false;

  constructor(private callbacks: MediaSessionCallbacks) {}

  // ── 初始化 / 销毁 ──

  /**
   * 注册 Media Session 操作按钮 + visibilitychange / pagehide 监听
   */
  setup(): void {
    if (this.destroyed) return;

    // ── Media Session 操作按钮 ──
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => this.callbacks.onPlay());
        navigator.mediaSession.setActionHandler('pause', () => this.callbacks.onPause());
        navigator.mediaSession.setActionHandler('stop', () => this.callbacks.onStop());
        navigator.mediaSession.setActionHandler('previoustrack', () => { this.callbacks.onPrevChapter?.(); });
        navigator.mediaSession.setActionHandler('nexttrack', () => { this.callbacks.onNextChapter?.(); });
        navigator.mediaSession.setActionHandler('seekbackward', () => { /* 预留 */ });
        navigator.mediaSession.setActionHandler('seekforward', () => { /* 预留 */ });
      } catch { /* Media Session 不可用则静默跳过 */ }
    }

    // ── visibilitychange ──
    this.boundVisibilityHandler = () => {
      if (this.destroyed) return;
      if (document.visibilityState === 'hidden') {
        this.callbacks.onHidden?.();
      } else {
        this.callbacks.onVisible?.();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);

    // ── pagehide ──
    this.boundPageHideHandler = () => {
      if (!this.destroyed) this.callbacks.onPageHide?.();
    };
    window.addEventListener('pagehide', this.boundPageHideHandler);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopHeartbeat();

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
  }

  // ── Media Session 状态 ──

  /** 更新锁屏元数据（书名 + 封面） */
  updateMetadata(config: MediaSessionMetadataConfig): void {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: config.title || 'iReader 语音朗读',
        artist: 'iReader',
        album: config.title || '有声书',
        ...(config.coverUrl ? { artwork: [{ src: config.coverUrl, sizes: '256x256', type: 'image/png' }] } : {}),
      });
    } catch { /* Media Session 不可用则静默跳过 */ }
  }

  /** 同步播放状态到 Media Session */
  setPlaybackState(state: 'playing' | 'paused' | 'none'): void {
    if ('mediaSession' in navigator) {
      try { navigator.mediaSession.playbackState = state; } catch { /* ignore */ }
    }
  }

  // ── 心跳检测 ──

  /**
   * 启动心跳：每 3 秒检测音频是否被浏览器静默暂停，自动恢复播放
   * @param getAudio 获取当前 audio 元素
   * @param isActive 当前是否处于 playing 状态
   */
  startHeartbeat(getAudio: () => HTMLAudioElement | null, isActive: () => boolean): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!isActive() || this.destroyed) return;
      const audio = getAudio();
      if (!audio) return;
      try {
        if (audio.paused && !audio.ended) {
          const dur = audio.duration;
          const ct = audio.currentTime;
          const naturallyEnding = dur > 0 && ct > 0 && ct >= dur - 0.5;
          if (!naturallyEnding) {
            audio.play().catch(() => {});
          }
        }
      } catch { /* 静默 */ }
    }, 3000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
