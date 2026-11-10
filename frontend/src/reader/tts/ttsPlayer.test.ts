/**
 * TtsPlayer 单测（ai-agent 移植）：WebAudio 解码/播放/中断/暂停恢复/倍速/getElapsed
 * 注入 stub AudioContext（jsdom 无真实解码器；currentTime 用可推进的 time holder）。
 */
import { describe, it, expect, vi } from 'vitest';
import { TtsPlayer } from './ttsPlayer';

function makeAudioBuffer(duration = 10): AudioBuffer {
  return { duration } as unknown as AudioBuffer;
}

function makeSource() {
  const listeners = new Map<string, Set<() => void>>();
  const src = {
    buffer: null as AudioBuffer | null,
    playbackRate: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => {
      listeners.get(type)?.delete(fn);
    },
    __emit(type: string) {
      listeners.get(type)?.forEach(fn => fn());
    },
  };
  return src;
}

type StubSource = ReturnType<typeof makeSource>;

function makeStubCtx() {
  const time = { now: 0 };
  const sources: StubSource[] = [];
  const ctx = {
    get currentTime() {
      return time.now;
    },
    set currentTime(v: number) {
      time.now = v;
    },
    state: 'running',
    destination: {},
    createGain: vi.fn(() => ({ connect: vi.fn() })),
    createBufferSource: vi.fn(() => {
      const s = makeSource();
      sources.push(s);
      return s;
    }),
    decodeAudioData: vi.fn(
      (_bytes: ArrayBuffer, success: (b: AudioBuffer) => void, _err?: (e: DOMException) => void) => {
        success(makeAudioBuffer(10));
        return Promise.resolve(makeAudioBuffer(10));
      },
    ),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  return { ctx: ctx as unknown as AudioContext, raw: ctx, time, sources };
}

/** jsdom 的 Blob 缺 arrayBuffer 方法，decodeBlob 测试用 stub 载体（关注点是 decode 调用链） */
const fakeBlob = (): Blob => ({ arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob);

describe('TtsPlayer', () => {
  it('decodeBlob 经 ctx.decodeAudioData 返回 AudioBuffer', async () => {
    const { ctx, raw } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const buf = await player.decodeBlob(fakeBlob());
    expect(buf.duration).toBe(10);
    expect(raw.decodeAudioData).toHaveBeenCalledTimes(1);
  });

  it('decodeBlob 解码失败 reject（调用方按坏段跳过）', async () => {
    const { ctx, raw } = makeStubCtx();
    raw.decodeAudioData = vi.fn(
      (_b: ArrayBuffer, _s: (b: AudioBuffer) => void, err?: (e: DOMException) => void) => {
        // 只走回调形态（与 decodeBlob 的调用方式一致）；resolve 形态返回值满足 AudioContext 类型（无人 await，无 unhandled 风险）
        err?.(new DOMException('bad data', 'EncodingError'));
        return Promise.resolve(makeAudioBuffer(10));
      },
    );
    const player = new TtsPlayer(ctx);
    await expect(player.decodeBlob(fakeBlob())).rejects.toBeTruthy();
  });

  it('playBuffer 按倍速/偏移起播，getElapsed 随 ctx.currentTime 推进', async () => {
    const { ctx, time, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const p = player.playBuffer('k', makeAudioBuffer(10), { offset: 3, rate: 1.5 });
    expect(sources[0].playbackRate.value).toBe(1.5);
    expect(sources[0].start).toHaveBeenCalledWith(0, 3);
    time.now = 5;
    expect(player.getElapsed()).toBeCloseTo(3 + 5 * 1.5);
    sources[0].__emit('ended');
    await expect(p).resolves.toBe('ended');
    expect(sources[0].disconnect).toHaveBeenCalled();
  });

  it('偏移超出时长时截断到 duration-0.05', () => {
    const { ctx, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    player.playBuffer('k', makeAudioBuffer(5), { offset: 100 });
    expect(sources[0].start).toHaveBeenCalledWith(0, 4.95);
    player.stop();
  });

  it('stop() 中断播放 resolve(aborted) 并停掉 source', async () => {
    const { ctx, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const p = player.playBuffer('k', makeAudioBuffer(10));
    player.stop();
    await expect(p).resolves.toBe('aborted');
    expect(sources[0].stop).toHaveBeenCalled();
    expect(player.getElapsed()).toBe(0);
  });

  it('连续 playBuffer：前段 aborted，后段自然 ended', async () => {
    const { ctx, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const p1 = player.playBuffer('k1', makeAudioBuffer(10));
    const p2 = player.playBuffer('k2', makeAudioBuffer(10));
    await expect(p1).resolves.toBe('aborted');
    sources[1].__emit('ended');
    await expect(p2).resolves.toBe('ended');
  });

  it('pause 调 ctx.suspend；resume 桥接完成信号（原 promise 与 resume 返回值同达）', async () => {
    const { ctx, raw, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const p = player.playBuffer('k', makeAudioBuffer(10));
    player.pause();
    expect(raw.suspend).toHaveBeenCalled();
    const r = player.resume();
    expect(raw.resume).toHaveBeenCalled();
    sources[0].__emit('ended');
    await expect(p).resolves.toBe('ended');
    await expect(r).resolves.toBe('ended');
  });

  it('无挂起播放时 resume 返回 aborted', async () => {
    const { ctx } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    await expect(player.resume()).resolves.toBe('aborted');
  });

  it('stop 解除 suspend 冻结（暂停中 seek/stop 场景）', async () => {
    const { ctx, raw } = makeStubCtx();
    raw.state = 'suspended';
    const player = new TtsPlayer(ctx);
    const p = player.playBuffer('k', makeAudioBuffer(10));
    player.pause();
    player.stop();
    await expect(p).resolves.toBe('aborted');
    expect(raw.resume).toHaveBeenCalled();
  });

  it('setRate 播放中热切换：重锚进度不跳变', async () => {
    const { ctx, time, sources } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    const p = player.playBuffer('k', makeAudioBuffer(10), { rate: 1 });
    time.now = 2;
    player.setRate(2);
    expect(sources[0].playbackRate.value).toBe(2);
    time.now = 3; // 再走 1 秒（2 倍速 = 2 秒内容）
    expect(player.getElapsed()).toBeCloseTo(2 + 1 * 2);
    sources[0].__emit('ended');
    await expect(p).resolves.toBe('ended');
  });

  it('destroy 后 playBuffer 直接 aborted 且 ctx.close', async () => {
    const { ctx, raw } = makeStubCtx();
    const player = new TtsPlayer(ctx);
    player.destroy();
    await expect(player.playBuffer('k', makeAudioBuffer(10))).resolves.toBe('aborted');
    expect(raw.close).toHaveBeenCalled();
  });
});
