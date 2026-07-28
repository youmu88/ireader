import { renderHook } from '@testing-library/react';
import axios from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProgressRestore } from './useProgressRestore';
import type { Chapter } from '../types';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const chapters: Chapter[] = [
  { id: 'c1', title: '第一章', order: 0 },
  { id: 'c2', title: '第二章', order: 1 },
  { id: 'c3', title: '第三章', order: 2 },
];

describe('useProgressRestore', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('无进度时返回第一章', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: null } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    expect(res?.targetChapter.id).toBe('c1');
    expect(res?.restoreRatio).toBe(0);
  });

  it('有 chapterId 时精确匹配', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { chapterId: 'c2', percentage: 0.5 } } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    expect(res?.targetChapter.id).toBe('c2');
    expect(res?.restoreRatio).toBe(0.5);
  });

  it('chapterId 不匹配时按 percentage 兜底', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { chapterId: 'old-id', percentage: 0.67 } } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    // 0.67 * 3 ≈ 2 → order=2 → c3
    expect(res?.targetChapter.id).toBe('c3');
  });

  it('pageIndex 转换为 restoreRatio', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { chapterId: 'c1', pageIndex: 5000 } } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    expect(res?.restoreRatio).toBe(0.5);
  });

  it('cfi 正确传递', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { chapterId: 'c1', cfi: '/6/4' } } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    expect(res?.cfi).toBe('/6/4');
  });

  it('textOffset 映射为 ttsSegmentIndex', async () => {
    vi.mocked(axios.get).mockResolvedValue({ data: { data: { chapterId: 'c1', textOffset: 7 } } });
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, false);
    expect(res?.ttsSegmentIndex).toBe(7);
  });

  it('离线模式不请求 API', async () => {
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', chapters, true);
    expect(axios.get).not.toHaveBeenCalled();
    expect(res?.targetChapter.id).toBe('c1');
  });

  it('chapters 为空时返回 null', async () => {
    const { result } = renderHook(() => useProgressRestore());
    const res = await result.current.restore('b1', [], false);
    expect(res).toBeNull();
  });
});
