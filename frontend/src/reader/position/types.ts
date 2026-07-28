/**
 * ReadingPosition —— 唯一阅读进度模型
 *
 * 设计原则：
 *   - 所有组件只通过 useReadingPosition() 读写位置，不允许绕过
 *   - 写入自动触发持久化（由 useProgressPersistence 统一 debounce）
 *   - TTS 起点 = position.ratio * totalSegments，不再有多路启发式
 */

export interface ReadingPosition {
  bookId: string;
  chapterId: string;
  /** 章节在目录中的索引（0-based） */
  chapterIndex: number;

  // ── 分页模式字段 ─────────────────────────────────────
  /** 当前页码（0-based） */
  page?: number;
  /** 总页数 */
  pageCount?: number;

  // ── 滚动模式字段 ─────────────────────────────────────
  /** 滚动比例 0~1 */
  scrollRatio?: number;

  // ── TTS 字段 ─────────────────────────────────────────
  /** TTS 当前分段索引（用于恢复朗读位置） */
  textOffset?: number;

  // ── EPUB 专属字段 ────────────────────────────────────
  /** EPUB CFI 定位字符串（精确到段落/字符） */
  cfi?: string;

  // ── 跨模式统一字段 ───────────────────────────────────
  /**
   * 归一化进度比例 0~1。
   * 分页模式：page / (pageCount - 1)
   * 滚动模式：scrollRatio
   * EPUB：由 rendition 位置推算
   * 用途：TTS 起点推算、进度条显示、跨模式恢复
   */
  ratio: number;

  /** 位置更新时间戳（Unix ms） */
  timestamp: number;
}

/**
 * 创建完整 ReadingPosition 的输入（timestamp 可省略，自动生成）。
 * 用于章节切换、初始加载等需要设置完整位置的场景。
 */
export type ReadingPositionInput = Omit<ReadingPosition, 'timestamp'> & {
  timestamp?: number;
};

/**
 * 部分更新输入（翻页、滚动等高频操作）。
 * 至少包含一个位置字段，timestamp 自动生成。
 */
export type ReadingPositionUpdate = Partial<Omit<ReadingPosition, 'timestamp'>> & {
  timestamp?: number;
};
