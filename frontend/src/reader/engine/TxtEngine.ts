/**
 * TxtEngine —— TXT 阅读器引擎（实现 ReaderEngine 接口）
 *
 * 核心设计：
 *   - 分页模式：CSS multi-column + 横向滚动，页数由 DOM scrollWidth 测量（非估算）
 *   - 滚动模式：纵向滚动，比例由 scrollTop / scrollableHeight 计算
 *   - ResizeObserver + fonts.ready 监听，窗口/字体变化后重新测量并保持 ratio 不变
 *   - 章节边界事件：翻到最后一页再 next → 触发 'next'；第一页再 prev → 触发 'prev'
 */
import type { ReaderEngine } from './types';
import type { BookFormat, Chapter } from '../types';
import type { ReadingPosition } from '../position/types';

// ── 类型 ─────────────────────────────────────────────────

export type TxtReadingMode = 'paginated' | 'scroll';

export interface TxtEngineOptions {
  bookId: string;
  /** 初始阅读模式 */
  mode?: TxtReadingMode;
  /** 字体大小（px） */
  fontSize?: number;
  /** 行高倍数 */
  lineHeight?: number;
  /** 字间距（em） */
  letterSpacing?: number;
  /** 字体族 */
  fontFamily?: string;
}

type PositionListener = (pos: ReadingPosition) => void;
type BoundaryListener = (dir: 'next' | 'prev') => void;

// ── 实现 ─────────────────────────────────────────────────

export class TxtEngine implements ReaderEngine {
  readonly format: BookFormat = 'txt';

  private container: HTMLElement | null = null;
  private contentEl: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;

  private mode: TxtReadingMode;
  private bookId: string;
  private chapter: Chapter | null = null;
  private chapterIndex = 0;
  private chapterText = '';

  // 分页状态
  private currentPage = 0;
  private pageCount = 1;

  // 事件
  private positionListeners = new Set<PositionListener>();
  private boundaryListeners = new Set<BoundaryListener>();

  // 观察器
  private resizeObserver: ResizeObserver | null = null;
  private scrollHandler: (() => void) | null = null;
  private scrollRaf = 0;

  // 样式配置
  private fontSize: number;
  private lineHeight: number;
  private letterSpacing: number;
  private fontFamily: string;

  constructor(options: TxtEngineOptions) {
    this.bookId = options.bookId;
    this.mode = options.mode ?? 'scroll';
    this.fontSize = options.fontSize ?? 18;
    this.lineHeight = options.lineHeight ?? 1.8;
    this.letterSpacing = options.letterSpacing ?? 0;
    this.fontFamily = options.fontFamily ?? 'system-ui, sans-serif';
  }

  // ── 生命周期 ──────────────────────────────────────────

  mount(container: HTMLElement): void {
    this.container = container;

    // 创建滚动容器
    this.scrollEl = document.createElement('div');
    this.scrollEl.className = 'txt-engine-scroll';
    this.applyScrollStyles();

    // 创建内容容器
    this.contentEl = document.createElement('div');
    this.contentEl.className = 'txt-engine-content';
    this.applyContentStyles();

    this.scrollEl.appendChild(this.contentEl);
    container.appendChild(this.scrollEl);

    // ResizeObserver：窗口/容器尺寸变化时重新测量
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(container);

    // 字体加载完成后重新测量
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready.then(() => this.handleResize());
    }

    // 滚动模式：监听 scroll 事件
    this.setupScrollListener();
  }

  unmount(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.teardownScrollListener();
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.scrollEl && this.container) {
      this.container.removeChild(this.scrollEl);
    }
    this.container = null;
    this.scrollEl = null;
    this.contentEl = null;
    this.positionListeners.clear();
    this.boundaryListeners.clear();
  }

  // ── 章节加载 ──────────────────────────────────────────

  async loadChapter(chapter: Chapter, position?: ReadingPosition): Promise<void> {
    this.chapter = chapter;
    this.chapterIndex = chapter.order;

    // 获取章节文本（由外部通过 setChapterText 注入，或从 DOM 读取）
    if (this.contentEl) {
      this.renderContent();
    }

    // 等待一帧让浏览器完成布局
    await this.nextFrame();

    // 测量页数
    this.measurePages();

    // 恢复位置
    if (position) {
      this.restorePosition(position);
    } else {
      this.currentPage = 0;
      if (this.mode === 'paginated') {
        this.scrollToPage(0);
      } else if (this.scrollEl) {
        this.scrollEl.scrollTop = 0;
      }
    }

    this.emitPositionChange();
  }

  /** 设置章节纯文本内容（由外部调用，分离数据获取与渲染） */
  setChapterText(text: string): void {
    this.chapterText = text;
    if (this.contentEl) {
      this.renderContent();
    }
  }

  // ── 分页模式 ──────────────────────────────────────────

  getPageCount(): number {
    return this.pageCount;
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  goToPage(page: number): void {
    const target = Math.max(0, Math.min(page, this.pageCount - 1));
    if (target === this.currentPage) return;
    this.currentPage = target;
    this.scrollToPage(target);
    this.emitPositionChange();
  }

  nextPage(): boolean {
    if (this.currentPage >= this.pageCount - 1) {
      this.emitBoundary('next');
      return false;
    }
    this.goToPage(this.currentPage + 1);
    return true;
  }

  prevPage(): boolean {
    if (this.currentPage <= 0) {
      this.emitBoundary('prev');
      return false;
    }
    this.goToPage(this.currentPage - 1);
    return true;
  }

  // ── 滚动模式 ──────────────────────────────────────────

  scrollToRatio(ratio: number): void {
    if (!this.scrollEl) return;
    const clamped = Math.max(0, Math.min(1, ratio));
    const scrollable = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    this.scrollEl.scrollTop = clamped * scrollable;
  }

  getScrollRatio(): number {
    if (!this.scrollEl) return 0;
    const scrollable = this.scrollEl.scrollHeight - this.scrollEl.clientHeight;
    if (scrollable <= 0) return 0;
    return this.scrollEl.scrollTop / scrollable;
  }

  // ── 文本提取 ──────────────────────────────────────────

  getVisibleText(): string {
    if (!this.contentEl) return '';
    // 分页模式：返回当前页可见区域的文本
    // 简化实现：返回全文（后续可优化为 IntersectionObserver 精确提取）
    return this.chapterText;
  }

  async getFullChapterText(): Promise<string> {
    return this.chapterText;
  }

  // ── 事件订阅 ──────────────────────────────────────────

  onPositionChange(cb: PositionListener): () => void {
    this.positionListeners.add(cb);
    return () => this.positionListeners.delete(cb);
  }

  onChapterBoundary(cb: BoundaryListener): () => void {
    this.boundaryListeners.add(cb);
    return () => this.boundaryListeners.delete(cb);
  }

  // ── 模式切换 ──────────────────────────────────────────

  setMode(mode: TxtReadingMode): void {
    if (mode === this.mode) return;
    const ratio = this.getCurrentRatio();
    this.mode = mode;
    this.applyScrollStyles();
    this.applyContentStyles();
    this.teardownScrollListener();
    this.setupScrollListener();
    // 保持阅读位置
    this.nextFrame().then(() => {
      this.measurePages();
      this.restoreRatio(ratio);
      this.emitPositionChange();
    });
  }

  getMode(): TxtReadingMode {
    return this.mode;
  }

  // ── 样式配置 ──────────────────────────────────────────

  setTypography(opts: { fontSize?: number; lineHeight?: number; letterSpacing?: number; fontFamily?: string }): void {
    if (opts.fontSize != null) this.fontSize = opts.fontSize;
    if (opts.lineHeight != null) this.lineHeight = opts.lineHeight;
    if (opts.letterSpacing != null) this.letterSpacing = opts.letterSpacing;
    if (opts.fontFamily != null) this.fontFamily = opts.fontFamily;

    const ratio = this.getCurrentRatio();
    this.applyContentStyles();
    this.nextFrame().then(() => {
      this.measurePages();
      this.restoreRatio(ratio);
      this.emitPositionChange();
    });
  }

  // ── 内部方法 ──────────────────────────────────────────

  private renderContent(): void {
    if (!this.contentEl) return;
    // 将纯文本按段落渲染为 <p> 元素
    const paragraphs = this.chapterText.split(/\n+/).filter(p => p.trim());
    this.contentEl.innerHTML = paragraphs
      .map(p => `<p>${this.escapeHtml(p.trim())}</p>`)
      .join('');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private applyScrollStyles(): void {
    if (!this.scrollEl) return;
    const s = this.scrollEl.style;
    s.width = '100%';
    s.height = '100%';
    s.position = 'relative';
    s.overflow = 'hidden';

    if (this.mode === 'paginated') {
      s.overflowX = 'auto';
      s.overflowY = 'hidden';
      s.scrollSnapType = 'x proximity';
      s.scrollbarWidth = 'none';
    } else {
      s.overflowX = 'hidden';
      s.overflowY = 'auto';
      s.scrollSnapType = 'none';
      s.scrollbarWidth = 'thin';
    }
  }

  private applyContentStyles(): void {
    if (!this.contentEl) return;
    const s = this.contentEl.style;
    s.fontSize = `${this.fontSize}px`;
    s.lineHeight = String(this.lineHeight);
    s.letterSpacing = `${this.letterSpacing}em`;
    s.fontFamily = this.fontFamily;
    s.wordWrap = 'break-word';
    s.overflowWrap = 'break-word';

    if (this.mode === 'paginated') {
      // CSS multi-column：每列宽度 = 容器宽度，实现一屏一页
      const containerWidth = this.scrollEl?.clientWidth || 0;
      s.columnWidth = `${containerWidth}px`;
      s.columnGap = '0px';
      s.columnFill = 'auto';
      s.height = '100%';
      s.width = 'auto';
    } else {
      s.columnWidth = 'auto';
      s.columnGap = 'normal';
      s.columnFill = 'balance';
      s.height = 'auto';
      s.width = '100%';
      s.padding = '1em';
      s.boxSizing = 'border-box';
    }
  }

  /** DOM 测量页数（核心：不估算，只读取浏览器排版结果） */
  private measurePages(): void {
    if (this.mode !== 'paginated' || !this.scrollEl) {
      this.pageCount = 1;
      return;
    }
    const pageWidth = this.scrollEl.clientWidth || 1;
    const totalWidth = this.scrollEl.scrollWidth;
    this.pageCount = Math.max(1, Math.ceil(totalWidth / pageWidth));
  }

  private scrollToPage(page: number): void {
    if (!this.scrollEl) return;
    const pageWidth = this.scrollEl.clientWidth || 1;
    this.scrollEl.scrollLeft = page * pageWidth;
  }

  private handleResize(): void {
    if (!this.scrollEl) return;
    const ratio = this.getCurrentRatio();
    // 重新应用 column 宽度（容器宽度可能变了）
    this.applyContentStyles();
    // 等一帧让浏览器重排
    this.nextFrame().then(() => {
      this.measurePages();
      this.restoreRatio(ratio);
      this.emitPositionChange();
    });
  }

  private getCurrentRatio(): number {
    if (this.mode === 'paginated') {
      return this.pageCount > 1 ? this.currentPage / (this.pageCount - 1) : 0;
    }
    return this.getScrollRatio();
  }

  private restoreRatio(ratio: number): void {
    if (this.mode === 'paginated') {
      const page = Math.round(ratio * (this.pageCount - 1));
      this.currentPage = Math.max(0, Math.min(page, this.pageCount - 1));
      this.scrollToPage(this.currentPage);
    } else {
      this.scrollToRatio(ratio);
    }
  }

  private restorePosition(pos: ReadingPosition): void {
    if (this.mode === 'paginated') {
      if (pos.page != null && pos.page < this.pageCount) {
        this.currentPage = pos.page;
      } else {
        this.currentPage = Math.round(pos.ratio * (this.pageCount - 1));
      }
      this.currentPage = Math.max(0, Math.min(this.currentPage, this.pageCount - 1));
      this.scrollToPage(this.currentPage);
    } else {
      const ratio = pos.scrollRatio ?? pos.ratio;
      this.scrollToRatio(ratio);
    }
  }

  private setupScrollListener(): void {
    if (this.mode !== 'scroll' || !this.scrollEl) return;
    this.scrollHandler = () => {
      if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = requestAnimationFrame(() => {
        this.emitPositionChange();
        // 检查是否滚动到底部（触发下一章）
        if (this.scrollEl) {
          const { scrollTop, scrollHeight, clientHeight } = this.scrollEl;
          if (scrollHeight - scrollTop - clientHeight < 50) {
            this.emitBoundary('next');
          } else if (scrollTop < 50) {
            this.emitBoundary('prev');
          }
        }
      });
    };
    this.scrollEl.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  private teardownScrollListener(): void {
    if (this.scrollHandler && this.scrollEl) {
      this.scrollEl.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
  }

  private buildPosition(): ReadingPosition {
    const ratio = this.getCurrentRatio();
    const pos: ReadingPosition = {
      bookId: this.bookId,
      chapterId: this.chapter?.id ?? '',
      chapterIndex: this.chapterIndex,
      ratio,
      timestamp: Date.now(),
    };

    if (this.mode === 'paginated') {
      pos.page = this.currentPage;
      pos.pageCount = this.pageCount;
    } else {
      pos.scrollRatio = ratio;
    }

    return pos;
  }

  private emitPositionChange(): void {
    const pos = this.buildPosition();
    this.positionListeners.forEach(cb => cb(pos));
  }

  private emitBoundary(dir: 'next' | 'prev'): void {
    this.boundaryListeners.forEach(cb => cb(dir));
  }

  private nextFrame(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }
}
