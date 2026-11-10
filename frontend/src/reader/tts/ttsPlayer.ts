/**
 * TtsPlayer — WebAudio 播放器（ai-agent 移植：预解码 / 无缝衔接 / 章内 seek 基座）
 *
 * 职责：Blob→AudioBuffer 解码；零间隙播放（暂停 = ctx.suspend，不销毁节点，恢复零重建）；
 *       偏移起播（seek）；倍速；getElapsed 段内已播秒数（suspend 冻结、seek/倍速自动重锚）。
 * playBuffer 返回 Promise<'ended'|'aborted'>：自然播完 'ended'；stop()/destroy() 中断 'aborted'。
 * AudioContext 可注入（jsdom 无真实解码器，单测用 stub；浏览器默认惰性创建）。
 */
export type PlayFinishReason = 'ended' | 'aborted';

export interface PlayBufferOptions {
  /** 起播偏移（秒，章内 seek 用） */
  offset?: number;
  rate?: number;
}

export interface TtsPlayerLike {
  /** 预解码入口：解码成功即可零等待 playBuffer */
  decodeBlob(blob: Blob): Promise<AudioBuffer>;
  playBuffer(key: string, buffer: AudioBuffer, opts?: PlayBufferOptions): Promise<PlayFinishReason>;
  /** 段内已播秒数（无播放时 0） */
  getElapsed(): number;
  pause(): void;
  /** 恢复播放；无挂起播放时 resolve('aborted') */
  resume(): Promise<PlayFinishReason>;
  stop(): void;
  setRate(rate: number): void;
  destroy(): void;
}

export class TtsPlayer implements TtsPlayerLike {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  /** 当前段完成信号槽（唯一出口：onended/stop 都走它，防多 promise 双 resolve） */
  private finishResolve: ((reason: PlayFinishReason) => void) | null = null;
  /** 进度锚：elapsed = anchorOffset + (ctx.currentTime - anchorCtxTime) * rate */
  private anchorOffset = 0;
  private anchorCtxTime = 0;
  private rate = 1.0;
  private destroyed = false;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? null;
    if (this.ctx) this.initGain();
  }

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC!();
    }
    if (!this.gain) this.initGain();
    return this.ctx;
  }

  private initGain(): void {
    this.gain = this.ctx!.createGain();
    this.gain.connect(this.ctx!.destination);
  }

  /** Blob 解码为 AudioBuffer（失败 reject，调用方按坏段跳过） */
  async decodeBlob(blob: Blob): Promise<AudioBuffer> {
    const ctx = this.ensureCtx();
    const bytes = await blob.arrayBuffer();
    return await new Promise<AudioBuffer>((resolve, reject) => {
      // 回调式兼容 Safari 旧实现（不支持 promise 返回形态）
      ctx.decodeAudioData(bytes, resolve, reject);
    });
  }

  /** 播放已解码音频；可指定起播偏移（seek）与倍速 */
  playBuffer(_key: string, buffer: AudioBuffer, opts?: PlayBufferOptions): Promise<PlayFinishReason> {
    this.stop();
    if (this.destroyed) return Promise.resolve('aborted');
    const ctx = this.ensureCtx();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const rate = opts?.rate ?? this.rate;
    source.playbackRate.value = rate;
    source.connect(this.gain!);
    const offset = Math.max(0, Math.min(opts?.offset ?? 0, Math.max(0, buffer.duration - 0.05)));
    this.rate = rate;
    this.anchorOffset = offset;
    this.anchorCtxTime = ctx.currentTime;
    return new Promise<PlayFinishReason>(resolve => {
      const onEnded = (): void => {
        source.removeEventListener('ended', onEnded);
        source.disconnect(); // 播完即断链（节点可回收；重复 disconnect 安全）
        // 完成信号只走槽：stop() 已 resolve('aborted') 后此处不再覆盖；
        // resume 桥接后槽是新函数，'ended' 同时送达原 promise 与 resume 调用方
        const settle = this.finishResolve;
        if (settle) this.finishResolve = null;
        if (this.source === source) this.source = null;
        settle?.('ended');
      };
      source.addEventListener('ended', onEnded);
      this.finishResolve = resolve;
      this.source = source;
      source.start(0, offset);
    });
  }

  getElapsed(): number {
    if (!this.source || !this.ctx) return 0;
    return this.anchorOffset + (this.ctx.currentTime - this.anchorCtxTime) * this.rate;
  }

  /** 暂停：冻结 AudioContext（进度锚随 ctx.currentTime 停走；节点不销毁，恢复零重建） */
  pause(): void {
    if (this.ctx && this.source && this.ctx.state === 'running') void this.ctx.suspend();
  }

  /** 恢复播放：解冻 AudioContext；返回当前段完成信号（'aborted' = 无挂起播放） */
  resume(): Promise<PlayFinishReason> {
    if (!this.ctx || !this.source || !this.finishResolve) return Promise.resolve('aborted');
    void this.ctx.resume();
    return new Promise<PlayFinishReason>(resolve => {
      // 桥接：槽替换为同时送达原 promise 与本次 resume 调用方
      const prev = this.finishResolve!;
      this.finishResolve = reason => {
        prev(reason);
        resolve(reason);
      };
    });
  }

  /** 停止当前段（resolve('aborted')）；自动解除 suspend 冻结（暂停中 seek/stop 场景） */
  stop(): void {
    if (this.finishResolve) {
      const settle = this.finishResolve;
      this.finishResolve = null;
      settle('aborted');
    }
    if (this.source) {
      const source = this.source;
      this.source = null;
      try {
        source.stop();
      } catch {
        /* 未 start 过的节点 */
      }
      source.disconnect();
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** 倍速：播放中热切换（重锚进度，elapsed 不跳变） */
  setRate(rate: number): void {
    if (this.source && this.ctx) {
      this.anchorOffset = this.getElapsed();
      this.anchorCtxTime = this.ctx.currentTime;
      this.source.playbackRate.value = rate;
    }
    this.rate = rate;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stop();
    if (this.ctx) {
      const ctx = this.ctx;
      this.ctx = null;
      this.gain = null;
      void ctx.close().catch(() => {
        /* 已关闭 */
      });
    }
  }
}
