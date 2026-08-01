import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EpubBookController } from './EpubBookController';

// ── epub.js mock（vi.hoisted 保证在 vi.mock 提升后可用） ──
const mocks = vi.hoisted(() => {
  /** hooks.content 注册回调（模拟 epub.js 每次章节内容加载后触发） */
  const contentHooks: Array<(contents: { document?: Document }) => void> = [];
  const rendition = {
    display: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    next: vi.fn().mockResolvedValue(undefined),
    prev: vi.fn().mockResolvedValue(undefined),
    getContents: vi.fn<[], { document?: Document }[]>(() => []),
    hooks: {
      content: {
        register: vi.fn((cb: (contents: { document?: Document }) => void) => {
          contentHooks.push(cb);
        }),
      },
    },
    themes: { register: vi.fn(), select: vi.fn(), fontSize: vi.fn() },
    destroy: vi.fn(),
  };
  const book = {
    ready: Promise.resolve(),
    loaded: {
      navigation: Promise.resolve({
        toc: [
          { id: 'c1', label: ' 第一章 ', href: 'ch1.xhtml' },
          {
            id: 'c2',
            label: '第二章',
            href: 'ch2.xhtml',
            subitems: [{ id: 'c2-1', label: '2.1 节', href: 'ch2.xhtml#s1' }],
          },
        ],
      }),
    },
    renderTo: vi.fn(() => rendition),
    getRange: vi.fn(),
    locations: {
      generate: vi.fn().mockResolvedValue(undefined),
      length: vi.fn().mockReturnValue(500),
      cfiFromPercentage: vi.fn((p: number) => `cfi@${p}`),
      percentageFromCfi: vi.fn(() => 0.42),
    },
    destroy: vi.fn(),
  };
  return { book, rendition, ePub: vi.fn(() => book), contentHooks };
});

vi.mock('epubjs', () => ({ default: mocks.ePub }));

/** iframe 内容文档 mock（点按桥接直挂目标） */
const contentDoc = document.implementation.createHTMLDocument('epub-content');

function emitRelocated(loc: unknown) {
  const call = mocks.rendition.on.mock.calls.find(([event]) => event === 'relocated');
  const cb = call?.[1] as ((l: unknown) => void) | undefined;
  cb?.(loc);
}

/** 模拟 epub.js 触发 hooks.content（章节 view 内容加载完成），返回是否成功触发 */
function fireContentHook(doc: Document = contentDoc) {
  for (const cb of mocks.contentHooks) cb({ document: doc });
}

/** 模拟在 iframe 内容文档上的点按（pointerdown + pointerup 同坐标，位移 0） */
function emitTap(x = 10, y = 10) {
  contentDoc.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
  contentDoc.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, bubbles: true }));
}

/** 模拟拖动/滚动：pointerup 坐标与 down 位移 ≥ 10px */
function emitDrag(fromX: number, fromY: number, toX: number, toY: number) {
  contentDoc.dispatchEvent(new MouseEvent('pointerdown', { clientX: fromX, clientY: fromY, bubbles: true }));
  contentDoc.dispatchEvent(new MouseEvent('pointerup', { clientX: toX, clientY: toY, bubbles: true }));
}

describe('EpubBookController', () => {
  let controller: EpubBookController;
  const container = document.createElement('div');

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.contentHooks.length = 0;
    mocks.rendition.getContents.mockReturnValue([{ document: contentDoc }]);
    controller = new EpubBookController();
  });

  it('load：创建 book、以 scrolled-continuous（连续滚动）渲染、显示初始 CFI、返回递归映射目录', async () => {
    const toc = await controller.load('https://x/book.epub', container, {
      initialCfi: 'epubcfi(/6/2!/4/2)',
      requestHeaders: { Authorization: 'Bearer t' },
    });

    expect(mocks.ePub).toHaveBeenCalledWith('https://x/book.epub/', {
      requestHeaders: { Authorization: 'Bearer t' },
    });
    expect(mocks.book.renderTo).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ flow: 'scrolled-continuous', spread: 'none' }),
    );
    expect(mocks.rendition.display).toHaveBeenCalledWith('epubcfi(/6/2!/4/2)');
    expect(toc).toHaveLength(2);
    expect(toc[0].label).toBe('第一章'); // trim
    expect(toc[1].subitems?.[0].href).toBe('ch2.xhtml#s1');
  });

  it('load：无初始 CFI 时 display() 从头开始；ArrayBuffer 来源不传 requestHeaders', async () => {
    const buffer = new ArrayBuffer(8);
    await controller.load(buffer, container);
    expect(mocks.ePub).toHaveBeenCalledWith(buffer, {});
    expect(mocks.rendition.display).toHaveBeenCalledWith(undefined);
  });

  it('load/applySettings：注入主题样式并应用字号', async () => {
    await controller.load('url', container, { settings: { fontSize: 120, theme: 'sepia', lineHeight: 2.0 } });
    expect(mocks.rendition.themes.register).toHaveBeenCalledWith(
      'sepia',
      expect.objectContaining({ body: expect.objectContaining({ 'line-height': '2 !important' }) }),
    );
    expect(mocks.rendition.themes.select).toHaveBeenCalledWith('sepia');
    expect(mocks.rendition.themes.fontSize).toHaveBeenCalledWith('120%');

    controller.applySettings({ fontSize: 90, theme: 'black', lineHeight: 1.5 });
    expect(mocks.rendition.themes.select).toHaveBeenCalledWith('black');
    expect(mocks.rendition.themes.fontSize).toHaveBeenCalledWith('90%');
  });

  it('relocated → 映射 ReaderLocation；locations 未就绪时 percentage 为 null', async () => {
    await controller.load('url', container);
    const listener = vi.fn();
    controller.onLocationChange(listener);

    emitRelocated({ start: { cfi: 'cfi-a', href: 'ch1.xhtml', displayed: { page: 3, total: 12 } } });
    expect(listener).toHaveBeenCalledTimes(1);
    const loc = listener.mock.calls[0][0];
    expect(loc).toMatchObject({
      cfi: 'cfi-a',
      chapterHref: 'ch1.xhtml',
      pageInChapter: 3,
      pagesInChapter: 12,
      percentage: null,
    });
    expect(loc.globalPage).toBeUndefined();
  });

  it('generateLocations 后：位置带全局页码/总页数/全书进度，并重广播当前位置', async () => {
    await controller.load('url', container);
    const listener = vi.fn();
    controller.onLocationChange(listener);
    emitRelocated({ start: { cfi: 'cfi-a', href: 'ch1.xhtml', displayed: { page: 3, total: 12 } } });

    const total = await controller.generateLocations();
    expect(total).toBe(500);
    expect(mocks.book.locations.generate).toHaveBeenCalledWith(1200);
    // 重广播一次
    expect(listener).toHaveBeenCalledTimes(2);
    const enriched = listener.mock.calls[1][0];
    expect(enriched.percentage).toBe(0.42);
    expect(enriched.totalPages).toBe(500);
    expect(enriched.globalPage).toBe(Math.ceil(0.42 * 500)); // 210
    expect(controller.isLocationsReady).toBe(true);
  });

  it('goToPercentage：未就绪忽略；就绪后按百分比跳转', async () => {
    await controller.load('url', container);
    controller.goToPercentage(0.5);
    expect(mocks.rendition.display).toHaveBeenCalledTimes(1); // 仅 load 的一次

    await controller.generateLocations();
    controller.goToPercentage(0.5);
    expect(mocks.book.locations.cfiFromPercentage).toHaveBeenCalledWith(0.5);
    expect(mocks.rendition.display).toHaveBeenCalledWith('cfi@0.5');

    controller.goToPercentage(1.5); // clamp 到 1
    expect(mocks.book.locations.cfiFromPercentage).toHaveBeenCalledWith(1);
  });

  it('goTo 跳转章节 href', async () => {
    await controller.load('url', container);
    await controller.goTo('ch2.xhtml');
    expect(mocks.rendition.display).toHaveBeenCalledWith('ch2.xhtml');
  });

  it('onLocationChange 退订后不再收到事件', async () => {
    await controller.load('url', container);
    const listener = vi.fn();
    const off = controller.onLocationChange(listener);
    off();
    emitRelocated({ start: { cfi: 'cfi-b', displayed: { page: 1, total: 1 } } });
    expect(listener).not.toHaveBeenCalled();
  });

  it('onTap：hooks.content 直挂内容文档 pointerdown+up（位移 0）触发订阅回调；退订后不再触发', async () => {
    await controller.load('url', container);
    expect(mocks.rendition.hooks.content.register).toHaveBeenCalled();

    const listener = vi.fn();
    const off = controller.onTap(listener);
    emitTap();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    emitTap();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('onTap：拖动/滚动（pointer 位移 ≥ 10px）不触发点按', async () => {
    await controller.load('url', container);
    const listener = vi.fn();
    controller.onTap(listener);
    emitDrag(10, 10, 60, 220); // 滚动典型位移
    expect(listener).not.toHaveBeenCalled();
  });

  it('跨章节（连续滚动加载新章节 view）后：hooks.content 触发 → 新内容文档自动直挂点按桥接', async () => {
    await controller.load('url', container);
    const listener = vi.fn();
    controller.onTap(listener);

    // 连续滚动加载新章节 → epub.js 触发 hooks.content → 绑定新文档
    const newDoc = document.implementation.createHTMLDocument('epub-ch2');
    fireContentHook(newDoc);

    // 新文档上点按 → 触发
    newDoc.dispatchEvent(new MouseEvent('pointerdown', { clientX: 20, clientY: 20, bubbles: true }));
    newDoc.dispatchEvent(new MouseEvent('pointerup', { clientX: 20, clientY: 20, bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(1);

    // 旧文档仍有效（连续滚动模式 view 持续存在）→ 也触发
    emitTap();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('loadTxt：以 scrolled-continuous 渲染并注册 hooks.content 点按桥接', async () => {
    await controller.loadTxt(
      [{ id: 't1', title: '第一章', text: '正文' }],
      container,
      { settings: { fontSize: 100, theme: 'white', lineHeight: 1.75 } },
    );
    expect(mocks.book.renderTo).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ flow: 'scrolled-continuous' }),
    );
    expect(mocks.rendition.hooks.content.register).toHaveBeenCalled();
  });

  it('getExcerptAt：提取 CFI 锚点处文本摘要（压缩空白、限长）', async () => {
    await controller.load('url', container);
    mocks.book.getRange.mockResolvedValue({
      startContainer: { textContent: '从前有座山，  山里有座庙', parentElement: null },
      startOffset: 8,
    });
    const excerpt = await controller.getExcerptAt('epubcfi(x)', 6);
    expect(mocks.book.getRange).toHaveBeenCalledWith('epubcfi(x)');
    expect(excerpt).toBe('山里有座庙');
  });

  it('getExcerptAt：无 CFI / getRange 失败时返回空串', async () => {
    await controller.load('url', container);
    expect(await controller.getExcerptAt('')).toBe('');
    mocks.book.getRange.mockRejectedValue(new Error('bad cfi'));
    expect(await controller.getExcerptAt('epubcfi(bad)')).toBe('');
  });

  it('destroy：销毁 rendition 与 book 并清理状态', async () => {
    await controller.load('url', container);
    controller.destroy();
    expect(mocks.rendition.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.book.destroy).toHaveBeenCalledTimes(1);
    expect(controller.currentLocation).toBeNull();
    expect(controller.isLocationsReady).toBe(false);
  });
});
