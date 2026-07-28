import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TxtEngine } from './TxtEngine';
import type { Chapter } from '../types';
import type { ReadingPosition } from '../position/types';

// jsdom 不提供 ResizeObserver，mock 之
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// ── 工具 ─────────────────────────────────────────────────

function makeChapter(overrides: Partial<Chapter> = {}): Chapter {
  return { id: 'ch-1', title: '第一章', order: 0, ...overrides };
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  // 模拟容器尺寸
  Object.defineProperty(el, 'clientWidth', { value: 400, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true });
  document.body.appendChild(el);
  return el;
}

// ── 测试 ─────────────────────────────────────────────────

describe('TxtEngine', () => {
  let container: HTMLElement;
  let engine: TxtEngine;

  beforeEach(() => {
    container = makeContainer();
    engine = new TxtEngine({ bookId: 'book-1', mode: 'paginated' });
  });

  afterEach(() => {
    engine.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('mount 创建 DOM 结构', () => {
    engine.mount(container);
    const scrollEl = container.querySelector('.txt-engine-scroll');
    const contentEl = container.querySelector('.txt-engine-content');
    expect(scrollEl).not.toBeNull();
    expect(contentEl).not.toBeNull();
    expect(scrollEl!.contains(contentEl)).toBe(true);
  });

  it('unmount 清理 DOM 和监听器', () => {
    engine.mount(container);
    engine.unmount();
    expect(container.querySelector('.txt-engine-scroll')).toBeNull();
  });

  it('format 为 txt', () => {
    expect(engine.format).toBe('txt');
  });

  it('setChapterText + loadChapter 渲染段落', async () => {
    engine.mount(container);
    engine.setChapterText('第一段内容\n\n第二段内容\n\n第三段内容');
    await engine.loadChapter(makeChapter());

    const paragraphs = container.querySelectorAll('.txt-engine-content p');
    expect(paragraphs.length).toBe(3);
    expect(paragraphs[0].textContent).toBe('第一段内容');
  });

  it('getFullChapterText 返回完整文本', async () => {
    engine.mount(container);
    const text = '你好世界\n\n第二段';
    engine.setChapterText(text);
    await engine.loadChapter(makeChapter());
    expect(await engine.getFullChapterText()).toBe(text);
  });

  it('分页模式：getPageCount 至少为 1', async () => {
    engine.mount(container);
    engine.setChapterText('短文本');
    await engine.loadChapter(makeChapter());
    expect(engine.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('分页模式：nextPage 在最后一页返回 false 并触发 boundary', async () => {
    engine.mount(container);
    engine.setChapterText('短文本');
    await engine.loadChapter(makeChapter());

    const boundaryCb = vi.fn();
    engine.onChapterBoundary(boundaryCb);

    // pageCount=1 时 nextPage 应返回 false
    const result = engine.nextPage();
    expect(result).toBe(false);
    expect(boundaryCb).toHaveBeenCalledWith('next');
  });

  it('分页模式：prevPage 在第一页返回 false 并触发 boundary', async () => {
    engine.mount(container);
    engine.setChapterText('短文本');
    await engine.loadChapter(makeChapter());

    const boundaryCb = vi.fn();
    engine.onChapterBoundary(boundaryCb);

    const result = engine.prevPage();
    expect(result).toBe(false);
    expect(boundaryCb).toHaveBeenCalledWith('prev');
  });

  it('分页模式：goToPage clamp 到合法范围', async () => {
    engine.mount(container);
    engine.setChapterText('文本');
    await engine.loadChapter(makeChapter());

    engine.goToPage(999);
    expect(engine.getCurrentPage()).toBe(engine.getPageCount() - 1);

    engine.goToPage(-5);
    expect(engine.getCurrentPage()).toBe(0);
  });

  it('onPositionChange 在 loadChapter 后触发', async () => {
    engine.mount(container);
    engine.setChapterText('内容');

    const posCb = vi.fn();
    engine.onPositionChange(posCb);

    await engine.loadChapter(makeChapter());
    expect(posCb).toHaveBeenCalled();

    const pos: ReadingPosition = posCb.mock.calls[posCb.mock.calls.length - 1][0];
    expect(pos.bookId).toBe('book-1');
    expect(pos.chapterId).toBe('ch-1');
    expect(pos.ratio).toBeGreaterThanOrEqual(0);
  });

  it('onPositionChange 取消订阅后不再触发', async () => {
    engine.mount(container);
    engine.setChapterText('内容');

    const posCb = vi.fn();
    const unsub = engine.onPositionChange(posCb);
    unsub();

    await engine.loadChapter(makeChapter());
    expect(posCb).not.toHaveBeenCalled();
  });

  it('滚动模式：scrollToRatio / getScrollRatio 基本行为', async () => {
    const scrollEngine = new TxtEngine({ bookId: 'book-1', mode: 'scroll' });
    scrollEngine.mount(container);
    scrollEngine.setChapterText('滚动内容');
    await scrollEngine.loadChapter(makeChapter());

    // jsdom 中 scrollHeight=0，所以 ratio 始终为 0
    expect(scrollEngine.getScrollRatio()).toBe(0);
    scrollEngine.scrollToRatio(0.5); // 不报错即可
    scrollEngine.unmount();
  });

  it('setMode 切换模式不报错', async () => {
    engine.mount(container);
    engine.setChapterText('内容');
    await engine.loadChapter(makeChapter());

    engine.setMode('scroll');
    expect(engine.getMode()).toBe('scroll');

    engine.setMode('paginated');
    expect(engine.getMode()).toBe('paginated');
  });

  it('setTypography 更新样式不报错', async () => {
    engine.mount(container);
    engine.setChapterText('内容');
    await engine.loadChapter(makeChapter());

    engine.setTypography({ fontSize: 24, lineHeight: 2.0 });
    const contentEl = container.querySelector('.txt-engine-content') as HTMLElement;
    expect(contentEl.style.fontSize).toBe('24px');
    expect(contentEl.style.lineHeight).toBe('2');
  });

  it('loadChapter 带 position 恢复页码', async () => {
    engine.mount(container);
    engine.setChapterText('内容');
    await engine.loadChapter(makeChapter());

    const pos: ReadingPosition = {
      bookId: 'book-1',
      chapterId: 'ch-1',
      chapterIndex: 0,
      page: 0,
      pageCount: 1,
      ratio: 0,
      timestamp: Date.now(),
    };
    await engine.loadChapter(makeChapter(), pos);
    expect(engine.getCurrentPage()).toBe(0);
  });

  it('HTML 特殊字符被转义', async () => {
    engine.mount(container);
    engine.setChapterText('<script>alert("xss")</script>');
    await engine.loadChapter(makeChapter());

    const contentEl = container.querySelector('.txt-engine-content')!;
    expect(contentEl.innerHTML).not.toContain('<script>');
    expect(contentEl.textContent).toContain('<script>');
  });
});
