import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpubEngine } from './EpubEngine';
import type { Chapter } from '../types';
import type { ReadingPosition } from '../position/types';

// mock epubjs 动态 import
vi.mock('epubjs', () => ({
  default: vi.fn(() => ({
    ready: Promise.resolve(),
    spine: { length: 5 },
    destroy: vi.fn(),
    renderTo: vi.fn(() => ({
      display: vi.fn(() => Promise.resolve()),
      next: vi.fn(() => Promise.resolve()),
      prev: vi.fn(() => Promise.resolve()),
      destroy: vi.fn(),
      on: vi.fn(),
      flow: vi.fn(),
      themes: {
        fontSize: vi.fn(),
        font: vi.fn(),
        override: vi.fn(),
        register: vi.fn(),
        select: vi.fn(),
      },
      getContents: vi.fn(() => []),
      currentLocation: vi.fn(),
    })),
  })),
}));

vi.mock('../../services/authService', () => ({
  getToken: vi.fn(() => 'test-token'),
}));

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return { id: 'ch-1', title: '第一章', order: 0, href: '/chapter1.xhtml', ...overrides };
}

describe('EpubEngine', () => {
  let engine: EpubEngine;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    engine = new EpubEngine({
      bookId: 'book-1',
      fileUrl: '/api/books/book-1/file/',
      mode: 'paginated',
      fontSize: 18,
    });
  });

  it('format 为 epub', () => {
    expect(engine.format).toBe('epub');
  });

  it('mount 设置容器', () => {
    engine.mount(container);
    // 不抛错即通过
    expect(true).toBe(true);
  });

  it('init 前未 mount 抛错', async () => {
    await expect(engine.init()).rejects.toThrow('mount() must be called before init()');
  });

  it('init 后 getPageCount 返回 spine 长度', async () => {
    engine.mount(container);
    await engine.init();
    expect(engine.getPageCount()).toBe(5);
  });

  it('nextPage / prevPage 返回 true', async () => {
    engine.mount(container);
    await engine.init();
    expect(engine.nextPage()).toBe(true);
    expect(engine.prevPage()).toBe(true);
  });

  it('loadChapter 设置章节信息', async () => {
    engine.mount(container);
    await engine.init();
    const ch = makeChapter({ order: 2 });
    await engine.loadChapter(ch);
    expect(engine.getCurrentPage()).toBe(2);
  });

  it('onPositionChange 订阅/取消', async () => {
    engine.mount(container);
    await engine.init();
    const cb = vi.fn();
    const unsub = engine.onPositionChange(cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('onChapterBoundary 订阅/取消', () => {
    const cb = vi.fn();
    const unsub = engine.onChapterBoundary(cb);
    expect(typeof unsub).toBe('function');
    unsub();
  });

  it('getScrollRatio 初始为 0', () => {
    expect(engine.getScrollRatio()).toBe(0);
  });

  it('getVisibleText 无 rendition 返回空', () => {
    expect(engine.getVisibleText()).toBe('');
  });

  it('getFullChapterText 返回 Promise', async () => {
    const text = await engine.getFullChapterText();
    expect(typeof text).toBe('string');
  });

  it('setMode 不抛错', async () => {
    engine.mount(container);
    await engine.init();
    expect(() => engine.setMode('scroll')).not.toThrow();
  });

  it('setTypography 不抛错', async () => {
    engine.mount(container);
    await engine.init();
    expect(() => engine.setTypography({ fontSize: 20, lineHeight: 2.0 })).not.toThrow();
  });

  it('unmount 清理资源', async () => {
    engine.mount(container);
    await engine.init();
    engine.unmount();
    expect(engine.getVisibleText()).toBe('');
    expect(engine.nextPage()).toBe(false);
  });

  it('loadChapter 带 position 恢复 CFI', async () => {
    engine.mount(container);
    await engine.init();
    const pos: ReadingPosition = {
      bookId: 'book-1',
      chapterId: 'ch-1',
      chapterIndex: 0,
      cfi: '/6/4[chap01]!/4/2',
      ratio: 0.3,
      timestamp: Date.now(),
    };
    await engine.loadChapter(makeChapter(), pos);
    expect(engine.getScrollRatio()).toBe(0.3);
  });
});
