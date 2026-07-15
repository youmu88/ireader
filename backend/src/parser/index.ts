import { parseEpub, type EpubParseResult } from './epub.js';
import { parseTxt, getChapterContent, type TxtParseResult } from './txt.js';

export { parseEpub, parseTxt, getChapterContent };
export type { EpubParseResult, EpubMeta, EpubChapter } from './epub.js';
export type { TxtParseResult, TxtMeta, TxtChapter } from './txt.js';

/**
 * Parse a book file based on its format
 */
export async function parseBook(
  filePath: string,
  format: 'epub' | 'txt',
  outputDir: string,
): Promise<{
  title: string;
  author: string | null;
  chapters: Array<{
    title: string;
    href?: string;
    fragment?: string | null;
    spineIndex?: number | null;
    normalizedText?: string | null;
    contentHash?: string | null;
    startOffset?: number;
    endOffset?: number;
    order: number;
    level: number;
  }>;
  coverPath?: string;
}> {
  if (format === 'epub') {
    const result = await parseEpub(filePath, outputDir);
    return {
      title: result.meta.title,
      author: result.meta.author,
      chapters: result.chapters.map((ch) => ({
        title: ch.title,
        href: ch.href,
        fragment: ch.fragment,
        spineIndex: ch.spineIndex,
        normalizedText: ch.normalizedText,
        contentHash: ch.contentHash,
        order: ch.order,
        level: ch.level,
      })),
      coverPath: result.meta.coverPath || undefined,
    };
  } else {
    const result = parseTxt(filePath);
    return {
      title: result.meta.title,
      author: result.meta.author,
      chapters: result.chapters.map((ch) => ({
        title: ch.title,
        startOffset: ch.startOffset,
        endOffset: ch.endOffset,
        order: ch.order,
        level: ch.level,
      })),
    };
  }
}