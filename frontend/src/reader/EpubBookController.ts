/**
 * EpubBookController — epub.js 封装
 *
 * 职责：加载/渲染/跳转/主题/全局页码/事件桥接，对 UI 层屏蔽 epub.js 细节。
 *  - 进度用 CFI（relocated 事件），刷新/重进严格回到同一位置
 *  - 渲染用 scrolled-continuous（连续滚动）：epub.js 将相邻章节拼接进同一滚动容器，
 *    滚动到底自然进入下一章、滚到顶回到上一章——典型阅读器的无缝衔接，无需手动 next/prev
 *  - 主题/字号/行距用 themes 实时生效，不重建 DOM
 *  - 全局页码用 book.locations（异步生成，就绪前仅暴露章节内页码）
 *  - 点按桥接用 rendition.hooks.content（官方扩展点）直挂 iframe 内容文档 pointer 事件：
 *    连续滚动模式下文档持续存在，绑定稳定，根治「点击屏幕弹出菜单」问题
 */
import type { ReaderLocation, ReaderSettings, TocItem } from './types';
import { buildRenditionTheme, DEFAULT_READER_SETTINGS, READER_THEMES } from './theme';
import { searchBook, type SearchableBook, type SearchResult } from './searchBook';
import { buildTxtFeed } from './buildTxtFeed';

// ── epub.js 运行时类型（动态 import，避免测试/SSR 环境直接加载） ──
interface EpubNavigationTocItem {
  id?: string;
  label: string;
  href: string;
  subitems?: EpubNavigationTocItem[];
}

interface EpubBook {
  ready: Promise<unknown>;
  loaded: { navigation: Promise<{ toc: EpubNavigationTocItem[] }> };
  renderTo(el: HTMLElement, opts: Record<string, unknown>): EpubRendition;
  /** 将 CFI 解析为 DOM Range（书签摘要提取用；epub.js book.getRange） */
  getRange?(cfi: string): Promise<Range>;
  locations: {
    generate(charsPerLocation?: number): Promise<unknown>;
    length(): number;
    cfiFromPercentage(p: number): string;
    percentageFromCfi(cfi: string): number;
  };
  destroy(): void;
}

interface EpubRendition {
  display(target?: string): Promise<unknown>;
  /** 切换到下一章（兼容 epub.js API；连续滚动模式下滚动自然衔接，极少使用） */
  next(): Promise<unknown>;
  /** 切换到上一章（兼容 epub.js API；连续滚动模式下滚动自然衔接，极少使用） */
  prev(): Promise<unknown>;
  /** 当前已渲染章节的内容（Contents.document 即 iframe 内容文档） */
  getContents?(): { document?: Document }[];
  /** 官方扩展点：每次章节 view 内容加载完成后触发（直挂内容文档事件的最稳时机） */
  hooks?: {
    content?: {
      register(cb: (contents: { document?: Document }) => void): void;
    };
  };
  on(event: string, cb: (...args: any[]) => void): void;
  themes: {
    register(name: string, styles: unknown): void;
    select(name: string): void;
    fontSize(size: string): void;
  };
  destroy(): void;
}

export interface LoadOptions {
  /** 断点续读锚点 */
  initialCfi?: string | null;
  /** 在线加载时的请求头（Authorization） */
  requestHeaders?: Record<string, string>;
  /** 初始排版设置 */
  settings?: ReaderSettings;
}

/** TXT 章节输入（loadTxt 用） */
export interface TxtFeedSectionInput {
  id: string;
  title: string;
  text: string;
}

type LocationListener = (loc: ReaderLocation) => void;

function mapTocItem(item: EpubNavigationTocItem, indexPath: string): TocItem {
  return {
    id: item.id || indexPath,
    label: (item.label || '').trim(),
    href: item.href,
    subitems: item.subitems?.map((sub, i) => mapTocItem(sub, `${indexPath}.${i}`)),
  };
}

export class EpubBookController {
  private book: EpubBook | null = null;
  private rendition: EpubRendition | null = null;
  private listeners = new Set<LocationListener>();
  private tapListeners = new Set<() => void>();
  private locationsReady = false;
  private lastLocation: ReaderLocation | null = null;
  /** 点按桥接：已绑定 pointer 的 iframe 内容文档（hooks.content 每次触发时去重，防重复绑定） */
  private tapBoundDocs = new Set<Document>();
  private tapStart: { x: number; y: number } | null = null;

  /** 加载书籍并渲染。返回目录树。 */
  async load(source: string | ArrayBuffer, container: HTMLElement, options: LoadOptions = {}): Promise<TocItem[]> {
    const ePub = (await import('epubjs')).default;
    const settings = options.settings ?? DEFAULT_READER_SETTINGS;

    const epubOpts: Record<string, unknown> = {};
    if (typeof source === 'string' && options.requestHeaders) epubOpts.requestHeaders = options.requestHeaders;
    // URL 源统一以 '/' 结尾：让 epub.js 走「已解压目录」流式模式（按需请求 zip 内部条目），
    // 避免整包 zip 下载导致大文件加载超时/卡死（后端 /:id/file/* 通配路由按需读取 extracted/，
    // epub.js book.js:270 binary 下载 vs book.js:358 目录资源请求两条路径）。
    const resolvedSource = typeof source === 'string' && !source.endsWith('/') ? `${source}/` : source;
    this.book = (ePub as unknown as (src: unknown, opts: unknown) => EpubBook)(resolvedSource, epubOpts);
    await this.book.ready;

    this.rendition = this.book.renderTo(container, {
      width: '100%',
      height: '100%',
      // 连续滚动模式：epub.js 把相邻章节拼接进同一滚动容器，滚到底自然进下一章、滚到顶回上一章
      flow: 'scrolled-continuous',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    // 点按桥接：hooks.content 在每次章节内容加载后触发，直挂新文档 pointer（文档持续存在，绑定稳定）
    this.bindTap();
    await this.rendition.display(options.initialCfi || undefined);

    const nav = await this.book.loaded.navigation;
    return (nav.toc || []).map((item, i) => mapTocItem(item, String(i)));
  }

  /**
   * 以 epub.js HTML Feed 方式加载 TXT（章节文本 → 渲染）。返回目录树。
   * 复用既有渲染/主题/进度/滚动/书签/搜索全套管线；CFI 定位与 EPUB 同构。
   */
  async loadTxt(chapters: TxtFeedSectionInput[], container: HTMLElement, options: LoadOptions = {}): Promise<TocItem[]> {
    const ePub = (await import('epubjs')).default;
    const settings = options.settings ?? DEFAULT_READER_SETTINGS;
    const feed = buildTxtFeed(chapters);

    // epub.js 支持以「章节数组」作为书源：每项 { id, href, html（XHTML 字符串） }
    this.book = (ePub as unknown as (src: unknown, opts: unknown) => EpubBook)(feed.sections, {});
    await this.book.ready;

    this.rendition = this.book.renderTo(container, {
      width: '100%',
      height: '100%',
      // 连续滚动模式：与 EPUB 一致，章节拼接进同一滚动容器，滚动无缝衔接
      flow: 'scrolled-continuous',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    this.bindTap();
    await this.rendition.display(options.initialCfi || undefined);

    // TXT Feed 无 navigation.toc：由章节构建目录（href 为 section href）
    const nav = await this.book.loaded.navigation;
    return (nav.toc || []).map((item, i) => mapTocItem(item, String(i)));
  }

  /** 异步生成全局页码位置列表。完成后重广播当前位置（补全局页码）。返回总页数。 */
  async generateLocations(charsPerLocation = 1200): Promise<number> {
    if (!this.book) return 0;
    await this.book.locations.generate(charsPerLocation);
    this.locationsReady = true;
    if (this.lastLocation) this.handleRelocated({ start: { cfi: this.lastLocation.cfi, href: this.lastLocation.chapterHref, displayed: { page: this.lastLocation.pageInChapter, total: this.lastLocation.pagesInChapter } } });
    return this.book.locations.length();
  }

  /** 跳转章节 href（目录点击） */
  goTo(href: string): Promise<unknown> | undefined {
    return this.rendition?.display(href);
  }

  /** 跳转全书百分比位置（进度滑块；locations 未就绪时静默忽略） */
  goToPercentage(p: number): void {
    if (!this.book || !this.locationsReady) return;
    const clamped = Math.min(1, Math.max(0, p));
    void this.rendition?.display(this.book.locations.cfiFromPercentage(clamped));
  }

  /** 提取 CFI 锚点处文本摘要（书签用；失败/无 CFI 返回空串） */
  async getExcerptAt(cfi: string, len = 60): Promise<string> {
    if (!cfi || !this.book?.getRange) return '';
    try {
      const range = await this.book.getRange(cfi);
      const node = range?.startContainer;
      const own = (node?.textContent ?? '').slice(range?.startOffset ?? 0).trim();
      const text = own || (node?.parentElement?.textContent ?? '');
      return text.replace(/\s+/g, ' ').trim().slice(0, len);
    } catch {
      return '';
    }
  }

  /** 全书搜索（spine 逐章遍历；空查询/未加载返回空数组） */
  async search(query: string, onProgress?: (done: number, total: number) => void): Promise<SearchResult[]> {
    if (!this.book || !query.trim()) return [];
    return searchBook(this.book as unknown as SearchableBook, query.trim(), { onProgress });
  }

  /** 应用排版设置（主题色 + 行距 + 字号），不重建 DOM */
  applySettings(s: ReaderSettings): void {
    if (!this.rendition) return;
    const spec = READER_THEMES[s.theme];
    this.rendition.themes.register(spec.name, buildRenditionTheme(spec, s.lineHeight));
    this.rendition.themes.select(spec.name);
    this.rendition.themes.fontSize(`${s.fontSize}%`);
  }

  /** 订阅位置变化。返回退订函数。 */
  onLocationChange(cb: LocationListener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** 订阅正文点按（用于显隐底部菜单）。返回退订函数。 */
  onTap(cb: () => void): () => void {
    this.tapListeners.add(cb);
    return () => {
      this.tapListeners.delete(cb);
    };
  }

  get isLocationsReady(): boolean {
    return this.locationsReady;
  }

  get currentLocation(): ReaderLocation | null {
    return this.lastLocation;
  }

  destroy(): void {
    this.unbindTap();
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.listeners.clear();
    this.lastLocation = null;
    this.locationsReady = false;
  }

  // ── 内部 ──────────────────────────────────────────────

  private handleRelocated(raw: unknown): void {
    const start = (raw as { start?: any })?.start ?? {};
    const loc: ReaderLocation = {
      cfi: start.cfi ?? '',
      percentage: null,
      chapterHref: start.href,
      pageInChapter: start.displayed?.page ?? 1,
      pagesInChapter: start.displayed?.total ?? 1,
    };
    if (this.locationsReady && this.book && loc.cfi) {
      const p = this.book.locations.percentageFromCfi(loc.cfi);
      const total = this.book.locations.length();
      loc.percentage = p;
      loc.totalPages = total;
      loc.globalPage = Math.max(1, Math.min(total, Math.ceil(p * total)));
    }
    this.lastLocation = loc;
    for (const cb of this.listeners) cb(loc);
  }

  /**
   * 点按桥接：直挂 iframe 内容文档 pointer 事件。
   *  - hooks.content 是 epub.js 官方扩展点，每次章节 view 内容加载完成后触发（含后续连续加载的新章节）；
   *    连续滚动模式下 view 文档持续存在，绑定一次长期有效，根治「跨章节后点击失效」。
   *  - getContents 兜底：hooks 注册前已存在的内容立即绑定。
   */
  private bindTap(): void {
    if (!this.rendition) return;
    this.rendition.hooks?.content?.register(contents => {
      const doc = contents?.document;
      if (doc && !this.tapBoundDocs.has(doc)) {
        this.tapBoundDocs.add(doc);
        doc.addEventListener('pointerdown', this.handleTapStart, { passive: true });
        doc.addEventListener('pointerup', this.handleTapEnd, { passive: true });
      }
    });
    const existing = this.rendition.getContents?.() ?? [];
    for (const c of existing) {
      const doc = c.document;
      if (doc && !this.tapBoundDocs.has(doc)) {
        this.tapBoundDocs.add(doc);
        doc.addEventListener('pointerdown', this.handleTapStart, { passive: true });
        doc.addEventListener('pointerup', this.handleTapEnd, { passive: true });
      }
    }
  }

  private unbindTap(): void {
    for (const doc of this.tapBoundDocs) {
      doc.removeEventListener('pointerdown', this.handleTapStart);
      doc.removeEventListener('pointerup', this.handleTapEnd);
    }
    this.tapBoundDocs.clear();
    this.tapStart = null;
  }

  /** pointerdown 记录起始坐标（用于与滚动/拖动区分） */
  private handleTapStart = (e: PointerEvent): void => {
    this.tapStart = { x: e.clientX, y: e.clientY };
  };

  /** pointerup 位移 < 10px 视为点按（滚动/拖动的 pointerup 位移大，不触发） */
  private handleTapEnd = (e: PointerEvent): void => {
    const start = this.tapStart;
    this.tapStart = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    this.emitTap();
  };

  private emitTap(): void {
    for (const cb of this.tapListeners) cb();
  }
}
