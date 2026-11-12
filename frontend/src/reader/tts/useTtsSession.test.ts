/**
 * useTtsSession 单测（ai-agent 移植）：状态机流转/章节推进/段推进/失败跳过/
 * 章内 seek/跳段语义/进度上报/停止清理。依赖全部注入（不发网络；player stub 可控）。
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EpubBookController } from '../EpubBookController';
import { useTtsSession, type TtsSessionDeps } from './useTtsSession';
import type { TtsPlayerLike } from './ttsPlayer';

const makeBuffer = (duration = 10): AudioBuffer => ({ duration } as unknown as AudioBuffer);

function makePlayer(): TtsPlayerLike {
  return {
    decodeBlob: vi.fn().mockResolvedValue(makeBuffer(10)),
    playBuffer: vi.fn().mockResolvedValue('ended'),
    getElapsed: vi.fn(() => 0),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue('aborted'),
    stop: vi.fn(),
    setRate: vi.fn(),
    destroy: vi.fn(),
  };
}

/** 可控 player：stop() 联动将挂起播放 resolve('aborted')（模拟真实 stop 语义），记录 playBuffer 调用 */
function makeControllablePlayer(bufferDur = 10) {
  let release: ((v: 'ended' | 'aborted') => void) | null = null;
  const calls: Array<{ key: string; offset: number; rate: number }> = [];
  const player: TtsPlayerLike = {
    decodeBlob: vi.fn().mockResolvedValue(makeBuffer(bufferDur)),
    playBuffer: vi.fn((key: string, _b: AudioBuffer, opts?: { offset?: number; rate?: number }) => {
      calls.push({ key, offset: opts?.offset ?? 0, rate: opts?.rate ?? 1 });
      return new Promise<'ended' | 'aborted'>(res => {
        release = res;
      });
    }),
    getElapsed: vi.fn(() => 0),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue('aborted'),
    stop: vi.fn(() => {
      const r = release;
      release = null;
      r?.('aborted');
    }),
    setRate: vi.fn(),
    destroy: vi.fn(),
  };
  const settle = (v: 'ended' | 'aborted'): void => {
    const r = release;
    release = null;
    r?.(v);
  };
  /** 连续 settle n 次，每次后 flush 微任务队列（给 ensureChapterAudio/playChapter 的 async 链机会挂上下一个 playBuffer） */
  const settleThrough = async (count: number): Promise<void> => {
    for (let k = 0; k < count; k++) {
      settle('ended');
      await act(async () => {
        await Promise.resolve();
      });
    }
  };
  return {
    player,
    calls,
    settle,
    settleThrough,
  };
}

function makeDeps(over: Partial<TtsSessionDeps> = {}): TtsSessionDeps {
  return {
    fetchChapters: vi.fn().mockResolvedValue([
      { id: 'c1', title: '第一章', href: 'p1.xhtml' },
      { id: 'c2', title: '第二章', href: 'p2.xhtml' },
    ]),
    fetchSegments: vi.fn().mockResolvedValue([
      { segmentIndex: 0, text: '段零', textHash: 'h0' },
      { segmentIndex: 1, text: '段一', textHash: 'h1' },
    ]),
    fetchCache: vi.fn().mockResolvedValue(new Map()),
    fetchSettings: vi.fn().mockResolvedValue({ voiceId: 'v-test', speed: 1.25 }),
    resolveAudio: vi.fn().mockResolvedValue(new Blob(['audio'])),
    createPlayer: () => makePlayer(),
    ...over,
  };
}

function makeController(): EpubBookController {
  return {
    goTo: vi.fn().mockResolvedValue(undefined),
    highlightSegment: vi.fn(() => true),
    clearHighlight: vi.fn(),
  } as unknown as EpubBookController;
}

const blob = () => new Blob(['a']);

beforeEach(() => {
  localStorage.clear();
});

describe('useTtsSession', () => {
  it('start 后按章→段顺序推进并最终回到 idle', async () => {
    const player = makePlayer();
    const deps = makeDeps({ createPlayer: () => player });
    const controller = makeController();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '测试书', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'p1.xhtml', bookPercentage: null, deps,
      }),
    );
    expect(result.current.session.status).toBe('idle');

    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));

    // 2 章 × 2 段 = 4 次播放（合成 + 解码）
    expect((player.playBuffer as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    expect((player.decodeBlob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    // 每章先 goTo 章首
    expect(controller.goTo).toHaveBeenCalledWith('p1.xhtml');
    expect(controller.goTo).toHaveBeenCalledWith('p2.xhtml');
    // 段进给参数携带设置（voice/speed）
    expect(deps.resolveAudio).toHaveBeenCalledWith(
      expect.objectContaining({ text: '段零' }),
      expect.objectContaining({ voice: 'v-test', speed: 1.25 }),
    );
  });

  it('启动预热：会话开启即并发拉起前 D+1 段（首段播放期间段 1/2 已在合成流水线上）', async () => {
    const player = makePlayer();
    // 首段播放挂起：playBuffer 返回手动控制的 promise
    let releasePlay!: () => void;
    const playGate = new Promise<string>((r) => { releasePlay = () => r('ended'); });
    (player.playBuffer as ReturnType<typeof vi.fn>).mockImplementation(() => playGate);
    const deps = makeDeps({
      createPlayer: () => player,
      fetchSegments: vi.fn().mockResolvedValue([
        { segmentIndex: 0, text: '段零', textHash: 'h0' },
        { segmentIndex: 1, text: '段一', textHash: 'h1' },
        { segmentIndex: 2, text: '段二', textHash: 'h2' },
      ]),
    });
    const controller = makeController();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '测试书', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'p1.xhtml', bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    // 首段还在播放（gate 未放行）时：段 0/1/2 的合成应已全部发起（预热 D=2 → 前 3 段）
    expect((deps.resolveAudio as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].textHash)).toEqual(['h0', 'h1', 'h2']);
    await act(async () => { releasePlay(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('起始章按当前 href 定位（非第一章，仅播剩余章）', async () => {
    const deps = makeDeps();
    const controller = makeController();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'p2.xhtml', bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    // 从 p2 开始：只剩一章待播
    expect(controller.goTo).toHaveBeenCalledTimes(1);
    expect((controller.goTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('p2.xhtml');
  });

  it('合辄书（多章共文件）按渲染锚点占比定位起始章——视口 0.4 覆盖 toc_2(0.3) → 从灰狐(1)播', async () => {
    const deps = makeDeps({
      fetchChapters: vi.fn().mockResolvedValue([
        { id: 'c1', title: '书名页', href: 'titlepage.xhtml', start_offset: 0, end_offset: 10 },
        { id: 'c2', title: '合辄', href: 'index.html', start_offset: 10, end_offset: 900000 },
        { id: 'c3', title: '灰狐(1)', href: 'index.html#toc_2', text_length: 5000 },
        { id: 'c4', title: '灰狐(2)', href: 'index.html#toc_3', text_length: 2000 },
      ]),
    });
    const controller = makeController();
    (controller as unknown as Record<string, unknown>).getAnchorLayout = vi.fn(() => ({
      ratios: { 'titlepage.xhtml': null, 'index.html': null, 'index.html#toc_2': 0.3, 'index.html#toc_3': 0.6 },
      viewportRatio: 0.4,
    }));
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'index.html', bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    expect((controller.goTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('index.html#toc_2');
  });

  it('合辄书锚点布局不可用（getAnchorLayout 返回全 null）→ 回退 href 匹配不崩', async () => {
    const deps = makeDeps({
      fetchChapters: vi.fn().mockResolvedValue([
        { id: 'c1', title: '书名页', href: 'titlepage.xhtml' },
        { id: 'c2', title: '合辄', href: 'index.html' },
        { id: 'c3', title: '灰狐(1)', href: 'index.html#toc_2' },
        { id: 'c4', title: '灰狐(2)', href: 'index.html#toc_3' },
      ]),
    });
    const controller = makeController();
    (controller as unknown as Record<string, unknown>).getAnchorLayout = vi.fn(() => ({
      ratios: { 'index.html#toc_2': null, 'index.html#toc_3': null },
      viewportRatio: null,
    }));
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'index.html', bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    // 回退 href 匹配：index.html 命中「合辑」条目（c2）
    expect((controller.goTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('index.html');
  });

  it('合成失败计为 failedCount 并跳过（不中断整章）', async () => {
    const deps = makeDeps({ resolveAudio: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(blob()) });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    expect(result.current.session.failedCount).toBe(1);
  });

  it('解码失败同样计为 failedCount 并跳过（ai-agent 移植：坏段不卡会话）', async () => {
    const player = makePlayer();
    let n = 0;
    (player.decodeBlob as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n += 1;
      return n === 1 ? Promise.reject(new Error('bad')) : Promise.resolve(makeBuffer(10));
    });
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    expect(result.current.session.failedCount).toBe(1);
  });

  it('stop 清空状态并销毁 player', async () => {
    const player = makePlayer();
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await act(async () => { result.current.stop(); });
    expect(result.current.session.status).toBe('idle');
    expect(player.destroy).toHaveBeenCalled();
  });

  it('pause/resume 驱动状态与 player（aborted 无请求 = 会话中断回 idle）', async () => {
    const deps = makeDeps();
    // 播放阻塞在第一段：playBuffer 返回手动控制的 promise
    let release!: (v: 'ended' | 'aborted') => void;
    const player = makePlayer();
    (player.playBuffer as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<'ended' | 'aborted'>(res => { release = res; }));
    deps.createPlayer = () => player;
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('playing'));

    act(() => { result.current.pause(); });
    expect(result.current.session.status).toBe('paused');
    expect(player.pause).toHaveBeenCalled();

    act(() => { result.current.resume(); });
    expect(result.current.session.status).toBe('playing');

    act(() => { release('aborted'); });
    // aborted 且无 seek/skip 请求 = 会话中断 → 回 idle
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('章内 seekTo：中断当前段，从目标段+偏移续播（会话延续）', async () => {
    const { player, calls, settleThrough } = makeControllablePlayer();
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('playing'));
    expect(calls[0]).toEqual({ key: 'c1:0', offset: 0, rate: 1.25 });

    // mock 解码 buffer 各 10s（已解码真实时长），total 20s；seek 60% → target 12s → 第 1 段（10s~20s）offset 2.0s
    act(() => { result.current.seekTo(0.6); });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].key).toBe('c1:1');
    expect(calls[1].offset).toBeCloseTo(2.0, 2);
    expect(result.current.session.status).toBe('playing'); // seek 后仍延续，不回 idle

    await settleThrough(1);
    await waitFor(() => expect(calls.length).toBe(3)); // 第二章 c2:0
    await settleThrough(2);
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('skipSegment 跳到下一段且会话延续（旧实现误终止会话，已修正）', async () => {
    const { player, calls, settleThrough } = makeControllablePlayer();
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('playing'));

    act(() => { result.current.skipSegment(); });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1].key).toBe('c1:1'); // 下一段，同章
    expect(result.current.session.status).toBe('playing');

    await settleThrough(4);
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('playing 时轮询章内进度（elapsed/duration 上报）', async () => {
    const { player, settleThrough } = makeControllablePlayer();
    (player.getElapsed as ReturnType<typeof vi.fn>).mockReturnValue(0.2);
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    // 进度 tick 周期 250ms
    await waitFor(
      () => expect(result.current.session.elapsed).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    // 两段都已解码（mock buffer 各 10s）→ 真实时长模型 total 20s；elapsed = 0 + getElapsed(0.2)
    expect(result.current.session.duration).toBeCloseTo(20, 2);
    expect(result.current.session.elapsed).toBeCloseTo(0.2, 2);

    await settleThrough(4);
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('onSegmentStart 每段触发（高亮联动）', async () => {
    const deps = makeDeps();
    const onSegmentStart = vi.fn();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null,
        onSegmentStart, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    expect(onSegmentStart).toHaveBeenCalledTimes(4);
    expect(onSegmentStart).toHaveBeenCalledWith(expect.objectContaining({ text: '段零' }));
  });

  it('setRate 播放中生效（player 与会话状态同步）', async () => {
    const player = makePlayer();
    let release!: (v: 'ended' | 'aborted') => void;
    (player.playBuffer as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<'ended' | 'aborted'>(res => { release = res; }));
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, bookPercentage: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('playing'));

    act(() => { result.current.setRate(2.0); });
    expect(result.current.session.rate).toBe(2.0);
    expect(player.setRate).toHaveBeenCalledWith(2.0);

    // 逐段释放（每段挂新 promise）直至会话自然结束
    for (let i = 0; i < 8 && result.current.session.status !== 'idle'; i++) {
      act(() => { release('ended'); });
      await act(async () => { await Promise.resolve(); });
    }
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });
});
