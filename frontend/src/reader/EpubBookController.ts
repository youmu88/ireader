/**
 * EpubBookController — epub.js 封装
 *
 * 职责：加载/渲染/跳转/主题/全局页码/事件桥接，对 UI 层屏蔽 epub.js 细节。
 *  - 进度用 CFI（relocated 事件），刷新/重进严格回到同一位置
 *  - 渲染用 scrolled-continuous（连续滚动）：epub.js 将相邻章节拼接进同一滚动容器，
 *    滚动到底自然进入下一章、滚到顶回到上一章——典型阅读器的无缝衔接，无需手动 next/prev
 *  - 主题色/行距用 Contents.addStylesheetCss 固定单 key 替换注入（弃用 themes.register/select
 *    缺陷路径，根因见 applySettings 注释）；字号用 themes.fontSize（override 内联样式路径，无缺陷）
 *  - 全局页码用 book.locations（异步生成，就绪前仅暴露章节内页码）
 *  - 点按桥接用 rendition.hooks.content（官方扩展点）直挂 iframe 内容文档 pointer 事件：
 *    连续滚动模式下文档持续存在，绑定稳定，根治「点击屏幕弹出菜单」问题
 */
import type { ReaderLocation, ReaderSettings, TocItem } from './types';
import { buildRenditionThemeCss, DEFAULT_READER_SETTINGS, READER_THEMES } from './theme';
import { searchBook, type SearchableBook, type SearchResult } from './searchBook';
import { buildTxtFeed } from './buildTxtFeed';
import { attachScrollDamping, loadScrollDamping } from './scrollDamping';

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

/** epub.js Contents 子集：章节内容文档 + 样式表注入 */
interface EpubContents {
  /** iframe 内容文档 */
  document?: Document;
  /** 注入 CSS 文本；同 key 替换 style 元素 innerHTML —— epub.js 中唯一的「替换」语义原语 */
  addStylesheetCss?(serializedCss: string, key: string): unknown;
}

/** 章节内容文档内主题 style 元素的固定 key：全局限定单元素，配合 addStylesheetCss 替换语义 */
const THEME_STYLE_KEY = 'ireader-theme';

interface EpubRendition {
  display(target?: string): Promise<unknown>;
  /** 切换到下一章（兼容 epub.js API；连续滚动模式下滚动自然衔接，极少使用） */
  next(): Promise<unknown>;
  /** 切换到上一章（兼容 epub.js API；连续滚动模式下滚动自然衔接，极少使用） */
  prev(): Promise<unknown>;
  /** 当前已渲染章节的内容（Contents.document 即 iframe 内容文档） */
  getContents?(): EpubContents[];
  /** 官方扩展点：每次章节 view 内容加载完成后触发（直挂内容文档事件的最稳时机） */
  hooks?: {
    content?: {
      register(cb: (contents: EpubContents) => void): void;
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
  /** 最近一次点按触发时间戳（click 兜底事件去重：pointerup 刚触发过则忽略 click） */
  private lastTapAt = 0;
  /** 当前主题 CSS 文本（buildRenditionThemeCss 产物；空串 = 尚未应用任何设置，注入跳过） */
  private themeCss = '';
  /** 内容管线（hooks.content 注册 + getContents 扫描）是否已绑定：保证全生命周期仅注册一次 */
  private contentPipelineBound = false;
  /** 已装配阻尼的 iframe 内容文档 → 卸载函数（destroy 时统一卸载；幂等去重） */
  private dampingCleanups = new Map<Document, () => void>();
  /** 真实滚动容器（父页面 div.epub-container，epub.js scrolled-continuous 的 overflow-y 滚动容器） */
  private scrollTarget: HTMLElement | null = null;

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
      // 连续滚动模式：flow 与 manager 必须成对指定，epub.js 才选用 ContinuousViewManager
      // （多章节拼接进同一滚动容器）；只传 flow 会回退 DefaultViewManager 单章替换模式（表现为只能看一章）
      flow: 'scrolled-continuous',
      manager: 'continuous',
      spread: 'none',
      // 点击桥接关键配置：epub.js iframe 默认 sandbox="allow-same-origin"（无 allow-scripts）。
      // WebKit bug 218086：无 allow-scripts 的 sandbox iframe，父页面在 contentDocument 上绑定的事件
      // 监听器收不到 iframe 内事件 → 点击桥接在 iOS Safari 全部失效（历次 pointer/click 直挂均失败）。
      // allowScriptedContent:true 使 sandbox 变为 "allow-same-origin allow-scripts"，父页面可正常
      // 监听 iframe 内 click/pointer 事件（自托管书库威胁模型可接受；epub.js 官方支持该选项）。
      allowScriptedContent: true,
    });
    // 解析真实滚动容器：epub.js scrolled-continuous（fullsize=false）滚动发生在父页面 stage 创建的
    // div.epub-container（overflow-y: scroll）；触摸/滚轮事件则在 iframe 内容文档——阻尼须事件与滚动
    // 目标分离（历史缺陷：滚动 iframe 内容文档 documentElement 导致垂直滚动失效，根因见 scrollDamping）
    this.scrollTarget = container.querySelector<HTMLElement>('.epub-container') ?? null;
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    // 内容管线：hooks.content 单次注册（主题注入 + 点按桥接）+ getContents 兜底 + relocated 重扫
    this.bindContentPipeline();
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
      // 连续滚动模式：与 EPUB 一致，flow+manager 成对指定启用 ContinuousViewManager（多章拼接）
      flow: 'scrolled-continuous',
      manager: 'continuous',
      spread: 'none',
      // 点击桥接关键配置：同 EPUB，sandbox 需含 allow-scripts 才能让父页面监听到 iframe 内事件
      // （WebKit 218086：无 allow-scripts 的 sandbox iframe 阻断父页面 contentDocument 事件监听）
      allowScriptedContent: true,
    });
    // 同 EPUB：解析真实滚动容器（父页面 div.epub-container）供滚动阻尼装配
    this.scrollTarget = container.querySelector<HTMLElement>('.epub-container') ?? null;
    this.applySettings(settings);
    this.rendition.on('relocated', (raw: unknown) => this.handleRelocated(raw));
    this.bindContentPipeline();
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


  /** 全书搜索（spine 逐章遍历；空查询/未加载返回空数组） */
  async search(query: string, onProgress?: (done: number, total: number) => void): Promise<SearchResult[]> {
    if (!this.book || !query.trim()) return [];
    return searchBook(this.book as unknown as SearchableBook, query.trim(), { onProgress });
  }

  /**
   * 应用排版设置（主题色 + 行距 + 字号），不重建 DOM。
   *
   * 主题注入走 Contents.addStylesheetCss(css, 固定单 key) —— epub.js 中唯一「同 key 整体替换」
   * 原语（contents.js:769 `styleEl.innerHTML = serializedCss`）：每个章节文档仅存一个主题
   * style 元素，重复设置即换新，无旧主题残留、无规则堆积。
   *
   * ⚠️ 弃用 themes.register/select（规则对象路径）的根因 —— epub.js keyed stylesheet 是
   * 「同 key insertRule 追加、跨 key 按 head 文档序决胜」：
   *  1. 主题首次选择按顺序创建 epubjs-inserted-css-<name> 元素（contents.js:746 _getStylesheetNode，
   *     已存在的元素保持原位）；再次选择旧主题时新规则插回原位（文档序靠前），同优先级 !important
   *     冲突由文档序靠后的元素胜出 → 正文停留在旧主题，而 React 镀铬层（声明式）已切新主题
   *     → 「改了阅读背景，顶栏变了正文不变」；
   *  2. 连续滚动模式下新拼接章节经 Themes.inject 只注入当前主题 → 同屏新旧章节异色；
   *  3. addStylesheetRules 同 key 追加不清理（contents.js:785-809）→ 每次设置规则无限堆积。
   * 字号仍走 themes.fontSize：override → 内容根元素内联样式 + overrides hook 自动覆盖新章节，该路径无缺陷。
   */
  applySettings(s: ReaderSettings): void {
    if (!this.rendition) return;
    this.themeCss = buildRenditionThemeCss(READER_THEMES[s.theme], s.lineHeight);
    for (const contents of this.rendition.getContents?.() ?? []) {
      this.applyThemeToContents(contents);
    }
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
    for (const cleanup of this.dampingCleanups.values()) cleanup();
    this.dampingCleanups.clear();
    this.scrollTarget = null;
    this.rendition?.destroy();
    this.book?.destroy();
    this.rendition = null;
    this.book = null;
    this.listeners.clear();
    this.lastLocation = null;
    this.locationsReady = false;
    this.themeCss = '';
    this.contentPipelineBound = false;
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
    // 章节切换（含连续滚动滚动到新章节）后：重扫最新内容文档（主题注入 + 点按桥接，均幂等）
    this.rescanContents();
    for (const cb of this.listeners) cb(loc);
  }

  /**
   * 内容管线绑定：hooks.content 单次注册（epub.js 官方扩展点，每次章节 view 内容加载完成后
   * 触发，含后续连续加载的新章节）+ getContents 扫描兜底（注册前已存在的内容立即处理）。
   *
   * ⚠️ hooks.content.register 全生命周期只能调用一次：epub.js Hook.register 为无脑 push
   * （utils/hook.js:29）。历史版本在每次 relocated（滚动重定位即高频触发）都重复注册，
   * 回调数组随滚动无界增长 —— 每次新章节加载触发全部重复回调（内存/CPU 双重泄漏）。
   */
  private bindContentPipeline(): void {
    if (!this.rendition || this.contentPipelineBound) return;
    this.contentPipelineBound = true;
    this.rendition.hooks?.content?.register(this.handleContentsReady);
    this.rescanContents();
  }

  /** 章节内容就绪统一入口：主题 CSS 注入 + 点按桥接直挂 + 滚动阻尼装配（均幂等，hooks 触发与扫描兜底共用） */
  private handleContentsReady = (contents: EpubContents): void => {
    this.applyThemeToContents(contents);
    this.attachTapDoc(contents?.document);
    this.attachDampingDoc(contents?.document);
  };

  /** 扫描当前已渲染内容文档（relocated 重扫 / 注册后兜底；重复执行无副作用） */
  private rescanContents(): void {
    const existing = this.rendition?.getContents?.() ?? [];
    for (const contents of existing) this.handleContentsReady(contents);
  }

  /**
   * 将当前主题 CSS 注入单个章节内容文档：固定单 key + addStylesheetCss「同 key 整体替换」语义，
   * 每个章节文档只存在一个主题 style 元素，重复设置即换新 —— 无旧主题残留、无规则堆积。
   */
  private applyThemeToContents(contents: EpubContents | undefined): void {
    if (!contents?.document || !this.themeCss) return;
    contents.addStylesheetCss?.(this.themeCss, THEME_STYLE_KEY);
  }

  /** 为单个内容文档直挂点按监听（幂等：已绑定的文档跳过） */
  private attachTapDoc(doc: Document | undefined): void {
    if (!doc || this.tapBoundDocs.has(doc)) return;
    this.tapBoundDocs.add(doc);
    doc.addEventListener('pointerdown', this.handleTapStart, { passive: true });
    doc.addEventListener('pointerup', this.handleTapEnd, { passive: true });
    doc.addEventListener('click', this.handleTapClick);
  }

  /** 为单个内容文档装配滚动阻尼（幂等：已装配的文档跳过；滚动目标为真实 .epub-container 容器） */
  private attachDampingDoc(doc: Document | undefined): void {
    if (!doc || !this.scrollTarget || this.dampingCleanups.has(doc)) return;
    this.dampingCleanups.set(doc, attachScrollDamping(doc, this.scrollTarget, loadScrollDamping));
  }

  private unbindTap(): void {
    for (const doc of this.tapBoundDocs) {
      doc.removeEventListener('pointerdown', this.handleTapStart);
      doc.removeEventListener('pointerup', this.handleTapEnd);
      doc.removeEventListener('click', this.handleTapClick);
    }
    this.tapBoundDocs.clear();
    this.tapStart = null;
    this.lastTapAt = 0;
  }

  /** pointerdown 记录起始坐标（用于与滚动/拖动区分） */
  private handleTapStart = (e: PointerEvent): void => {
    this.tapStart = { x: e.clientX, y: e.clientY };
  };

  /** pointerup 位移 < 10px 视为点按（滚动/拖动的 pointerup 位移大，不触发）；触发后记录时间戳供 click 去重 */
  private handleTapEnd = (e: PointerEvent): void => {
    const start = this.tapStart;
    this.tapStart = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) return;
    this.lastTapAt = Date.now();
    this.emitTap();
  };

  /** click 兜底（pointer 事件不可用的环境）；若 pointerup 刚触发过（<400ms）则忽略防双触发 */
  private handleTapClick = (): void => {
    if (Date.now() - this.lastTapAt < 400) return;
    this.lastTapAt = Date.now();
    this.emitTap();
  };

  private emitTap(): void {
    for (const cb of this.tapListeners) cb();
  }
}
