import fs from 'fs';
import iconv from 'iconv-lite';

const CHAPTER_PATTERNS = [
  /^第[一二三四五六七八九十百千万零０１２３４５６７８９0-9]+[章回节部集]/,
  /^Chapter\s+\d+/i,
  /^\d+\.\s+/,
];

export interface TxtMeta {
  title: string;
  author: string | null;
}

export interface TxtChapter {
  id: string;
  title: string;
  startOffset: number;
  endOffset: number;
  order: number;
  level: number;
}

export interface TxtParseResult {
  meta: TxtMeta;
  chapters: TxtChapter[];
  content: string;
  encoding: string;
}

/**
 * Detect file encoding, try UTF-8 first then GBK/GB18030
 */
function detectEncoding(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  // Try UTF-8 first
  try {
    const decoded = iconv.decode(buf, 'utf-8');
    // Check if decoded string has replacement characters
    if (!decoded.includes('\uFFFD') && decoded.indexOf('\u0000') === -1) {
      return 'utf-8';
    }
  } catch { /* fall through */ }

  // Try GBK
  try {
    const decoded = iconv.decode(buf, 'gbk');
    if (decoded.indexOf('\u0000') === -1) {
      return 'gbk';
    }
  } catch { /* fall through */ }

  // Try GB18030 as last resort
  return 'gb18030';
}

/**
 * Parse TXT file and detect chapters
 */
export function parseTxt(filePath: string): TxtParseResult {
  const encoding = detectEncoding(filePath);
  const buf = fs.readFileSync(filePath);
  const content = iconv.decode(buf, encoding);

  const lines = content.split(/\r?\n/);
  const chapters: TxtChapter[] = [];

  // First, try to find filename-based title
  const fileName = filePath.replace(/\.txt$/i, '').split(/[/\\]/).pop() || 'Untitled';
  let title = fileName;
  let author: string | null = null;

  // Check first few lines for title/author
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const authorMatch = line.match(/^(?:作者|作\s*者|原著|Author)[：:]\s*(.+)/i);
    if (authorMatch) {
      author = authorMatch[1].trim();
      continue;
    }

    // Use first non-empty, non-author line as title if it's short
    if (title === fileName && line.length < 50 && !CHAPTER_PATTERNS.some(p => p.test(line))) {
      title = line;
    }
  }

  // Detect chapters
  let chapterOrder = 0;

  // Check if we can detect chapter boundaries
  let hasChapterMarkers = false;

  // Track position using character index (content.indexOf returns char index)
  let currentCharOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineStart = content.indexOf(lines[i], currentCharOffset);
    if (lineStart === -1) {
      // Skip lines not found in content (e.g. empty strings)
      currentCharOffset += lines[i].length + 1;
      continue;
    }

    const matched = CHAPTER_PATTERNS.some(p => p.test(line));

    if (matched) {
      hasChapterMarkers = true;

      if (chapters.length > 0) {
        chapters[chapters.length - 1].endOffset = lineStart;
      }

      chapterOrder++;
      chapters.push({
        id: `ch-${chapterOrder}`,
        title: line,
        startOffset: lineStart,
        endOffset: content.length,
        order: chapterOrder,
        level: 1,
      });
    }

    currentCharOffset = lineStart + lines[i].length + 1;
  }

  // If no chapter markers found, split by fixed size
  if (!hasChapterMarkers) {
    chapters.length = 0;
    const chunkSize = 5000; // characters per virtual chapter
    let offset = 0;
    let order = 0;

    while (offset < content.length) {
      order++;
      const end = Math.min(offset + chunkSize, content.length);
      // Try to break at a newline
      const newlineBreak = content.lastIndexOf('\n', end);
      const actualEnd = (newlineBreak > offset && newlineBreak > end - 200) ? newlineBreak : end;

      chapters.push({
        id: `ch-${order}`,
        title: `第${order}部分`,
        startOffset: offset,
        endOffset: actualEnd,
        order,
        level: 1,
      });

      offset = actualEnd + 1;
    }
  }

  return {
    meta: { title, author },
    chapters,
    content,
    encoding,
  };
}

/**
 * Get chapter content by offset range
 */
export function getChapterContent(fullContent: string, startOffset: number, endOffset: number): string {
  return fullContent.slice(startOffset, Math.min(endOffset, fullContent.length));
}
