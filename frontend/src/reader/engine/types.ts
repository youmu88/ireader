/**
 * ReaderEngine 接口（策略模式）
 *
 * TXT 和 EPUB 各自实现此接口，上层 UI / 手势 / TTS 不感知格式差异。
 * 设计原则：
 *   - 分页由浏览器负责，JS 只读取 DOM 测量结果（不再估算）
 *   - 位置变化通过 onPositionChange 事件向上层广播
 *   - 章节边界通过 onChapterBoundary 事件通知（触发跨章加载）
 */
import type { BookFormat, Chapter } from '../types';
import type { ReadingPosition } from '../position/types';

export interface ReaderEngine {
  /** 当前引擎对应的书籍格式 */
  readonly format: BookFormat;

  // ── 生命周期 ──────────────────────────────────────────

  /** 挂载到 DOM 容器（调用一次） */
  mount(container: HTMLElement): void;
  /** 卸载并释放全部资源（DOM 监听、ResizeObserver 等） */
  unmount(): void;

  // ── 章节加载 ──────────────────────────────────────────

  /**
   * 加载章节内容。
   * @param chapter  目标章节
   * @param position 可选，恢复到指定阅读位置（跨章跳转时传入）
   */
  loadChapter(chapter: Chapter, position?: ReadingPosition): Promise<void>;

  // ── 分页模式（翻页阅读） ─────────────────────────────

  /** 当前章节总页数（DOM 测量，非估算） */
  getPageCount(): number;
  /** 当前页码（0-based） */
  getCurrentPage(): number;
  /** 跳转到指定页（clamp 到合法范围） */
  goToPage(page: number): void;
  /** 翻到下一页，返回是否成功（false = 已是最后一页） */
  nextPage(): boolean;
  /** 翻到上一页，返回是否成功（false = 已是第一页） */
  prevPage(): boolean;

  // ── 滚动模式 ─────────────────────────────────────────

  /** 滚动到指定比例位置（0~1） */
  scrollToRatio(ratio: number): void;
  /** 获取当前滚动比例（0~1） */
  getScrollRatio(): number;

  // ── 文本提取（TTS 消费） ─────────────────────────────

  /** 获取当前视口可见文本 */
  getVisibleText(): string;
  /** 获取当前章节完整文本（异步，EPUB 可能需要 DOM 查询） */
  getFullChapterText(): Promise<string>;

  // ── 事件订阅 ─────────────────────────────────────────

  /**
   * 订阅阅读位置变化（翻页 / 滚动 / 跳转均触发）。
   * @returns 取消订阅函数
   */
  onPositionChange(cb: (pos: ReadingPosition) => void): () => void;

  /**
   * 订阅章节边界事件（翻到章末 / 章首时触发）。
   * @param dir 'next' = 到达章末需加载下一章, 'prev' = 到达章首需加载上一章
   * @returns 取消订阅函数
   */
  onChapterBoundary(cb: (dir: 'next' | 'prev') => void): () => void;
}
