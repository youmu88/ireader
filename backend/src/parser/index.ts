import crypto from 'crypto';
import { parseEpub, normalizeHtmlText } from './epub.js';
import { parseTxt, getChapterContent } from './txt.js';

export { parseEpub, parseTxt, getChapterContent, normalizeHtmlText };
export type { EpubParseResult, EpubMeta, EpubChapter } from './epub.js';
export type { TxtParseResult, TxtMeta, TxtChapter } from './txt.js';

/**
 * ChapterManifest — 统一章节模型
 * 所有模块（阅读渲染、TTS、缓存、离线包）的唯一章节事实来源。
 * 任何模块不得再自行从原始文件解析章节标题、锚点或文本。
 */
export interface ChapterManifest {
  title: string;
  href: string | null;
  fragment: string | null;
  spineIndex: number | null;
  normalizedText: string | null;
  contentHash: string | null;
  startOffset: number | null;
  endOffset: number | null;
  order: number;
  level: number;
}

/**
 * Parse a book file based on its format.
 * EPUB: 解析器直接产出 normalizedText + contentHash。
 * TXT:  解析时同步计算 normalizedText + contentHash，上传即持久化。
 */
export async function parseBook(
  filePath: string,
  format: 'epub' | 'txt',
  outputDir: string,
): Promise<{
  title: string;
  author: string | null;
  chapters: ChapterManifest[];
  coverPath?: string;
}> {
  if (format === 'epub') {
    const result = await parseEpub(filePath, outputDir);
    return {
      title: result.meta.title,
      author: result.meta.author,
      chapters: result.chapters.map((ch): ChapterManifest => ({
        title: ch.title,
        href: ch.href,
        fragment: ch.fragment,
        spineIndex: ch.spineIndex,
        normalizedText: ch.normalizedText || null,
        contentHash: ch.contentHash || null,
        startOffset: null,
        endOffset: null,
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
      chapters: result.chapters.map((ch): ChapterManifest => {
        const text = getChapterContent(result.content, ch.startOffset, ch.endOffset);
        return {
          title: ch.title,
          href: null,
          fragment: null,
          spineIndex: null,
          normalizedText: text,
          contentHash: crypto.createHash('sha256').update(text, 'utf-8').digest('hex'),
          startOffset: ch.startOffset,
          endOffset: ch.endOffset,
          order: ch.order,
          level: ch.level,
        };
      }),
    };
  }
}