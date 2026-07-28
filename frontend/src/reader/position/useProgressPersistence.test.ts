import { act, renderHook } from '@testing-library/react';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingPosition } from './types';
import { loadLocalPosition, useProgressPersistence } from './useProgressPersistence';

vi.mock('axios', () => ({
  default: { put: vi.fn(() => Promise.resolve({ data: { success: true } })) },
}));

// ── 工具 ─────────────────────────────────────────────────

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

const defaultOpts = { bookId: 'book-1', totalChapters: 10 };

// ── 测试 ─────────────────────────────────────────────────

describe('useProgressPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('position 变化后 800ms 触发 API 保存', async () => {
    const pos = makePos({ chapterIndex: 2, ratio: 0.5 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });

    // 800ms 前不触发
    act(() => { vi.advanceTimersByTime(799); });
    expect(axios.put).not.toHaveBeenCalled();

    // 800ms 后触发
    act(() => { vi.advanceTimersByTime(1); });
    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      chapterId: 'ch-1',
      percentage: 25, // (2 + 0.5) / 10 * 100 = 25
    }));
  });

  it('快速连续变化只保存最后一次（debounce）', () => {
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: makePos({ ratio: 0.1 }) });
    act(() => { vi.advanceTimersByTime(400); });
    rerender({ p: makePos({ ratio: 0.5 }) });
    act(() => { vi.advanceTimersByTime(400); });
    rerender({ p: makePos({ ratio: 0.9 }) });
    act(() => { vi.advanceTimersByTime(800); });

    // 只调用一次，且是最后一次的值
    expect(axios.put).toHaveBeenCalledTimes(1);
    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      percentage: 9, // (0 + 0.9) / 10 * 100 = 9
    }));
  });

  it('position 变化立即写入 localStorage', () => {
    const pos = makePos({ chapterId: 'ch-local', ratio: 0.3 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });

    const stored = loadLocalPosition();
    expect(stored).not.toBeNull();
    expect(stored!.chapterId).toBe('ch-local');
    expect(stored!.ratio).toBe(0.3);
  });

  it('flush 立即保存待处理位置', () => {
    const pos = makePos({ ratio: 0.7 });
    const { result, rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    act(() => { rerender({ p: pos }); });
    vi.mocked(axios.put).mockClear();

    // 不等 debounce，直接 flush
    act(() => { result.current.flush(); });

    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      percentage: 7,
    }));
  });

  it('bookId 为空时不保存', () => {
    const pos = makePos();
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, { bookId: undefined, totalChapters: 10 }),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(axios.put).not.toHaveBeenCalled();
  });

  it('enabled=false 时不保存', () => {
    const pos = makePos();
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, { ...defaultOpts, enabled: false }),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });
    act(() => { vi.advanceTimersByTime(1000); });

    expect(axios.put).not.toHaveBeenCalled();
  });

  it('分页模式正确计算 pageIndex', () => {
    const pos = makePos({ page: 5, pageCount: 11, ratio: 0.5 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });
    act(() => { vi.advanceTimersByTime(800); });

    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      pageIndex: 5000, // 5 / (11-1) * 10000 = 5000
    }));
  });

  it('滚动模式正确计算 pageIndex', () => {
    const pos = makePos({ scrollRatio: 0.75, ratio: 0.75 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });
    act(() => { vi.advanceTimersByTime(800); });

    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      pageIndex: 7500, // 0.75 * 10000
    }));
  });

  it('EPUB CFI 正确传递', () => {
    const pos = makePos({ cfi: '/6/4[chap01]!/4/2/1:0', ratio: 0.2 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });
    act(() => { vi.advanceTimersByTime(800); });

    expect(axios.put).toHaveBeenCalledWith('/api/books/book-1/progress', expect.objectContaining({
      cfi: '/6/4[chap01]!/4/2/1:0',
    }));
  });

  it('visibilitychange hidden 时自动 flush', () => {
    const pos = makePos({ ratio: 0.4 });
    const { rerender } = renderHook(
      ({ p }) => useProgressPersistence(p, defaultOpts),
      { initialProps: { p: null as ReadingPosition | null } },
    );

    rerender({ p: pos });

    // 模拟页面隐藏
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(axios.put).toHaveBeenCalledTimes(1);

    // 恢复
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('loadLocalPosition 返回 null 当无存储', () => {
    expect(loadLocalPosition()).toBeNull();
  });
});
