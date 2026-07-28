import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTtsIntegration } from './useTtsIntegration';

// mock ttsPlayer
const mockPlayer = {
  getState: vi.fn((): string => 'idle'),
  play: vi.fn(async () => {}),
  pause: vi.fn(),
  resume: vi.fn(),
  stop: vi.fn(),
  load: vi.fn(async () => {}),
  seekTo: vi.fn(),
  setCallbacks: vi.fn(),
  setVoice: vi.fn(),
  getVoice: vi.fn(() => 'zh-CN-XiaoxiaoNeural'),
  getCurrentIndex: vi.fn(() => 0),
  getTotalChunks: vi.fn(() => 10),
  getCurrentSegmentText: vi.fn(() => 'test'),
  currentBookId: null as string | null,
  chapterTitle: '',
  chapterId: '',
};

vi.mock('../../services/ttsPlayer', () => ({
  getDefaultPlayer: vi.fn(() => mockPlayer),
}));

const defaultOpts = {
  bookId: 'book-1',
  getChapterText: vi.fn(async () => '你好世界。再见。'),
  currentChapterId: 'ch-1',
  currentChapterTitle: '第一章',
  bookTitle: '测试书',
};

describe('useTtsIntegration (Phase 6.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlayer.currentBookId = null;
    mockPlayer.getState.mockReturnValue('idle');
  });

  it('初始状态为 idle', () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    expect(result.current.ttsState).toBe('idle');
    expect(result.current.ttsProgress).toBe(0);
    expect(result.current.activeSegmentIndex).toBe(-1);
  });

  it('startTTS 加载文本并播放', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    expect(mockPlayer.load).toHaveBeenCalled();
    expect(mockPlayer.play).toHaveBeenCalled();
  });

  it('startTTS toggle: 同一本书正在播放时暂停', async () => {
    mockPlayer.getState.mockReturnValue('playing');
    mockPlayer.currentBookId = 'book-1';
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    expect(mockPlayer.pause).toHaveBeenCalled();
    expect(mockPlayer.load).not.toHaveBeenCalled();
  });

  it('stopTTS 重置状态', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    act(() => { result.current.stopTTS(); });
    expect(mockPlayer.stop).toHaveBeenCalled();
    expect(result.current.ttsState).toBe('idle');
    expect(result.current.activeSegmentIndex).toBe(-1);
  });

  it('pauseTTS/resumeTTS 委托给 player', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    vi.clearAllMocks();
    act(() => { result.current.pauseTTS(); });
    expect(mockPlayer.pause).toHaveBeenCalled();
    act(() => { result.current.resumeTTS(); });
    expect(mockPlayer.resume).toHaveBeenCalled();
  });

  it('seekTTS 委托给 player', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    mockPlayer.getState.mockReturnValue('playing');
    act(() => { result.current.seekTTS(0.5); });
    expect(mockPlayer.seekTo).toHaveBeenCalledWith(0.5);
  });

  it('seekTTS idle 时不调用', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    mockPlayer.getState.mockReturnValue('idle');
    vi.clearAllMocks();
    act(() => { result.current.seekTTS(0.5); });
    expect(mockPlayer.seekTo).not.toHaveBeenCalled();
  });

  it('setSleepTimer 设置定时', () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    act(() => { result.current.setSleepTimer(15); });
    expect(result.current.sleepTimerMinutes).toBe(15);
  });

  it('setSleepTimer(null) 清除定时', () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    act(() => { result.current.setSleepTimer(15); });
    act(() => { result.current.setSleepTimer(null); });
    expect(result.current.sleepTimerMinutes).toBeNull();
  });

  it('getPlayer 返回播放器实例（startTTS 后）', async () => {
    const { result } = renderHook(() => useTtsIntegration(defaultOpts));
    await act(async () => { await result.current.startTTS(); });
    expect(result.current.getPlayer()).toBe(mockPlayer);
  });
});
