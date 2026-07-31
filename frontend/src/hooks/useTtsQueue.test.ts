import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import axios from 'axios';
import { useTtsQueue } from './useTtsQueue';

vi.mock('axios');
const mockedAxios = axios as any;

const job = (id: string, status = 'pending') => ({
  id, bookId: id, bookTitle: id, voice: 'x', speed: 1, status,
  progress: 0, totalChunks: 10, completedChunks: 0, error: null,
  createdAt: '', updatedAt: '',
});

describe('useTtsQueue 共享 TTS 队列 hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.get.mockResolvedValue({
      data: { success: true, data: [job('j1', 'running'), job('j2', 'completed')] },
    });
    mockedAxios.delete.mockResolvedValue({ data: { success: true } });
    mockedAxios.post.mockResolvedValue({ data: { success: true } });
  });

  it('fetches jobs and stores them', async () => {
    const { result } = renderHook(() => useTtsQueue({ poll: false }));
    expect(result.current.ttsJobs).toEqual([]);
    await act(async () => { await result.current.fetchTTSJobs(); });
    expect(result.current.ttsJobs.map(j => j.id)).toEqual(['j1', 'j2']);
  });

  it('toggles job selection', async () => {
    const { result } = renderHook(() => useTtsQueue({ poll: false }));
    await act(async () => { await result.current.fetchTTSJobs(); });
    act(() => result.current.toggleJobSelection('j1'));
    expect(result.current.selectedJobIds.has('j1')).toBe(true);
    act(() => result.current.toggleJobSelection('j1'));
    expect(result.current.selectedJobIds.has('j1')).toBe(false);
  });

  it('selects and deselects all jobs', async () => {
    const { result } = renderHook(() => useTtsQueue({ poll: false }));
    await act(async () => { await result.current.fetchTTSJobs(); });
    act(() => result.current.selectAllJobs());
    expect(result.current.selectedJobIds.size).toBe(2);
    act(() => result.current.deselectAllJobs());
    expect(result.current.selectedJobIds.size).toBe(0);
  });

  it('cancels a single job via delete', async () => {
    const { result } = renderHook(() => useTtsQueue({ poll: false }));
    await act(async () => { await result.current.fetchTTSJobs(); });
    await act(async () => { await result.current.handleCancelJob('j1'); });
    expect(mockedAxios.delete).toHaveBeenCalledWith('/api/tts/jobs/j1');
  });

  it('reports active job count', async () => {
    const { result } = renderHook(() => useTtsQueue({ poll: false }));
    await act(async () => { await result.current.fetchTTSJobs(); });
    expect(result.current.activeCount).toBe(1);
  });

  it('starts polling when poll enabled and there are active jobs', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTtsQueue({ poll: true, interval: 3000 }));
    await act(async () => { mockedAxios.get.mockResolvedValue({ data: { success: true, data: [job('j1', 'running')] } }); });
    // 首次 fetch
    await act(async () => { await result.current.fetchTTSJobs(); });
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(mockedAxios.get.mock.calls.length).toBeGreaterThan(1);
    vi.useRealTimers();
  });
});
