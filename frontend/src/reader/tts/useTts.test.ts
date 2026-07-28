import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTts } from './useTts';
import type { ReaderEngine } from '../engine/types';
import type { ReadingPosition } from '../position/types';

// mock DefaultTtsController
vi.mock('./DefaultTtsController', () => {
  return {
    DefaultTtsController: vi.fn().mockImplementation(() => ({
      state: 'idle',
      currentSegmentIndex: 0,
      totalSegments: 10,
      startFromPosition: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      stop: vi.fn(),
      jumpToSegment: vi.fn(async () => {}),
      setPlaybackRate: vi.fn(),
      setSynthesisRate: vi.fn(),
      setVoice: vi.fn(),
      onSegmentChange: vi.fn(() => () => {}),
      onStateChange: vi.fn(() => () => {}),
      onChapterEnd: vi.fn(() => () => {}),
      destroy: vi.fn(),
    })),
  };
});

function makeEngine(): ReaderEngine {
  return {
    format: 'txt',
    mount: vi.fn(),
    unmount: vi.fn(),
    loadChapter: vi.fn(async () => {}),
    getPageCount: vi.fn(() => 1),
    getCurrentPage: vi.fn(() => 0),
    goToPage: vi.fn(),
    nextPage: vi.fn(() => true),
    prevPage: vi.fn(() => false),
    scrollToRatio: vi.fn(),
    getScrollRatio: vi.fn(() => 0),
    getVisibleText: vi.fn(() => ''),
    getFullChapterText: vi.fn(async () => '你好世界。再见。'),
    onPositionChange: vi.fn(() => () => {}),
    onChapterBoundary: vi.fn(() => () => {}),
  } as unknown as ReaderEngine;
}

function makePos(): ReadingPosition {
  return { bookId: 'b1', chapterId: 'c1', chapterIndex: 0, ratio: 0.5, timestamp: Date.now() };
}

describe('useTts', () => {
  let engine: ReaderEngine;

  beforeEach(() => {
    engine = makeEngine();
  });

  it('初始状态为 idle', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    expect(result.current.state).toBe('idle');
    expect(result.current.currentSegmentIndex).toBe(-1);
  });

  it('bookId 为空时不创建控制器', () => {
    const { result } = renderHook(() => useTts({ bookId: undefined, engine }));
    expect(result.current.getController()).toBeNull();
  });

  it('engine 为 null 时不创建控制器', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine: null }));
    expect(result.current.getController()).toBeNull();
  });

  it('bookId + engine 有效时创建控制器', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    expect(result.current.getController()).not.toBeNull();
  });

  it('start 调用 controller.startFromPosition', async () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    const ctrl = result.current.getController()!;
    await act(async () => { await result.current.start(makePos()); });
    expect(ctrl.startFromPosition).toHaveBeenCalled();
  });

  it('pause/resume/stop 委托给 controller', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    const ctrl = result.current.getController()!;
    act(() => { result.current.pause(); });
    expect(ctrl.pause).toHaveBeenCalled();
    act(() => { result.current.resume(); });
    expect(ctrl.resume).toHaveBeenCalled();
    act(() => { result.current.stop(); });
    expect(ctrl.stop).toHaveBeenCalled();
  });

  it('jumpToSegment 委托给 controller', async () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    const ctrl = result.current.getController()!;
    await act(async () => { await result.current.jumpToSegment(5); });
    expect(ctrl.jumpToSegment).toHaveBeenCalledWith(5);
  });

  it('setPlaybackRate/setSynthesisRate/setVoice 委托给 controller', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    const ctrl = result.current.getController()!;
    act(() => { result.current.setPlaybackRate(1.5); });
    expect(ctrl.setPlaybackRate).toHaveBeenCalledWith(1.5);
    act(() => { result.current.setSynthesisRate(1.25); });
    expect(ctrl.setSynthesisRate).toHaveBeenCalledWith(1.25);
    act(() => { result.current.setVoice('zh-CN-XiaoxiaoNeural'); });
    expect(ctrl.setVoice).toHaveBeenCalledWith('zh-CN-XiaoxiaoNeural');
  });

  it('卸载时 destroy controller', () => {
    const { result, unmount } = renderHook(() => useTts({ bookId: 'b1', engine }));
    const ctrl = result.current.getController()!;
    unmount();
    expect(ctrl.destroy).toHaveBeenCalled();
  });

  it('stop 重置 segmentIndex 和 segmentText', () => {
    const { result } = renderHook(() => useTts({ bookId: 'b1', engine }));
    act(() => { result.current.stop(); });
    expect(result.current.currentSegmentIndex).toBe(-1);
    expect(result.current.segmentText).toBe('');
  });
});
