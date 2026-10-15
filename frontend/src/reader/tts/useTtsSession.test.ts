/**
 * useTtsSession 单测（Phase 2）：状态机流转/章节推进/段推进/失败跳过/停止清理
 * 依赖全部注入（不发网络；player stub 立即播完）。
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EpubBookController } from '../EpubBookController';
import { useTtsSession, type TtsSessionDeps } from './useTtsSession';
import type { TtsPlayerLike } from './ttsPlayer';

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

function makePlayer(): TtsPlayerLike {
  return {
    playBlob: vi.fn().mockResolvedValue('ended'),
    pause: vi.fn(),
    resume: vi.fn().mockResolvedValue('ended'),
    stop: vi.fn(),
    setRate: vi.fn(),
    destroy: vi.fn(),
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
        controllerRef: { current: controller }, chapterHref: 'p1.xhtml', deps,
      }),
    );
    expect(result.current.session.status).toBe('idle');

    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));

    // 2 章 × 2 段 = 4 次播放
    expect((player.playBlob as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    // 每章先 goTo 章首
    expect(controller.goTo).toHaveBeenCalledWith('p1.xhtml');
    expect(controller.goTo).toHaveBeenCalledWith('p2.xhtml');
    // 段进给参数携带设置（voice/speed）
    expect(deps.resolveAudio).toHaveBeenCalledWith(
      expect.objectContaining({ text: '段零' }),
      expect.objectContaining({ voice: 'v-test', speed: 1.25 }),
    );
  });

  it('起始章按当前 href 定位（非第一章，仅播剩余章）', async () => {
    const deps = makeDeps();
    const controller = makeController();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: controller }, chapterHref: 'p2.xhtml', deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
    // 从 p2 开始：只剩一章待播
    expect(controller.goTo).toHaveBeenCalledTimes(1);
    expect((controller.goTo as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('p2.xhtml');
  });

  it('段失败计为 failedCount 并跳过（不中断整章）', async () => {
    const deps = makeDeps({ resolveAudio: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(blob())
      .mockResolvedValueOnce(blob()) });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, deps,
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
        controllerRef: { current: makeController() }, chapterHref: null, deps,
      }),
    );
    await act(async () => { result.current.start(); });
    await act(async () => { result.current.stop(); });
    expect(result.current.session.status).toBe('idle');
    expect(player.destroy).toHaveBeenCalled();
  });

  it('pause/resume 驱动状态与 player', async () => {
    const deps = makeDeps();
    // 播放阻塞在第一段：playBlob 返回手动控制的 promise
    let release!: (v: 'ended' | 'aborted') => void;
    const player = makePlayer();
    (player.playBlob as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<typeof release extends (v: infer R) => void ? R : never>(res => { release = res; }));
    deps.createPlayer = () => player;
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, deps,
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
    // aborted 视为会话中断 → 回 idle
    await waitFor(() => expect(result.current.session.status).toBe('idle'));
  });

  it('onSegmentStart 每段触发（高亮联动）', async () => {
    const deps = makeDeps();
    const onSegmentStart = vi.fn();
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null,
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
    (player.playBlob as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise<'ended' | 'aborted'>(res => { release = res; }));
    const deps = makeDeps({ createPlayer: () => player });
    const { result } = renderHook(() =>
      useTtsSession({
        bookId: 'book-1', bookTitle: '', format: 'epub',
        controllerRef: { current: makeController() }, chapterHref: null, deps,
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
