/**
 * TtsPlayer — HTMLAudioElement 封装（Phase 2 播放层）
 *
 * 职责：段音频 Blob 加载/播放/暂停/倍速/停止；objectURL 生命周期管理（revoke 旧段防泄漏）。
 * playBlob 返回 Promise<'ended'|'aborted'>：正常播完 resolved('ended')；stop()/destroy() 中断 resolved('aborted')。
 * audio 元素可注入（单测用 stub 替换，避免 jsdom 无真实解码器）。
 */
export type PlayFinishReason = 'ended' | 'aborted';

export interface TtsPlayerLike {
  playBlob(blob: Blob, rate: number): Promise<PlayFinishReason>;
  pause(): void;
  resume(): Promise<PlayFinishReason>;
  stop(): void;
  setRate(rate: number): void;
  destroy(): void;
}

export class TtsPlayer implements TtsPlayerLike {
  private audio: HTMLAudioElement;
  private currentUrl: string | null = null;
  private finishResolve: ((reason: PlayFinishReason) => void) | null = null;
  private destroyed = false;

  constructor(audio?: HTMLAudioElement) {
    this.audio = audio ?? new Audio();
    this.audio.preload = 'auto';
  }

  /** 加载并播放一段音频；resolve 于自然播完（'ended'）或被 stop/destroy 中断（'aborted'） */
  playBlob(blob: Blob, rate: number): Promise<PlayFinishReason> {
    this.stop();
    return this.startCurrent(rate, () => {
      this.currentUrl = URL.createObjectURL(blob);
      this.audio.src = this.currentUrl;
    });
  }

  pause(): void {
    this.audio.pause();
  }

  /** 暂停后恢复播放（未加载任何音频时返回 'aborted'）；applySrc 留空，播放由 startCurrent 尾部统一触发 */
  resume(): Promise<PlayFinishReason> {
    if (!this.currentUrl || !this.finishResolve) {
      return Promise.resolve('aborted');
    }
    return this.startCurrent(undefined, () => { /* 恢复：不重设 src，直接播放 */ });
  }

  /** 停止播放并释放当前音频资源 */
  stop(): void {
    if (this.finishResolve) {
      const resolve = this.finishResolve;
      this.finishResolve = null;
      resolve('aborted');
    }
    this.audio.pause();
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.audio.removeAttribute('src');
  }

  setRate(rate: number): void {
    this.audio.playbackRate = rate;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
  }

  private startCurrent(rate: number | undefined, applySrc: () => void): Promise<PlayFinishReason> {
    if (this.destroyed) return Promise.resolve('aborted');
    applySrc();
    if (rate !== undefined) this.audio.playbackRate = rate;
    return new Promise<PlayFinishReason>(resolve => {
      // 修复：onEnded 绑定自己的 resolve（全局 finishResolve 会在多 promise 场景
      // 被前一个监听器吞掉，导致后一个播放完成信号丢失而挂起）
      const onEnded = (): void => {
        cleanup();
        if (this.finishResolve === resolve) {
          this.finishResolve = null;
        }
        resolve('ended');
      };
      const onError = (): void => {
        // 播放错误按「提前结束」处理：调度器据此跳段，不卡死会话
        onEnded();
      };
      const cleanup = (): void => {
        this.audio.removeEventListener('ended', onEnded);
        this.audio.removeEventListener('error', onError);
      };
      this.finishResolve = resolve;
      this.audio.addEventListener('ended', onEnded);
      this.audio.addEventListener('error', onError);
      void this.audio.play().catch(() => {
        /* 自动播放策略拒绝时由上层 UI 提示；error/ended 事件兜底 */
      });
    });
  }
}
