import { describe, expect, it, vi } from 'vitest';
import { makeExcerpt, searchBook, type SearchableBook, type SearchableSpineItem } from './searchBook';

/** 用 jsdom 真实 DOM 构造 spine item（搜索算法可真实运行，仅 cfiFromRange 打桩） */
const makeItem = (href: string, html: string): SearchableSpineItem => {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  return {
    href,
    load: () => Promise.resolve(doc),
    cfiFromRange: (range: Range) => `cfi(${href}#${range.startOffset})`,
    unload: vi.fn(),
  };
};

const makeBook = (items: SearchableSpineItem[]): SearchableBook => ({
  load: vi.fn(),
  spine: { spineItems: items },
});

describe('makeExcerpt', () => {
  it('截取上下文并压缩空白，两侧越界加省略号', () => {
    const text = `${'a'.repeat(100)}目标词${'b'.repeat(100)}`;
    const excerpt = makeExcerpt(text, 100, 3, 10);
    expect(excerpt).toContain('目标词');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThan(text.length);
  });

  it('开头命中不加前省略号，结尾命中不加后省略号', () => {
    expect(makeExcerpt('关键词开头后面有内容', 0, 3, 5).startsWith('…')).toBe(false);
    expect(makeExcerpt('前面有内容结尾是关键词', 8, 3, 10).endsWith('…')).toBe(false);
  });

  it('连续空白压缩为单空格', () => {
    expect(makeExcerpt('你好，   世界', 3, 1, 6)).not.toMatch(/ {2}/);
  });
});

describe('searchBook', () => {
  it('跨章命中：返回 cfi/excerpt/chapterHref，大小写不敏感', async () => {
    const book = makeBook([
      makeItem('ch1.xhtml', '<p>Hello World，你好世界</p>'),
      makeItem('ch2.xhtml', '<p>另一个 hello 在这里</p>'),
    ]);
    const results = await searchBook(book, 'HELLO');
    expect(results).toHaveLength(2);
    expect(results[0].chapterHref).toBe('ch1.xhtml');
    expect(results[0].cfi).toContain('ch1.xhtml');
    expect(results[0].excerpt).toContain('Hello');
    expect(results[1].chapterHref).toBe('ch2.xhtml');
  });

  it('同章多处命中逐条返回', async () => {
    const book = makeBook([makeItem('ch1.xhtml', '<p>苹果和苹果树，都是苹果</p>')]);
    const results = await searchBook(book, '苹果');
    expect(results).toHaveLength(3);
  });

  it('无命中返回空数组；空白 query 短路不加载章节', async () => {
    const item = makeItem('ch1.xhtml', '<p>内容</p>');
    const loadSpy = vi.spyOn(item, 'load');
    const book = makeBook([item]);
    expect(await searchBook(book, '不存在')).toEqual([]);
    expect(await searchBook(book, '   ')).toEqual([]);
    expect(loadSpy).toHaveBeenCalledTimes(1); // 仅“不存在”那次加载
  });

  it('limit 截断结果', async () => {
    const book = makeBook([makeItem('ch1.xhtml', '<p>词 词 词 词 词</p>')]);
    const results = await searchBook(book, '词', { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('单章加载失败不中断后续章节搜索', async () => {
    const bad: SearchableSpineItem = {
      href: 'bad.xhtml',
      load: () => Promise.reject(new Error('io')),
      cfiFromRange: () => '',
      unload: vi.fn(),
    };
    const book = makeBook([bad, makeItem('good.xhtml', '<p>目标</p>')]);
    const results = await searchBook(book, '目标');
    expect(results).toHaveLength(1);
    expect(results[0].chapterHref).toBe('good.xhtml');
  });

  it('每章搜索后 unload 释放；onProgress 回报进度', async () => {
    const items = [makeItem('ch1.xhtml', '<p>一</p>'), makeItem('ch2.xhtml', '<p>二</p>')];
    const onProgress = vi.fn();
    await searchBook(makeBook(items), '无', { onProgress });
    expect(items[0].unload).toHaveBeenCalled();
    expect(items[1].unload).toHaveBeenCalled();
    expect(onProgress).toHaveBeenLastCalledWith(2, 2);
  });
});
