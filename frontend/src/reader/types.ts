/**
 * 阅读器共享类型定义
 * ReaderEngine / ReadingPosition / UI 层共同消费的基础模型。
 */

/** 书籍格式 */
export type BookFormat = 'txt' | 'epub';

/** 章节信息（阅读器引擎消费的统一章节模型） */
export interface Chapter {
  id: string;
  title: string;
  /** 章节排序序号（0-based） */
  order: number;
  /** EPUB spine href（仅 EPUB） */
  href?: string;
  /** TXT 章节在全文中的起始字符偏移（仅 TXT） */
  startOffset?: number;
}
