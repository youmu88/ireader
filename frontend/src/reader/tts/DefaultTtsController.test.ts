import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultTtsController } from './DefaultTtsController';
import type { ReaderEngine } from '../engine/types';
import type { ReadingPosition } from '../position/types';

// mock splitText
vi.mock('../../services/ttsPlayer', () => ({
  splitText: (text: string) => text.split('。').filter(Boolean).map(s => s + '。'),
}));

// mock SequentialPlayer
vi.mock('./SequentialPlayer', () => ({
  SequentialPlayer: vi.fn().mockImplementation((_opts: any, cbs: any) => ({
    load: vi.fn(),
    play: vi.fn(async (idx: number) => {
      cbs.onStateChange?.('playing');
      cbs.onSegmentChange?.(idx ?? 0, '测试段落。');
    }),
    pause: vi.fn(() => cbs.onStateChange?.('paused')),
    resume: vi.fn(() => cbs.onStateChange?.('playing')),
    stop: vi.fn(),
    destroy: vi.fn(),
    jumpToSegment: vi.fn(async (idx: number) => {
      cbs.onSegmentChange?.(idx, '跳转段落。');
    }),
    setSpeed: vi.fn(),
    state: 'idle',
    currentSegmentIndex: 0,
    totalSegments: 3,
  })),
}));

function makeEngine(): ReaderEngine {
  return {
    format: 'txt',
    mount: vi.fn(),
    unmount: vi.fn(),
    loadChapter: vi.fn(),
    getPageCount: vi.fn(() => 1),
    getCurrentPage: vi.fn(() => 0),
    goToPage: vi.fn(),
    nextPage: vi.fn(() => true),
    prevPage: vi.fn(() => false),
    scrollToRatio: vi.fn(),
    getScrollRatio: vi.fn(() => 0),
    getVisibleText: vi.fn(() => ''),
    getFullChapterText: vi.fn(() => Promise.resolve('第一段。第二段。第三段。')),
    onPositionChange: vi.fn(() => () => {}),
    onChapterBoundary: vi.fn(() => () => {}),
  } as unknown as ReaderEngine;
}

function makePos(overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    bookId: 'book-1',
    chapterId: 'ch-1',
    chapterIndex: 0,
    ratio: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('DefaultTtsController', () => {
  let engine: ReaderEngine;
  let controller: DefaultTtsController;

  beforeEach(() => {
    engine = makeEngine();
    controller = new DefaultTtsController({ bookId: 'book-1', engine });
  });

  it('初始状态为 idle', () => {
    expect(controller.state).toBe('idle');
    expect(controller.currentSegmentIndex).toBe(0);
    expect(controller.totalSegments).toBe(0);
  });

  it('startFromPosition 加载分段并开始播放', async () => {
    const stateCb = vi.fn();
    const segCb = vi.fn();
    controller.onStateChange(stateCb);
    controller.onSegmentChange(segCb);

    await controller.startFromPosition(makePos({ ratio: 0 }));

    expect(controller.totalSegments).toBe(3);
    expect(stateCb).toHaveBeenCalledWith('playing');
    expect(segCb).toHaveBeenCalledWith(0, '测试段落。');
  });

  it('startFromPosition ratio=0.5 从中间段开始', async () => {
    const segCb = vi.fn();
    controller.onSegmentChange(segCb);

    await controller.startFromPosition(makePos({ ratio: 0.5 }));

    // floor(0.5 * 3) = 1
    expect(segCb).toHaveBeenCalledWith(1, '测试段落。');
  });

  it('pause / resume 切换状态', async () => {
    const stateCb = vi.fn();
    controller.onStateChange(stateCb);

    await controller.startFromPosition(makePos());
    controller.pause();
    expect(stateCb).toHaveBeenCalledWith('paused');

    controller.resume();
    expect(stateCb).toHaveBeenCalledWith('playing');
  });

  it('stop 重置为 idle', async () => {
    await controller.startFromPosition(makePos());
    controller.stop();
    expect(controller.state).toBe('idle');
  });

  it('jumpToSegment 跳转分段', async () => {
    const segCb = vi.fn();
    controller.onSegmentChange(segCb);

    await controller.startFromPosition(makePos());
    await controller.jumpToSegment(2);

    expect(segCb).toHaveBeenCalledWith(2, '跳转段落。');
  });

  it('setSpeed 不抛错', async () => {
    await controller.startFromPosition(makePos());
    expect(() => controller.setSpeed(1.5)).not.toThrow();
  });

  it('setVoice 不抛错', () => {
    expect(() => controller.setVoice('zh-CN-YunxiNeural')).not.toThrow();
  });

  it('onChapterEnd 订阅/取消', () => {
    const cb = vi.fn();
    const unsub = controller.onChapterEnd(cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('destroy 清理所有监听器', async () => {
    const engine = makeEngine();
    const ctrl = new DefaultTtsController({ bookId: 'b1', engine });
    await ctrl.startFromPosition(makePos());
    expect(ctrl.state).toBe('playing');
    ctrl.destroy();
    expect(ctrl.state).toBe('idle');
  });

  it('取消订阅后不再收到事件', async () => {
    const stateCb = vi.fn();
    const unsub = controller.onStateChange(stateCb);
    unsub();

    await controller.startFromPosition(makePos());
    expect(stateCb).not.toHaveBeenCalled();
  });
});
