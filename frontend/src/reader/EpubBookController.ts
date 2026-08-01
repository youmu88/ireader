/**
 * EpubBookController — epub.js 封装
 *
 * 职责：加载/渲染/翻页/跳转/主题/全局页码/事件桥接，对 UI 层屏蔽 epub.js 细节。
 *  - 进度用 CFI（relocated 事件），刷新/重进严格回到同一位置
 *  - 翻页用 rendition.next()/prev()，基于整书连续 spine
 *  - 主题/字号/行距用 themes 实时生效，不重建 DOM
 *  - 全局页码用 book.locations（异步生成，就绪前仅暴露章节内页码）
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
  next(): Promise<unknown>;
  prev(): Promise<unknown>;
  on(event: string, cb: (...args: any[]) => void): void;
  /** 切换流模式：'paginated' 左右翻页 / 'scrolled-doc' 垂直滚动 */
  flow(mode: string): void;
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
  private locationsReady = false;
  private lastLocation: ReaderLocation | null = null;

  /** 加载书籍并渲染。返回目录树。 */
  async load(source: string | ArrayBuffer, container: HTMLElement, options: LoadOptions = {}): Promise<TocItem[]> {
    const ePub = (await import('epubjs')).default;
    const settings = options.settings ?? DEFAULT_READER_SETTINGS;

    const epubOpts: Record<string, unknown> = {};
    if (typeof source === 'string' && options.requestHeaders) epubOpts.requestHeaders = options.requestHeaders;
    this.book = (ePub as unknown as (src: unknown, opts: unknown) => EpubBook)(source, epubOpts);
    await this.book.ready;

    this.rendition = this.book.renderTo(container, {
      width: '100%',
      height: '100%',
      flow: settings.scrollMode ? 'scrolled-doc' : 'paginated',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    await this.rendition.display(options.initialCfi || undefined);

    const nav = await this.book.loaded.navigation;
    return (nav.toc || []).map((item, i) => mapTocItem(item, String(i)));
  }

  /**
   * 以 epub.js HTML Feed 方式加载 TXT（章节文本 → 渲染）。返回目录树。
   * 复用既有渲染/翻页/主题/进度/滚动/书签/搜索全套管线；CFI 定位与 EPUB 同构。
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
      flow: settings.scrollMode ? 'scrolled-doc' : 'paginated',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
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

  next(): Promise<unknown> | undefined {
    return this.rendition?.next();
  }

  prev(): Promise<unknown> | undefined {
    return this.rendition?.prev();
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

  /** 切换翻页/滚动流模式（epub.js rendition.flow 自动回到相近位置并触发 relocated） */
  setFlow(scrollMode: boolean): void {
    this.rendition?.flow(scrollMode ? 'scrolled-doc' : 'paginated');
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

  get isLocationsReady(): boolean {
    return this.locationsReady;
  }

  get currentLocation(): ReaderLocation | null {
    return this.lastLocation;
  }

  destroy(): void {
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
}
