import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReaderEngine } from '../engine/types';
import type { ReadingPosition } from './types';
import { useReadingPosition } from './useReadingPosition';

// ── 工具函数 ─────────────────────────────────────────────

function makePosition(overrides: Partial<ReadingPosition> = {}): ReadingPosition {
  return {
    bookId: 'book-1',
    chapterId: 'ch-1',
    chapterIndex: 0,
    ratio: 0,
    timestamp: 1000,
    ...overrides,
  };
}

/** 创建最小 mock 引擎，只实现 onPositionChange */
function makeMockEngine() {
  const listeners = new Set<(pos: ReadingPosition) => void>();
  const engine = {
    format: 'txt' as const,
    mount: vi.fn(),
    unmount: vi.fn(),
    loadChapter: vi.fn(),
    getPageCount: vi.fn(() => 10),
    getCurrentPage: vi.fn(() => 0),
    goToPage: vi.fn(),
    nextPage: vi.fn(() => true),
    prevPage: vi.fn(() => false),
    scrollToRatio: vi.fn(),
    getScrollRatio: vi.fn(() => 0),
    getVisibleText: vi.fn(() => ''),
    getFullChapterText: vi.fn(() => Promise.resolve('')),
    onPositionChange: vi.fn((cb: (pos: ReadingPosition) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    onChapterBoundary: vi.fn(() => () => {}),
  } satisfies ReaderEngine;

  return {
    engine,
    /** 模拟引擎发出位置变化 */
    emit(pos: ReadingPosition) {
      listeners.forEach((cb) => cb(pos));
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

// ── 测试 ─────────────────────────────────────────────────

describe('useReadingPosition', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('初始位置为 null', () => {
    const { result } = renderHook(() => useReadingPosition(null));
    expect(result.current.position).toBeNull();
    expect(result.current.getPosition()).toBeNull();
  });

  it('setPosition 设置完整位置并自动生成 timestamp', () => {
    const { result } = renderHook(() => useReadingPosition(null));

    const before = Date.now();
    act(() => {
      result.current.setPosition({
        bookId: 'b1',
        chapterId: 'c1',
        chapterIndex: 0,
        ratio: 0.5,
        page: 3,
        pageCount: 10,
      });
    });

    const pos = result.current.position!;
    expect(pos.bookId).toBe('b1');
    expect(pos.chapterId).toBe('c1');
    expect(pos.ratio).toBe(0.5);
    expect(pos.page).toBe(3);
    expect(pos.pageCount).toBe(10);
    expect(pos.timestamp).toBeGreaterThanOrEqual(before);
  });

  it('setPosition 保留显式传入的 timestamp', () => {
    const { result } = renderHook(() => useReadingPosition(null));

    act(() => {
      result.current.setPosition({
        bookId: 'b1',
        chapterId: 'c1',
        chapterIndex: 0,
        ratio: 0,
        timestamp: 9999,
      });
    });

    expect(result.current.position!.timestamp).toBe(9999);
  });

  it('updatePosition 部分合并到已有位置', () => {
    const { result } = renderHook(() => useReadingPosition(null));

    act(() => {
      result.current.setPosition(makePosition({ page: 0, pageCount: 20 }));
    });

    act(() => {
      result.current.updatePosition({ page: 5, ratio: 0.25 });
    });

    const pos = result.current.position!;
    expect(pos.page).toBe(5);
    expect(pos.ratio).toBe(0.25);
    // 未更新的字段保持不变
    expect(pos.bookId).toBe('book-1');
    expect(pos.pageCount).toBe(20);
  });

  it('updatePosition 在无已有位置时静默忽略', () => {
    const { result } = renderHook(() => useReadingPosition(null));

    act(() => {
      result.current.updatePosition({ page: 5 });
    });

    expect(result.current.position).toBeNull();
  });

  it('getPosition 返回最新位置（命令式读取）', () => {
    const { result } = renderHook(() => useReadingPosition(null));

    act(() => {
      result.current.setPosition(makePosition({ ratio: 0.8 }));
    });

    expect(result.current.getPosition()!.ratio).toBe(0.8);
  });

  // ── 引擎订阅 ─────────────────────────────────────────

  it('订阅引擎 onPositionChange 并同步位置', () => {
    const mock = makeMockEngine();
    const { result } = renderHook(() => useReadingPosition(mock.engine));

    expect(mock.engine.onPositionChange).toHaveBeenCalledTimes(1);

    const enginePos = makePosition({ chapterId: 'ch-5', ratio: 0.6, timestamp: 2000 });
    act(() => mock.emit(enginePos));

    expect(result.current.position).toEqual(enginePos);
    expect(result.current.getPosition()).toEqual(enginePos);
  });

  it('引擎切换时取消旧订阅、建立新订阅', () => {
    const mock1 = makeMockEngine();
    const mock2 = makeMockEngine();

    const { result, rerender } = renderHook(
      ({ engine }) => useReadingPosition(engine),
      { initialProps: { engine: mock1.engine as ReaderEngine | null } },
    );

    expect(mock1.listenerCount).toBe(1);

    // 切换到新引擎
    rerender({ engine: mock2.engine });
    expect(mock1.listenerCount).toBe(0); // 旧订阅已清理
    expect(mock2.listenerCount).toBe(1); // 新订阅已建立

    // 旧引擎事件不再影响
    act(() => mock1.emit(makePosition({ chapterId: 'old' })));
    expect(result.current.position).toBeNull();

    // 新引擎事件正常同步
    const newPos = makePosition({ chapterId: 'new', timestamp: 3000 });
    act(() => mock2.emit(newPos));
    expect(result.current.position).toEqual(newPos);
  });

  it('引擎为 null 时不订阅', () => {
    const mock = makeMockEngine();
    renderHook(() => useReadingPosition(null));
    expect(mock.engine.onPositionChange).not.toHaveBeenCalled();
  });

  it('卸载时取消引擎订阅', () => {
    const mock = makeMockEngine();
    const { unmount } = renderHook(() => useReadingPosition(mock.engine));

    expect(mock.listenerCount).toBe(1);
    unmount();
    expect(mock.listenerCount).toBe(0);
  });
});
