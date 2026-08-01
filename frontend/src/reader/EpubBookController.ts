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
  /** 切换到下一章（章节自动衔接用；已至末章时静默） */
  next(): Promise<unknown>;
  /** 切换到上一章（向上滚动衔接用；已至首章时静默） */
  prev(): Promise<unknown>;
  /** 当前已渲染章节的内容（点按桥接直挂用：Contents.document 即 iframe 内容文档） */
  getContents?(): { document?: Document }[];
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
  /** 章节自动衔接：监听渲染层滚动容器，接近章节末尾自动加载下一章（scrolled-doc 单章节渲染） */
  private scrollEl: HTMLElement | null = null;
  private autoNextLocked = false;
  private autoNextBound = false;
  /** 向上滚动衔接：标记「已请求上一章，需在 relocated 后滚到新章节末尾」保持阅读连续 */
  private pendingPrevScrollToBottom = false;
  /** 跨章节过渡动画：记录当前章节 href，切换时播放 280ms 淡入（区别于章节内滚动） */
  private chapterTransitionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 点按桥接：直挂 iframe 内容文档的 pointer 事件（绕过 epub.js click 桥接，移动端 click 合成不可靠） */
  private tapBoundDocs = new Set<Document>();
  private tapStart: { x: number; y: number } | null = null;
  /** 章节衔接阈值：滚动到章节顶部/底部 140px 内触发上一章/下一章 */
  private static readonly CHAPTER_BOUNDARY = 140;

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
      // 固定垂直滚动模式（scrolled-doc：单章节 iframe 垂直滚动；章节衔接由 Controller 监听滚动自动 next 实现）
      flow: 'scrolled-doc',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    await this.rendition.display(options.initialCfi || undefined);
    this.bindAutoNext();
    // 点按桥接：直挂 iframe 内容文档 pointer 事件（epub.js click 桥接在 scrolled-doc 重建场景不可靠，
    // 且移动端 click 合成有延迟/丢失；pointerdown+up 位移识别最稳）
    this.bindTap();

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
      // 固定垂直滚动模式（scrolled-doc：单章节 iframe 垂直滚动；章节衔接由 Controller 监听滚动自动 next 实现）
      flow: 'scrolled-doc',
      spread: 'none',
    });
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    await this.rendition.display(options.initialCfi || undefined);
    this.bindAutoNext();
    this.bindTap();

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

  /** 订阅正文点击（epub.js 将 iframe 内 click 桥接到 rendition；用于显隐工具栏，不在滚动容器上叠加拦截层）。返回退订函数。 */
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
    this.unbindAutoNext();
    this.unbindTap();
    if (this.chapterTransitionTimer) {
      clearTimeout(this.chapterTransitionTimer);
      this.chapterTransitionTimer = null;
    }
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.listeners.clear();
    this.lastLocation = null;
    this.locationsReady = false;
  }

  // ── 内部 ──────────────────────────────────────────────

  /**
   * 绑定渲染层滚动容器（epub.js manager.container），滚动到章节边界时自动衔接上/下一章：
   *  - 接近章节末尾（剩余 < 140px）→ 加载下一章
   *  - 接近章节开头（距顶 < 140px）→ 加载上一章，并滚到上一章末尾（保持阅读连续）
   * 仅作衔接，不叠加覆盖层、不拦截滚动手势；已绑定幂等。
   */
  private bindAutoNext(): void {
    if (this.autoNextBound || !this.rendition) return;
    const manager = (this.rendition as unknown as { manager?: { container?: HTMLElement } }).manager;
    const el = manager?.container;
    if (!el) return;
    this.scrollEl = el;
    el.addEventListener('scroll', this.handleAutoChapterScroll, { passive: true });
    this.autoNextBound = true;
  }

  private unbindAutoNext(): void {
    if (this.scrollEl) {
      this.scrollEl.removeEventListener('scroll', this.handleAutoChapterScroll);
      this.scrollEl = null;
    }
    this.autoNextBound = false;
    this.autoNextLocked = false;
    this.pendingPrevScrollToBottom = false;
  }

  /** 滚动到章节边界自动衔接：接近末尾 → next；接近开头 → prev（随后滚到新章节末尾保持连续阅读） */
  private handleAutoChapterScroll = (): void => {
    const el = this.scrollEl;
    if (!el || this.autoNextLocked || !this.rendition) return;
    const boundary = EpubBookController.CHAPTER_BOUNDARY;

    // 章节内正常滚动（既不在开头也不在末尾）→ 不处理
    if (el.scrollTop + el.clientHeight < el.scrollHeight - boundary && el.scrollTop > boundary) return;

    // 接近章节末尾 → 加载下一章
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - boundary) {
      this.autoNextLocked = true;
      void (this.rendition.next() as Promise<unknown>)
        .catch(() => undefined)
        .finally(() => {
          // 等 relocated（章节切换完成）后解锁，避免滚动事件风暴连发
          setTimeout(() => {
            this.autoNextLocked = false;
          }, 400);
        });
      return;
    }

    // 接近章节开头 → 加载上一章；relocated 后滚动到新章节末尾（向上阅读保持连续）
    if (el.scrollTop <= boundary) {
      this.autoNextLocked = true;
      this.pendingPrevScrollToBottom = true;
      void (this.rendition.prev() as Promise<unknown>)
        .catch(() => undefined)
        .finally(() => {
          setTimeout(() => {
            this.autoNextLocked = false;
            this.pendingPrevScrollToBottom = false;
          }, 400);
        });
    }
  };

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

    // 向上衔接：切换完成（新章节已渲染）后滚动到新章节末尾，保持「上一章末尾 → 本章开头」阅读连续
    if (this.pendingPrevScrollToBottom) {
      this.pendingPrevScrollToBottom = false;
      this.scrollToChapterBottom();
    }

    // 章节切换（href 变化）→ 播放 280ms 跨章节过渡动画，与章节内滚动区分
    this.playChapterTransitionIfChanged(start.href);

    for (const cb of this.listeners) cb(loc);
  }

  /** 将渲染层滚动容器滚到当前章节末尾（向上衔接上一章后调用，保证连续阅读） */
  private scrollToChapterBottom(): void {
    const el = this.scrollEl;
    if (!el) return;
    // 新章节 iframe 刚替换，DOM 尚未完全布局；用两帧后再滚动，确保 scrollHeight 正确
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    });
  }

  /** 章节 href 变化时播放跨章节过渡动画（280ms 淡入；区别于章节内滚动，更丝滑） */
  private playChapterTransitionIfChanged(href: string): void {
    const el = this.scrollEl;
    if (!el || !href || href === el.dataset.chapterHref) return;
    el.dataset.chapterHref = href;
    el.classList.remove('reader-chapter-transition');
    // 强制重排以重启动画
    void el.offsetWidth;
    el.classList.add('reader-chapter-transition');
    if (this.chapterTransitionTimer) clearTimeout(this.chapterTransitionTimer);
    this.chapterTransitionTimer = setTimeout(() => {
      el.classList.remove('reader-chapter-transition');
      this.chapterTransitionTimer = null;
    }, 300);
  }

  /** 点按桥接：直挂当前 iframe 内容文档 pointer 事件（epub.js click 桥接在 scrolled-doc 重建场景不可靠，
   *  且移动端 click 合成有 300ms 延迟/丢失；pointerdown+up 位移识别最稳）。返回退订函数。 */
  private bindTap(): void {
    if (!this.rendition) return;
    const contents = this.rendition.getContents?.() ?? [];
    for (const c of contents) {
      const doc = c.document;
      if (!doc || this.tapBoundDocs.has(doc)) continue;
      this.tapBoundDocs.add(doc);
      doc.addEventListener('pointerdown', this.handleTapStart, { passive: true });
      doc.addEventListener('pointerup', this.handleTapEnd, { passive: true });
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
