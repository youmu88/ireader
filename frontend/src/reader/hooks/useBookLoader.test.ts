import { act, renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBookLoader } from './useBookLoader';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

describe('useBookLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bookId 为空时不加载', () => {
    const { result } = renderHook(() => useBookLoader({ bookId: undefined }));
    expect(result.current.loading).toBe(false);
    expect(result.current.book).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('加载书籍元数据和章节列表', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { id: 'b1', title: '测试书', format: 'txt' } } })
      .mockResolvedValueOnce({ data: { data: [{ id: 'c1', title: '第一章', order: 0 }] } });

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.book?.title).toBe('测试书');
    expect(result.current.chapters).toHaveLength(1);
    expect(result.current.chapters[0].title).toBe('第一章');
  });

  it('加载失败设置 error', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('Network Error'));

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Network Error');
  });

  it('reload 触发重新加载', async () => {
    vi.mocked(axios.get)
      .mockResolvedValue({ data: { data: { id: 'b1', title: '书', format: 'txt' } } });

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const callCount = vi.mocked(axios.get).mock.calls.length;
    act(() => { result.current.reload(); });
    await waitFor(() => expect(vi.mocked(axios.get).mock.calls.length).toBeGreaterThan(callCount));
  });

  it('loadChapterContent 返回章节文本', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { id: 'b1', title: '书', format: 'txt' } } })
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { data: { content: '你好世界' } } });

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const text = await result.current.loadChapterContent({ id: 'c1', title: '第一章', order: 0 });
    expect(text).toBe('你好世界');
  });

  it('loadChapterContent 失败返回空字符串', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { id: 'b1', title: '书', format: 'txt' } } })
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockRejectedValueOnce(new Error('fail'));

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const text = await result.current.loadChapterContent({ id: 'c1', title: '第一章', order: 0 });
    expect(text).toBe('');
  });

  it('getChapterText 委托给 loadChapterContent', async () => {
    vi.mocked(axios.get)
      .mockResolvedValueOnce({ data: { data: { id: 'b1', title: '书', format: 'txt' } } })
      .mockResolvedValueOnce({ data: { data: [] } })
      .mockResolvedValueOnce({ data: { data: { content: '文本' } } });

    const { result } = renderHook(() => useBookLoader({ bookId: 'b1' }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const text = await result.current.getChapterText({ id: 'c1', title: '第一章', order: 0 });
    expect(text).toBe('文本');
  });
});
