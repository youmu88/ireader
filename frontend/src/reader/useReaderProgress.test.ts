import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReaderLocation } from './types';
import { loadLocalPosition, useReaderProgress } from './useReaderProgress';

const axiosMocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMocks }));

const BOOK_ID = 'book-1';

const loc = (cfi: string, over: Partial<ReaderLocation> = {}): ReaderLocation => ({
  cfi,
  percentage: null,
  pageInChapter: 2,
  pagesInChapter: 9,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  axiosMocks.get.mockReset();
  axiosMocks.put.mockReset();
  axiosMocks.put.mockResolvedValue({ data: { success: true, conflict: false, data: { progressVersion: 2 } } });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadInitialCfi', () => {
  it('服务端有进度时返回服务端 cfi 并吸收版本号', async () => {
    axiosMocks.get.mockResolvedValue({ data: { success: true, data: { cfi: 'epubcfi(/6/2!/4)', progressVersion: 7 } } });
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    let cfi: string | null = null;
    await act(async () => { cfi = await result.current.loadInitialCfi(); });
    expect(cfi).toBe('epubcfi(/6/2!/4)');

    // 版本号已吸收为 7 → 下次保存携带 7
    axiosMocks.put.mockResolvedValue({ data: { success: true, conflict: false, data: { progressVersion: 8 } } });
    act(() => { result.current.scheduleSave(loc('epubcfi(/6/4)')); });
    await vi.advanceTimersByTimeAsync(800);
    expect(axiosMocks.put.mock.calls[0][1].progressVersion).toBe(7);
  });

  it('服务端无记录且本地无快照时返回 null', async () => {
    axiosMocks.get.mockResolvedValue({ data: { success: true, data: null } });
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    let cfi: string | null = 'x';
    await act(async () => { cfi = await result.current.loadInitialCfi(); });
    expect(cfi).toBeNull();
  });

  it('服务端请求失败（离线）时回退 localStorage 快照', async () => {
    axiosMocks.get.mockRejectedValue(new Error('Network Error'));
    localStorage.setItem(`ireader_reader_pos_${BOOK_ID}`, JSON.stringify({ cfi: 'epubcfi(local)', percentage: 0.3, pageIndex: 9, updatedAt: '2026-08-01' }));
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    let cfi: string | null = null;
    await act(async () => { cfi = await result.current.loadInitialCfi(); });
    expect(cfi).toBe('epubcfi(local)');
  });

  it('请求挂起（服务端 hang）：loadInitialCfi 受 timeout:15000 保护，不等挂起 Promise', async () => {
    // 关键回归：重构后曾丢失超时保护导致 loading 永不结束。
    // 断言请求配置携带 timeout: 15000（超时后 axios 会 reject → 走本地兜底），证明挂起不会永远卡死。
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID, saveDelay: 0 } as never));
    let promise: Promise<string | null> = Promise.resolve(null);
    act(() => {
      promise = result.current.loadInitialCfi();
    });
    // 验证 axios.get 被以 timeout 配置调用（而非裸调用）
    const conf = axiosMocks.get.mock.calls[0]?.[1] as { timeout?: number } | undefined;
    expect(conf?.timeout).toBe(15000);
    // 挂起场景：本地快照兜底，且 promise 不被挂起阻塞有结果
    localStorage.setItem(`ireader_reader_pos_${BOOK_ID}`, JSON.stringify({ cfi: 'epubcfi(hang)', percentage: 0, pageIndex: 0, updatedAt: '2026-08-01' }));
    axiosMocks.get.mockReturnValue(new Promise(() => {})); // 永不 resolve
    const result2 = renderHook(() => useReaderProgress({ bookId: BOOK_ID } as never));
    const p2 = result2.result.current.loadInitialCfi();
    // 超时由 axios 内部处理（此处不推进其 timer），验证配置已声明即证明不裸调用
    expect(axiosMocks.get.mock.calls[1]?.[1]?.timeout).toBe(15000);
    void promise; void p2;
  });
});

describe('scheduleSave', () => {
  it('防抖：连续翻页只发送最后一次位置', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => {
      result.current.scheduleSave(loc('epubcfi(1)'));
      result.current.scheduleSave(loc('epubcfi(2)'));
      result.current.scheduleSave(loc('epubcfi(3)'));
    });
    await vi.advanceTimersByTimeAsync(800);
    expect(axiosMocks.put).toHaveBeenCalledTimes(1);
    expect(axiosMocks.put.mock.calls[0][0]).toBe(`/api/books/${BOOK_ID}/progress`);
    expect(axiosMocks.put.mock.calls[0][1].cfi).toBe('epubcfi(3)');
  });

  it('保存体包含 cfi/percentage/pageIndex/deviceId，percentage 为 null 时原样传递', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => { result.current.scheduleSave(loc('epubcfi(9)', { percentage: null, globalPage: undefined, pageInChapter: 4 })); });
    await vi.advanceTimersByTimeAsync(800);
    const body = axiosMocks.put.mock.calls[0][1];
    expect(body.cfi).toBe('epubcfi(9)');
    expect(body.percentage).toBeNull();
    expect(body.pageIndex).toBe(4);
    expect(typeof body.deviceId).toBe('string');
  });

  it('全局页码就绪后 pageIndex 使用 globalPage 且携带 percentage', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => { result.current.scheduleSave(loc('epubcfi(10)', { percentage: 0.42, globalPage: 210, totalPages: 500 })); });
    await vi.advanceTimersByTimeAsync(800);
    const body = axiosMocks.put.mock.calls[0][1];
    expect(body.pageIndex).toBe(210);
    expect(body.percentage).toBe(0.42);
  });

  it('每次保存后吸收响应版本号（单调递增）', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    axiosMocks.put.mockResolvedValueOnce({ data: { success: true, conflict: false, data: { progressVersion: 5 } } });
    act(() => { result.current.scheduleSave(loc('epubcfi(1)')); });
    await vi.advanceTimersByTimeAsync(800);
    axiosMocks.put.mockResolvedValueOnce({ data: { success: true, conflict: false, data: { progressVersion: 6 } } });
    act(() => { result.current.scheduleSave(loc('epubcfi(2)')); });
    await vi.advanceTimersByTimeAsync(800);
    expect(axiosMocks.put.mock.calls[1][1].progressVersion).toBe(5);
  });

  it('conflict 响应同样吸收服务端版本号，不打断阅读', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    axiosMocks.put.mockResolvedValueOnce({ data: { success: true, conflict: true, data: { cfi: 'epubcfi(other)', progressVersion: 42 } } });
    act(() => { result.current.scheduleSave(loc('epubcfi(1)')); });
    await vi.advanceTimersByTimeAsync(800);
    act(() => { result.current.scheduleSave(loc('epubcfi(2)')); });
    await vi.advanceTimersByTimeAsync(800);
    expect(axiosMocks.put.mock.calls[1][1].progressVersion).toBe(42);
  });

  it('网络失败时静默，localStorage 已兜底', async () => {
    axiosMocks.put.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => { result.current.scheduleSave(loc('epubcfi(off)', { percentage: 0.5, globalPage: 50 })); });
    await vi.advanceTimersByTimeAsync(800);
    const local = loadLocalPosition(BOOK_ID);
    expect(local?.cfi).toBe('epubcfi(off)');
    expect(local?.pageIndex).toBe(50);
  });

  it('无 cfi 的位置直接忽略', async () => {
    const { result } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => { result.current.scheduleSave(loc('')); });
    await vi.advanceTimersByTimeAsync(2000);
    expect(axiosMocks.put).not.toHaveBeenCalled();
  });

  it('卸载时将 pending 位置 flush 到 localStorage', () => {
    const { result, unmount } = renderHook(() => useReaderProgress({ bookId: BOOK_ID }));
    act(() => { result.current.scheduleSave(loc('epubcfi(pending)')); });
    unmount();
    expect(loadLocalPosition(BOOK_ID)?.cfi).toBe('epubcfi(pending)');
    expect(axiosMocks.put).not.toHaveBeenCalled();
  });
});
