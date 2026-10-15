/**
 * TtsScheduler 单测（Phase 2）：段音频解析（缓存优先/合成兑底/重试/跳过）与章节映射
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSegmentAudio, buildChapterList, findStartChapterIndex } from './ttsScheduler';
import * as ttsApi from './ttsApi';

vi.mock('./ttsApi', () => ({
  fetchAudioBlob: vi.fn(),
  synthesizeSegment: vi.fn(),
  TTS_SOURCE: 'openai',
}));

const mockedFetchAudio = vi.mocked(ttsApi.fetchAudioBlob);
const mockedSynth = vi.mocked(ttsApi.synthesizeSegment);

const seg = { segmentIndex: 0, text: '第一段文本', textHash: 'v2_abc' };
const baseOpts = {
  cacheMap: new Map<string, string>(),
  voice: 'alloy',
  speed: 1.0,
  bookId: 'book-1',
  chapterId: 'ch-1',
  noCache: false,
};

beforeEach(() => {
  mockedFetchAudio.mockReset();
  mockedSynth.mockReset();
});

describe('resolveSegmentAudio', () => {
  it('缓存命中直接下载，不调合成', async () => {
    const blob = new Blob(['audio']);
    mockedFetchAudio.mockResolvedValueOnce(blob);
    const result = await resolveSegmentAudio(seg, { ...baseOpts, cacheMap: new Map([['v2_abc', '/api/tts/cache-file/x']]) });
    expect(result).toBe(blob);
    expect(mockedFetchAudio).toHaveBeenCalledWith('/api/tts/cache-file/x');
    expect(mockedSynth).not.toHaveBeenCalled();
  });

  it('miss 时走实时合成', async () => {
    const blob = new Blob(['tts']);
    mockedSynth.mockResolvedValueOnce(blob);
    const result = await resolveSegmentAudio(seg, baseOpts);
    expect(result).toBe(blob);
    expect(mockedSynth).toHaveBeenCalledTimes(1);
    expect(mockedSynth).toHaveBeenCalledWith(expect.objectContaining({ input: '第一段文本', voice: 'alloy', bookId: 'book-1', chapterId: 'ch-1' }));
  });

  it('合成失败自动重试 1 次后成功', async () => {
    mockedSynth.mockRejectedValueOnce(new Error('502')).mockResolvedValueOnce(new Blob(['ok']));
    const result = await resolveSegmentAudio(seg, baseOpts);
    expect(result).not.toBeNull();
    expect(mockedSynth).toHaveBeenCalledTimes(2);
  });

  it('重试后仍失败返回 null（跳段不中断）', async () => {
    mockedSynth.mockRejectedValue(new Error('down'));
    const result = await resolveSegmentAudio(seg, baseOpts);
    expect(result).toBeNull();
    expect(mockedSynth).toHaveBeenCalledTimes(2);
  });

  it('缓存下载失败落实时合成兜底', async () => {
    mockedFetchAudio.mockRejectedValueOnce(new Error('404'));
    mockedSynth.mockResolvedValueOnce(new Blob(['fallback']));
    const result = await resolveSegmentAudio(seg, { ...baseOpts, cacheMap: new Map([['v2_abc', '/api/tts/cache-file/gone']]) });
    expect(result).not.toBeNull();
    expect(mockedSynth).toHaveBeenCalledTimes(1);
  });
});

describe('buildChapterList', () => {
  const chapters = [
    { id: 'c1', title: '第一章', href: 'part1.xhtml' },
    { id: 'c2', title: '', href: null },
  ];

  it('TXT：displayHref 按 buildTxtFeed 的 txt-{i}.xhtml 规则', () => {
    const list = buildChapterList(chapters, 'txt');
    expect(list[0]).toEqual({ chapterId: 'c1', title: '第一章', displayHref: 'txt-0.xhtml' });
    expect(list[1].displayHref).toBe('txt-1.xhtml');
    expect(list[1].title).toBe('第 2 章');
  });

  it('EPUB：displayHref 用后端 href，空 href 退化为空串', () => {
    const list = buildChapterList(chapters, 'epub');
    expect(list[0].displayHref).toBe('part1.xhtml');
    expect(list[1].displayHref).toBe('');
  });
});

describe('findStartChapterIndex', () => {
  const list = buildChapterList(
    [
      { id: 'c1', title: 'A', href: 'text/part1.xhtml' },
      { id: 'c2', title: 'B', href: 'text/part2.xhtml' },
      { id: 'c3', title: 'C', href: 'text/part3.xhtml' },
    ],
    'epub',
  );

  it('精确匹配 displayHref（含 fragment 归一化）', () => {
    expect(findStartChapterIndex(list, 'text/part2.xhtml#frag')).toBe(1);
  });

  it('basename 退化匹配（目录前缀差异）', () => {
    expect(findStartChapterIndex(list, 'part3.xhtml')).toBe(2);
  });

  it('找不到返回 0（从第一章播）', () => {
    expect(findStartChapterIndex(list, 'unknown.xhtml')).toBe(0);
    expect(findStartChapterIndex(list, null)).toBe(0);
  });
});
