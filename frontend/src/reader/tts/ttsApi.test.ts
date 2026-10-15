/**
 * ttsApi 轻测（Phase 2）：鉴权头携带/no_cache 读取/响应解析
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchChapterSegments,
  fetchBatchCache,
  getNoCachePref,
} from './ttsApi';

const fetchMock = vi.fn();
(globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  localStorage.setItem('ireader_auth_token', 'token-1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ttsApi', () => {
  it('getNoCachePref 读取设置页开关（缺省 false）', () => {
    expect(getNoCachePref()).toBe(false);
    localStorage.setItem('ireader_tts_noCache', '1');
    expect(getNoCachePref()).toBe(true);
  });

  it('fetchChapterSegments 携带鉴权头并解析分段', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: [{ segmentIndex: 0, text: '文本', textHash: 'h' }],
    }), { status: 200 }));
    const segs = await fetchChapterSegments('b1', 'c1');
    expect(segs).toHaveLength(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(fetchMock.mock.calls[0][0]).toContain('/api/tts/book/b1/segments?chapterId=c1');
  });

  it('fetchChapterSegments 非成功抛错', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(fetchChapterSegments('b1', 'c1')).rejects.toThrow('404');
  });

  it('fetchBatchCache 聚合 textHash → audioUrl 索引', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      data: [
        { chapterId: 'c1', segmentIndex: 0, textHash: 'h1', audioUrl: '/u1' },
        { chapterId: 'c1', segmentIndex: 1, textHash: 'h2', audioUrl: '/u2' },
        { chapterId: 'c1', segmentIndex: 2, textHash: '', audioUrl: '/skip' },
      ],
    }), { status: 200 }));
    const map = await fetchBatchCache('b1', 'alloy', 1.0);
    expect(map.get('h1')).toBe('/u1');
    expect(map.get('h2')).toBe('/u2');
    expect(map.has('')).toBe(false);
    expect(fetchMock.mock.calls[0][0]).toContain('source=openai');
  });
});
