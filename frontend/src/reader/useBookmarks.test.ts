import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReaderLocation } from './types';
import { loadBookmarks, useBookmarks } from './useBookmarks';

const BOOK_ID = 'book-bm';
const KEY = `ireader_bookmarks_${BOOK_ID}`;

const loc = (cfi: string, over: Partial<ReaderLocation> = {}): ReaderLocation => ({
  cfi,
  percentage: null,
  pageInChapter: 1,
  pagesInChapter: 10,
  ...over,
});

afterEach(() => {
  localStorage.clear();
});

describe('loadBookmarks', () => {
  it('无存储时返回空数组', () => {
    expect(loadBookmarks(BOOK_ID)).toEqual([]);
  });

  it('JSON 损坏时返回空数组', () => {
    localStorage.setItem(KEY, '{broken');
    expect(loadBookmarks(BOOK_ID)).toEqual([]);
  });

  it('过滤掉缺少 cfi 的脏数据', () => {
    localStorage.setItem(KEY, JSON.stringify([
      { id: '1', cfi: 'epubcfi(a)', excerpt: 'x', createdAt: '2026-08-01' },
      { id: '2', excerpt: 'no cfi' },
    ]));
    const items = loadBookmarks(BOOK_ID);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('1');
  });
});

describe('useBookmarks toggle', () => {
  it('添加书签：字段完整、置顶、持久化', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    let r: unknown;
    act(() => {
      r = result.current.toggle(loc('epubcfi(/6/4!/2/1:10)', { chapterHref: 'ch1.xhtml', globalPage: 12 }), '摘要文本');
    });
    expect(r).toBe('added');
    expect(result.current.bookmarks).toHaveLength(1);
    const b = result.current.bookmarks[0];
    expect(b.cfi).toBe('epubcfi(/6/4!/2/1:10)');
    expect(b.excerpt).toBe('摘要文本');
    expect(b.chapterHref).toBe('ch1.xhtml');
    expect(b.globalPage).toBe(12);
    expect(typeof b.id).toBe('string');
    expect(typeof b.createdAt).toBe('string');
    // 持久化
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0].cfi).toBe(b.cfi);
  });

  it('同 CFI 再次 toggle：移除书签', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    act(() => { result.current.toggle(loc('epubcfi(a)')); });
    let r: unknown;
    act(() => { r = result.current.toggle(loc('epubcfi(a)')); });
    expect(r).toBe('removed');
    expect(result.current.bookmarks).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(0);
  });

  it('不同 CFI 各自独立；新书签排在最前', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    act(() => { result.current.toggle(loc('epubcfi(1)')); });
    act(() => { result.current.toggle(loc('epubcfi(2)')); });
    expect(result.current.bookmarks.map(b => b.cfi)).toEqual(['epubcfi(2)', 'epubcfi(1)']);
  });

  it('无 CFI 时返回 null 且不操作', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    let r: unknown;
    act(() => { r = result.current.toggle(loc('')); });
    expect(r).toBeNull();
    expect(result.current.bookmarks).toHaveLength(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('useBookmarks isBookmarked / remove', () => {
  it('isBookmarked 按 CFI 匹配，空 CFI 恒 false', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    expect(result.current.isBookmarked('epubcfi(a)')).toBe(false);
    expect(result.current.isBookmarked(undefined)).toBe(false);
    act(() => { result.current.toggle(loc('epubcfi(a)')); });
    expect(result.current.isBookmarked('epubcfi(a)')).toBe(true);
    expect(result.current.isBookmarked('epubcfi(b)')).toBe(false);
  });

  it('remove 按 id 删除并持久化', () => {
    const { result } = renderHook(() => useBookmarks(BOOK_ID));
    act(() => { result.current.toggle(loc('epubcfi(a)')); });
    act(() => { result.current.toggle(loc('epubcfi(b)')); });
    const target = result.current.bookmarks.find(b => b.cfi === 'epubcfi(a)')!;
    act(() => { result.current.remove(target.id); });
    expect(result.current.bookmarks.map(b => b.cfi)).toEqual(['epubcfi(b)']);
    expect(JSON.parse(localStorage.getItem(KEY)!).map((b: { cfi: string }) => b.cfi)).toEqual(['epubcfi(b)']);
  });
});

describe('useBookmarks 书籍切换', () => {
  it('bookId 变化时加载对应书籍的书签', () => {
    localStorage.setItem(`ireader_bookmarks_book-a`, JSON.stringify([
      { id: 'a1', cfi: 'epubcfi(a)', excerpt: '', createdAt: '2026-08-01' },
    ]));
    const { result, rerender } = renderHook(({ id }) => useBookmarks(id), {
      initialProps: { id: 'book-a' },
    });
    expect(result.current.bookmarks).toHaveLength(1);
    rerender({ id: 'book-b' });
    expect(result.current.bookmarks).toHaveLength(0);
  });
});
