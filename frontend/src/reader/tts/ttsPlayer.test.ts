/**
 * TtsPlayer 单测（Phase 2）：Blob 加载/播放完成/中断/objectURL 生命周期
 * 注入 stub audio 元素（jsdom 无真实解码器）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TtsPlayer } from './ttsPlayer';

/** 可手动触发 ended/error 的 stub audio */
function makeStubAudio() {
  const listeners = new Map<string, Set<() => void>>();
  const el = {
    preload: '',
    src: '',
    playbackRate: 1,
    paused: true,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(() => { el.paused = true; }),
    removeAttribute: vi.fn(function (this: unknown, name: string) { if (name === 'src') el.src = ''; }),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => { listeners.get(type)?.delete(fn); }),
    /** 测试辅助：触发事件 */
    __emit(type: string) { listeners.get(type)?.forEach(fn => fn()); },
  };
  return el as unknown as HTMLAudioElement & { __emit: (type: string) => void; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn>; src: string };
}

const createObjectURL = vi.fn(() => 'blob:mock-url');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  (globalThis as unknown as { URL: unknown }).URL = { createObjectURL, revokeObjectURL } as unknown as typeof URL;
});

describe('TtsPlayer', () => {
  it('playBlob 播完自然 resolve(ended) 并设置 src/rate', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    const p = player.playBlob(new Blob(['x']), 1.5);
    expect(stub.playbackRate).toBe(1.5);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    stub.__emit('ended');
    await expect(p).resolves.toBe('ended');
  });

  it('stop() 中断播放 resolve(aborted) 并 revoke URL', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    const p = player.playBlob(new Blob(['x']), 1.0);
    player.stop();
    await expect(p).resolves.toBe('aborted');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(stub.pause).toHaveBeenCalled();
  });

  it('连续 playBlob 释放上一段 URL', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    const p1 = player.playBlob(new Blob(['1']), 1.0);
    const p2 = player.playBlob(new Blob(['2']), 1.0);
    await expect(p1).resolves.toBe('aborted');
    stub.__emit('ended');
    await expect(p2).resolves.toBe('ended');
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('播放错误按提前结束处理（不卡死会话）', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    const p = player.playBlob(new Blob(['x']), 1.0);
    stub.__emit('error');
    await expect(p).resolves.toBe('ended');
  });

  it('pause/resume 复用当前音频', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    const p = player.playBlob(new Blob(['x']), 1.0);
    player.pause();
    const r = player.resume();
    expect(stub.play).toHaveBeenCalledTimes(2);
    stub.__emit('ended');
    await expect(p).resolves.toBe('ended');
    await expect(r).resolves.toBe('ended');
  });

  it('destroy 后 playBlob 直接 aborted', async () => {
    const stub = makeStubAudio();
    const player = new TtsPlayer(stub);
    player.destroy();
    await expect(player.playBlob(new Blob(['x']), 1.0)).resolves.toBe('aborted');
  });
});
