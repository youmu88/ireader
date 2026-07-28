/**
 * EpubEngine —— EPUB 阅读器引擎（实现 ReaderEngine 接口）
 *
 * 封装 epub.js，将 rendition 事件映射为统一的 ReaderEngine API：
 *   - 进度用 CFI + ratio（relocated 事件）
 *   - 翻页用 rendition.next()/prev()
 *   - 章节跳转用 rendition.display(href)
 *   - 位置变化通过 onPositionChange 广播
 *   - 章节边界通过 onChapterBoundary 通知
 */
import type { ReaderEngine } from './types';
import type { BookFormat, Chapter } from '../types';
import type { ReadingPosition } from '../position/types';

// epub.js 类型（运行时动态 import，避免 SSR 问题）
interface EpubBook {
  ready: Promise<void>;
  spine: { length: number };
  destroy(): void;
  rendition: any;
}

interface EpubRendition {
  display(target?: string): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  destroy(): void;
  on(event: string, cb: (...args: any[]) => void): void;
  off?(event: string, cb: (...args: any[]) => void): void;
  flow(flow: string): void;
  themes: {
    fontSize(size: string): void;
    font(family: string): void;
    override(prop: string, value: string): void;
    register(name: string, styles: Record<string, any>): void;
    select(name: string): void;
  };
  getContents(): Array<{ document: Document }>;
  currentLocation(): any;
}

type PositionListener = (pos: ReadingPosition) => void;
type BoundaryListener = (dir: 'next' | 'prev') => void;

export interface EpubEngineOptions {
  bookId: string;
  /** EPUB 文件 URL */
  fileUrl: string;
  /** 初始 CFI（进度恢复） */
  initialCfi?: string | null;
  /** 阅读模式 */
  mode?: 'paginated' | 'scroll';
  /** 字体大小 px */
  fontSize?: number;
  /** 行高 */
  lineHeight?: number;
  /** 字间距 em */
  letterSpacing?: number;
  /** 字体族 */
  fontFamily?: string;
}

export class EpubEngine implements ReaderEngine {
  readonly format: BookFormat = 'epub';

  private container: HTMLElement | null = null;
  private book: EpubBook | null = null;
  private rendition: EpubRendition | null = null;
  private options: EpubEngineOptions;

  // 状态
  private chapter: Chapter | null = null;
  private chapterIndex = 0;
  private currentCfi: string | null = null;
  private currentRatio = 0;
  private spineLength = 0;

  // 事件
  private positionListeners = new Set<PositionListener>();
  private boundaryListeners = new Set<BoundaryListener>();

  constructor(options: EpubEngineOptions) {
    this.options = options;
  }

  // ── 生命周期 ──────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;
  }

  unmount(): void {
    if (this.rendition) {
      this.rendition.destroy();
      this.rendition = null;
    }
    if (this.book) {
      this.book.destroy();
      this.book = null;
    }
    this.container = null;
    this.positionListeners.clear();
    this.boundaryListeners.clear();
  }

  /** 初始化 epub.js book + rendition（异步，需在 mount 后调用） */
  async init(): Promise<void> {
    if (!this.container) throw new Error('EpubEngine: mount() must be called before init()');

    const ePub = (await import('epubjs')).default;
    const { getToken } = await import('../../services/authService');

    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    this.book = ePub(this.options.fileUrl, { requestHeaders: headers }) as unknown as EpubBook;
    await this.book.ready;
    this.spineLength = this.book.spine?.length ?? 0;

    this.rendition = (this.book as any).renderTo(this.container, {
      width: '100%',
      height: '100%',
      flow: this.options.mode === 'scroll' ? 'scrolled-doc' : 'paginated',
      allowScriptedContent: true,
    }) as unknown as EpubRendition;

    // 应用排版
    this.applyTypography();

    // 监听 relocated 事件 → 位置变化
    this.rendition.on('relocated', (location: any) => {
      this.handleRelocated(location);
    });

    // 显示初始位置
    const target = this.options.initialCfi || undefined;
    await this.rendition.display(target);
  }

  // ── 章节加载 ──────────────────────────────────────────

  async loadChapter(chapter: Chapter, position?: ReadingPosition): Promise<void> {
    this.chapter = chapter;
    this.chapterIndex = chapter.order;

    if (!this.rendition) return;

    const target = position?.cfi || chapter.href || undefined;
    await this.rendition.display(target);

    if (position) {
      this.currentCfi = position.cfi ?? null;
      this.currentRatio = position.ratio;
    }
  }

  // ── 分页模式 ──────────────────────────────────────────

  getPageCount(): number {
    // EPUB 由 epub.js 内部管理页数，外部无法精确获取
    // 返回 spine 长度作为粗略估计
    return Math.max(1, this.spineLength);
  }

  getCurrentPage(): number {
    return this.chapterIndex;
  }

  goToPage(page: number): void {
    const target = Math.max(0, Math.min(page, this.spineLength - 1));
    this.rendition?.display(String(target));
  }

  nextPage(): boolean {
    if (!this.rendition) return false;
    this.rendition.next();
    return true;
  }

  prevPage(): boolean {
    if (!this.rendition) return false;
    this.rendition.prev();
    return true;
  }

  // ── 滚动模式 ──────────────────────────────────────────

  scrollToRatio(ratio: number): void {
    // EPUB scrolled-doc 模式下，通过 CFI 定位
    // 简化实现：使用 rendition.display 跳转到对应 spine 位置
    if (!this.rendition || this.spineLength === 0) return;
    const spineIdx = Math.round(ratio * (this.spineLength - 1));
    this.rendition.display(String(spineIdx));
  }

  getScrollRatio(): number {
    return this.currentRatio;
  }

  // ── 文本提取 ──────────────────────────────────────────

  getVisibleText(): string {
    if (!this.rendition) return '';
    try {
      const contents = this.rendition.getContents();
      if (!contents.length) return '';
      const doc = contents[0].document;
      return doc?.body?.textContent ?? '';
    } catch {
      return '';
    }
  }

  async getFullChapterText(): Promise<string> {
    return this.getVisibleText();
  }

  // ── 事件订阅 ──────────────────────────────────────────

  onPositionChange(cb: PositionListener): () => void {
    this.positionListeners.add(cb);
    return () => { this.positionListeners.delete(cb); };
  }

  onChapterBoundary(cb: BoundaryListener): () => void {
    this.boundaryListeners.add(cb);
    return () => { this.boundaryListeners.delete(cb); };
  }

  // ── 排版控制 ──────────────────────────────────────────

  setMode(mode: 'paginated' | 'scroll'): void {
    this.options.mode = mode;
    this.rendition?.flow(mode === 'scroll' ? 'scrolled-doc' : 'paginated');
  }

  setTypography(opts: { fontSize?: number; lineHeight?: number; letterSpacing?: number; fontFamily?: string }): void {
    Object.assign(this.options, opts);
    this.applyTypography();
  }

  // ── 内部 ──────────────────────────────────────────────

  private applyTypography(): void {
    if (!this.rendition) return;
    const { fontSize = 18, lineHeight = 1.8, letterSpacing = 0, fontFamily } = this.options;
    this.rendition.themes.fontSize(`${fontSize}px`);
    if (fontFamily) this.rendition.themes.font(fontFamily);
    this.rendition.themes.override('line-height', String(lineHeight));
    this.rendition.themes.override('letter-spacing', `${letterSpacing}em`);
  }

  private handleRelocated(location: any): void {
    if (!location) return;

    // 提取 CFI
    const cfi = location.end?.cfi ?? location.start?.cfi ?? null;
    this.currentCfi = cfi;

    // 计算 ratio（章节内进度）
    const ratio = location.end?.percentage ?? location.start?.percentage ?? 0;
    this.currentRatio = ratio;

    // 检测章节边界
    if (location.end?.index != null) {
      const newIdx = location.end.index;
      if (newIdx !== this.chapterIndex) {
        const dir = newIdx > this.chapterIndex ? 'next' : 'prev';
        this.chapterIndex = newIdx;
        this.boundaryListeners.forEach((cb) => cb(dir));
      }
    }

    // 广播位置变化
    this.emitPositionChange();
  }

  private emitPositionChange(): void {
    if (!this.positionListeners.size) return;
    const pos: ReadingPosition = {
      bookId: this.options.bookId,
      chapterId: this.chapter?.id ?? `spine-${this.chapterIndex}`,
      chapterIndex: this.chapterIndex,
      cfi: this.currentCfi ?? undefined,
      ratio: this.currentRatio,
      timestamp: Date.now(),
    };
    this.positionListeners.forEach((cb) => cb(pos));
  }
}
