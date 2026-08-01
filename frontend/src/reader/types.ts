/**
 * 阅读器共享类型 — Apple Books 风格 EPUB 阅读器
 */

/** 阅读主题（对标 Apple Books 四色） */
export type ReaderTheme = 'white' | 'sepia' | 'gray' | 'black';

/** 阅读器设置 */
export interface ReaderSettings {
  /** 字号百分比（60-200，默认 100） */
  fontSize: number;
  /** 阅读主题 */
  theme: ReaderTheme;
  /** 行高 */
  lineHeight: number;
}

/** 目录项（自 epub.js navigation.toc 递归映射） */
export interface TocItem {
  id: string;
  label: string;
  href: string;
  subitems?: TocItem[];
}

/**
 * 阅读位置（relocated 事件映射）。
 * percentage / globalPage / totalPages 仅在 locations 生成完毕后填充，
 * 未就绪时 percentage 为 null —— 调用方不得在未就绪时将其作为全书进度持久化。
 */
export interface ReaderLocation {
  /** 当前 CFI（断点续读锚点，始终可用） */
  cfi: string;
  /** 全书进度 0-1（locations 就绪后可用，否则 null） */
  percentage: number | null;
  /** 当前章节 href */
  chapterHref?: string;
  /** 章节内页码（1-based） */
  pageInChapter: number;
  /** 章节总页数 */
  pagesInChapter: number;
  /** 全局页码（1-based，locations 就绪后可用） */
  globalPage?: number;
  /** 全书总页数（locations 就绪后可用） */
  totalPages?: number;
}
