/**
 * Content Cache Service
 * 管理书籍内容缓存：缓存全书或 N 章节内容到数据库
 * 支持按用户隔离
 */
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { bookContentCache, bookChapters, books } from '../db/schema.js';
import { parseTxt, getChapterContent, normalizeHtmlText } from '../parser/index.js';
import path from 'path';
import fs from 'fs';

// ===== 类型定义 =====

export interface ContentCacheEntry {
  id: string;
  userId: string;
  bookId: string;
  chapterId: string | null;
  content: string;
  cacheType: 'full_book' | 'chapter' | 'partial';
  createdAt: string;
  updatedAt: string;
}

// ===== 缓存全书 =====

/**
 * 缓存整本书的所有章节内容到数据库
 * 遍历所有章节，逐章获取内容并写入 book_content_cache 表
 */
export async function cacheFullBook(
  db: any,
  bookId: string,
  userId: string,
  dataDir: string,
): Promise<{ cached: number; failed: number }> {
  const book = db.select().from(books).where(sql`id = ${bookId} AND user_id = ${userId}`).get();
  if (!book) throw new Error('图书不存在');

  const chapters = db.select().from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .orderBy(bookChapters.order)
    .all();

  let cached = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const chapter of chapters) {
    try {
      // P1-2: 优先消费 DB 中的 normalizedText（ChapterManifest 统一产出）
      let content = (chapter as any).normalizedText || '';

      // 遗留数据兜底：normalizedText 为空时从文件读取
      if (!content) {
        if (book.format === 'txt') {
          if (chapter.startOffset != null) {
            const parseResult = parseTxt(book.filePath);
            content = getChapterContent(parseResult.content, chapter.startOffset, chapter.endOffset || parseResult.content.length);
          }
        } else if (chapter.href) {
          const extractedDir = path.resolve(path.dirname(book.filePath), 'extracted');
          const hrefPath = chapter.href.split('#')[0];
          const extractedPath = path.resolve(extractedDir, hrefPath);
          const isInsideExtractedDir = extractedPath.startsWith(`${extractedDir}${path.sep}`);
          if (isInsideExtractedDir && fs.existsSync(extractedPath)) {
            content = normalizeHtmlText(fs.readFileSync(extractedPath, 'utf-8'));
          }
        }
      }

      if (!content) {
        failed++;
        continue;
      }

      // Upsert: 检查是否已有该章节的缓存
      const existing = db.select().from(bookContentCache)
        .where(sql`book_id = ${bookId} AND chapter_id = ${chapter.id} AND user_id = ${userId}`)
        .get();

      if (existing) {
        db.update(bookContentCache)
          .set({ content, updatedAt: now })
          .where(sql`id = ${existing.id}`)
          .run();
      } else {
        db.insert(bookContentCache).values({
          id: uuidv4(),
          userId,
          bookId,
          chapterId: chapter.id,
          content,
          cacheType: 'full_book',
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      cached++;
    } catch {
      failed++;
    }
  }

  return { cached, failed };
}

// ===== 缓存 N 章节 =====

/**
 * 缓存指定数量的章节内容
 * @param count 要缓存的章节数（从第1章开始）
 */
export async function cacheNChapters(
  db: any,
  bookId: string,
  userId: string,
  dataDir: string,
  count: number,
): Promise<{ cached: number; failed: number }> {
  const book = db.select().from(books).where(sql`id = ${bookId} AND user_id = ${userId}`).get();
  if (!book) throw new Error('图书不存在');

  const chapters = db.select().from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .orderBy(bookChapters.order)
    .limit(count)
    .all();

  let cached = 0;
  let failed = 0;
  const now = new Date().toISOString();

  for (const chapter of chapters) {
    try {
      // P1-2: 优先消费 DB 中的 normalizedText（ChapterManifest 统一产出）
      let content = (chapter as any).normalizedText || '';

      // 遗留数据兜底
      if (!content) {
        if (book.format === 'txt') {
          if (chapter.startOffset != null) {
            const parseResult = parseTxt(book.filePath);
            content = getChapterContent(parseResult.content, chapter.startOffset, chapter.endOffset || parseResult.content.length);
          }
        } else if (chapter.href) {
          const extractedDir = path.resolve(path.dirname(book.filePath), 'extracted');
          const hrefPath = chapter.href.split('#')[0];
          const extractedPath = path.resolve(extractedDir, hrefPath);
          const isInsideExtractedDir = extractedPath.startsWith(`${extractedDir}${path.sep}`);
          if (isInsideExtractedDir && fs.existsSync(extractedPath)) {
            content = normalizeHtmlText(fs.readFileSync(extractedPath, 'utf-8'));
          }
        }
      }

      if (!content) { failed++; continue; }

      const existing = db.select().from(bookContentCache)
        .where(sql`book_id = ${bookId} AND chapter_id = ${chapter.id} AND user_id = ${userId}`)
        .get();

      if (existing) {
        db.update(bookContentCache)
          .set({ content, updatedAt: now })
          .where(sql`id = ${existing.id}`)
          .run();
      } else {
        db.insert(bookContentCache).values({
          id: uuidv4(),
          userId,
          bookId,
          chapterId: chapter.id,
          content,
          cacheType: 'partial',
          createdAt: now,
          updatedAt: now,
        }).run();
      }
      cached++;
    } catch {
      failed++;
    }
  }

  return { cached, failed };
}

// ===== 获取缓存内容 =====

/**
 * 获取指定章节的缓存内容
 */
export function getCachedChapterContent(
  db: any,
  bookId: string,
  chapterId: string,
  userId: string,
): string | null {
  const entry = db.select().from(bookContentCache)
    .where(sql`book_id = ${bookId} AND chapter_id = ${chapterId} AND user_id = ${userId}`)
    .get();
  return entry?.content || null;
}

/**
 * 获取书籍的缓存统计信息
 */
export function getBookCacheStats(
  db: any,
  bookId: string,
  userId: string,
): { cachedChapters: number; totalChapters: number; cacheType: string | null } {
  const totalChapters = db.select({ count: sql<number>`count(*)` }).from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .get()?.count ?? 0;

  const cachedCount = db.select({ count: sql<number>`count(*)` }).from(bookContentCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .get()?.count ?? 0;

  const firstEntry = db.select().from(bookContentCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .limit(1)
    .get();

  return {
    cachedChapters: cachedCount,
    totalChapters,
    cacheType: firstEntry?.cacheType || null,
  };
}

// ===== 清除缓存 =====

/**
 * 清除指定书籍的内容缓存
 */
export function clearBookContentCache(
  db: any,
  bookId: string,
  userId: string,
): number {
  const entries = db.select().from(bookContentCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .all();
  for (const entry of entries) {
    db.delete(bookContentCache).where(sql`id = ${entry.id}`).run();
  }
  return entries.length;
}