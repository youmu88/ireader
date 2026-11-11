/**
 * TtsScheduler 单测（Phase 2）：段音频解析（缓存优先/合成兑底/重试/跳过）与章节映射
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSegmentAudio, buildChapterList, findStartChapterIndex, findStartByAnchorRatio } from './ttsScheduler';
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

describe('findStartChapterIndex — 合辑 EPUB 占比定位（多章共文件 fragment 目录，relocated 只给文件级 href）', () => {
  // 百妖谱型结构：前几章独立文件，正文各章共写 index.html、目录靠 fragment 区分；
  // relocated start.href = 'index.html'（无 fragment），href 匹配永远只能命中第一条 index.html 目录（书名页）
  const list = buildChapterList(
    [
      { id: 'c1', title: '封面', href: 'cover.xhtml', start_offset: 0, end_offset: 100 },
      { id: 'c2', title: '书名页', href: 'titlepage.xhtml', start_offset: 100, end_offset: 200 },
      { id: 'c3', title: '卷一', href: 'index.html#toc_1', start_offset: 200, end_offset: 400 },
      { id: 'c4', title: '第一章 灰狐', href: 'index.html#toc_2', start_offset: 400, end_offset: 800 },
      { id: 'c5', title: '第二章', href: 'index.html#toc_3', start_offset: 800, end_offset: 1200 },
      { id: 'c6', title: '第三章', href: 'index.html#toc_4', start_offset: 1200, end_offset: 1600 },
    ],
    'epub',
  );

  it('读正文后半章（占比 0.6）→ 落到占比覆盖该位置的最后一章（c5）', () => {
    expect(findStartChapterIndex(list, 'index.html', 0.6)).toBe(4);
  });

  it('读开头（占比 0.15，已越过卷一起点 0.125）→ 落卷一（c3）', () => {
    expect(findStartChapterIndex(list, 'titlepage.xhtml', 0.15)).toBe(2);
  });

  it('读末尾（占比 0.95）→ 最后一章（c6）', () => {
    expect(findStartChapterIndex(list, 'index.html', 0.95)).toBe(5);
  });

  it('章首附近阅读百分比略小于章占比（0.499）→ 容差内仍落该章（c4 起始 0.25？否，此处验 EPS）', () => {
    // c4.startRatio = 400/1600 = 0.25；阅读 0.249（略小于 0.25）→ EPS=0.005 内仍落 c4
    expect(findStartChapterIndex(list, 'index.html', 0.249)).toBe(3);
  });

  it('无占比（null）→ 回退 href 匹配（命中共文件的第一个条目=旧行为）', () => {
    expect(findStartChapterIndex(list, 'index.html', null)).toBe(2);
  });

  it('章节无 offset 元数据 → startRatio 缺省 → 回退 href 匹配', () => {
    const noOffset = buildChapterList(
      [
        { id: 'c1', title: 'A', href: 'index.html' },
        { id: 'c2', title: 'B', href: 'index.html#toc_1' },
      ],
      'epub',
    );
    expect(noOffset[0].startRatio).toBeUndefined();
    expect(findStartChapterIndex(noOffset, 'index.html', 0.9)).toBe(0);
  });

  it('无 offset 但有字长（EPUB text_length）→ 字长累计占比定位合辄多章共文件', () => {
    // 百妖谱型：合辄条目占大头，正文章靠 fragment 区分；字长累计后读灰狐(2)中段（pct≈0.6）应落灰狐(2)
    const list2 = buildChapterList(
      [
        { id: 'c1', title: '封面', href: 'cover.xhtml', text_length: 100 },
        { id: 'c2', title: '书名页', href: 'titlepage.xhtml', text_length: 100 },
        { id: 'c3', title: '灰狐(1)', href: 'index.html#toc_1', text_length: 400 },
        { id: 'c4', title: '灰狐(2)', href: 'index.html#toc_2', text_length: 300 },
        { id: 'c5', title: '灰狐(3)', href: 'index.html#toc_3', text_length: 200 },
      ],
      'epub',
    );
    // 累计：c1=0, c2=0.091, c3=0.182, c4=0.545, c5=0.818（总长 1000）
    expect(list2[3].startRatio).toBeCloseTo(0.545, 2);
    expect(findStartChapterIndex(list2, 'index.html', 0.6)).toBe(3); // 灰狐(2)
    expect(findStartChapterIndex(list2, 'index.html', 0.3)).toBe(2); // 灰狐(1)
    expect(findStartChapterIndex(list2, 'index.html', 0.9)).toBe(4); // 灰狐(3)
  });
});

describe('findStartByAnchorRatio — 合辄书渲染文档内锚点像素占比定位（同源同基准，根治字长失真）', () => {
  // 百妖谱型：合辄条目占 89 万字导致字长累计占比全部挤到尾部（启发式失效），
  // 但渲染文档内锚点元素位置是真实几何：toc_2 在文档 30% 处、toc_3 在 60% 处、toc_4 在 85% 处
  const list = buildChapterList(
    [
      { id: 'c1', title: '封面', href: 'cover.xhtml', start_offset: 0, end_offset: 100 },
      { id: 'c2', title: '书名页', href: 'titlepage.xhtml', start_offset: 100, end_offset: 200 },
      { id: 'c3', title: '合辄', href: 'index.html', start_offset: 200, end_offset: 900000 },
      { id: 'c4', title: '灰狐(1)', href: 'index.html#toc_2', text_length: 5789 },
      { id: 'c5', title: '灰狐(2)', href: 'index.html#toc_3', text_length: 1837 },
      { id: 'c6', title: '灰狐(3)', href: 'index.html#toc_4', text_length: 2200 },
    ],
    'epub',
  );
  const ratios = {
    'cover.xhtml': null,
    'titlepage.xhtml': null,
    'index.html': null,
    'index.html#toc_2': 0.3,
    'index.html#toc_3': 0.6,
    'index.html#toc_4': 0.85,
  };

  it('视口在文档 40% → 覆盖锚点 toc_2（灰狐(1)，全局 index 3）', () => {
    expect(findStartByAnchorRatio(list, ratios, 0.4)).toBe(3);
  });

  it('视口在文档 70% → 覆盖锚点 toc_3（灰狐(2)，全局 index 4）', () => {
    expect(findStartByAnchorRatio(list, ratios, 0.7)).toBe(4);
  });

  it('视口在文档 90% → 覆盖锚点 toc_4（灰狐(3)，全局 index 5）', () => {
    expect(findStartByAnchorRatio(list, ratios, 0.9)).toBe(5);
  });

  it('视口在第一个锚点之前（5%）→ 无覆盖锚点返回 -1（调用方回退 href 匹配落合辄条目）', () => {
    expect(findStartByAnchorRatio(list, ratios, 0.05)).toBe(-1);
  });

  it('视口占比非法（>1）→ 返回 -1 调用方回退', () => {
    expect(findStartByAnchorRatio(list, ratios, 1.5)).toBe(-1);
  });

  it('锚点占比全 null（渲染文档无锚点可解析）→ 返回 -1 回退', () => {
    expect(findStartByAnchorRatio(list, { 'index.html#toc_2': null, 'index.html#toc_3': null }, 0.5)).toBe(-1);
  });
});
