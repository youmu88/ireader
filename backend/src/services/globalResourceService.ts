/**
 * Global Resource Service
 * 全局资源管理：书籍和 TTS 语音的引用计数 + 自动清理
 * 
 * 核心原则：
 * - 相同 fileHash 的书籍全局只存一份物理文件（global_books）
 * - 相同 textHash+voice+speed+bookId 的 TTS 音频全局只存一份（tts_global_resources）
 * - 用户通过引用表（user_book_refs / tts_refs）关联到全局资源
 * - 引用归零后，标记 deleted_at，30天后定时清理物理文件
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import {
  globalBooks,
  userBookRefs,
  ttsGlobalResources,
  ttsRefs,
  books,
  bookChapters,
  readingProgress,
  ttsGenerationJobs,
  ttsCache,
  bookContentCache,
  voiceCache,
} from '../db/schema.js';

// ===== 类型定义 =====

export interface CleanupResult {
  booksDeleted: number;
  ttsResourcesDeleted: number;
  filesDeleted: number;
}

// ===== 书籍全局资源管理 =====

/**
 * 计算文件 SHA256 哈希（流式读取，适合大文件）
 */
export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * 查询全局书库中是否有相同 hash 的书籍
 */
export function findGlobalBookByHash(db: any, fileHash: string): any {
  return db.select()
    .from(globalBooks)
    .where(sql`file_hash = ${fileHash} AND deleted_at IS NULL`)
    .get() || null;
}

/**
 * 创建全局书籍记录
 */
export function createGlobalBook(
  db: any,
  fileHash: string,
  title: string,
  author: string | null,
  format: 'epub' | 'txt',
  filePath: string,
  coverPath: string | null,
  size: number,
): any {
  const now = new Date().toISOString();
  const id = uuidv4();
  db.insert(globalBooks).values({
    id,
    fileHash,
    title,
    author,
    format,
    filePath,
    coverPath,
    size,
    createdAt: now,
    deletedAt: null,
  }).run();
  return { id, fileHash, title, author, format, filePath, coverPath, size, createdAt: now };
}

/**
 * 为用户创建书籍引用（local_book + ref）
 */
export function createUserBookRef(
  db: any,
  userId: string,
  globalBookId: string,
  localBookId: string,
): any {
  const now = new Date().toISOString();
  const id = uuidv4();
  db.insert(userBookRefs).values({
    id,
    userId,
    globalBookId,
    localBookId,
    refCount: 1,
    deletedAt: null,
    createdAt: now,
  }).run();
  return { id, userId, globalBookId, localBookId, refCount: 1 };
}

/**
 * 恢复用户已删除的引用（重新上传已删除过的书）
 */
export function restoreUserBookRef(db: any, refId: string): void {
  const now = new Date().toISOString();
  db.update(userBookRefs)
    .set({ deletedAt: null, refCount: 1 } as any)
    .where(sql`id = ${refId}`)
    .run();
}

/**
 * 检查用户是否有该全局书籍的活跃引用
 */
export function findUserActiveBookRef(db: any, userId: string, globalBookId: string): any {
  return db.select()
    .from(userBookRefs)
    .where(sql`user_id = ${userId} AND global_book_id = ${globalBookId} AND deleted_at IS NULL`)
    .get() || null;
}

/**
 * 获取用户已删除的引用记录（用于恢复）
 */
export function findUserDeletedRef(db: any, userId: string, globalBookId: string): any {
  return db.select()
    .from(userBookRefs)
    .where(sql`user_id = ${userId} AND global_book_id = ${globalBookId} AND deleted_at IS NOT NULL`)
    .get() || null;
}

/**
 * 删除用户对某本书的引用（减引用计数，标记删除）
 */
export function removeUserBookRef(db: any, userId: string, localBookId: string): boolean {
  const ref = db.select()
    .from(userBookRefs)
    .where(sql`user_id = ${userId} AND local_book_id = ${localBookId}`)
    .get() as any;
  if (!ref) return false;

  const now = new Date().toISOString();
  db.update(userBookRefs)
    .set({ deletedAt: now } as any)
    .where(sql`id = ${ref.id}`)
    .run();

  // 检查全局书籍是否所有引用都已删除
  const activeRefs = db.select({ count: sql<number>`count(*)` })
    .from(userBookRefs)
    .where(sql`global_book_id = ${ref.globalBookId} AND deleted_at IS NULL`)
    .get()?.count ?? 0;

  if (activeRefs === 0) {
    const gBook = db.select()
      .from(globalBooks)
      .where(sql`id = ${ref.globalBookId}`)
      .get() as any;
    if (gBook && !gBook.deletedAt) {
      db.update(globalBooks)
        .set({ deletedAt: now } as any)
        .where(sql`id = ${ref.globalBookId}`)
        .run();
    }
  }

  return true;
}

// ===== TTS 全局资源管理 =====

/**
 * 查找全局 TTS 资源
 */
export function findTtsGlobalResource(
  db: any,
  textHash: string,
  voice: string,
  speed: number,
  bookId: string,
  source = 'edgetts',
): any {
  return db.select()
    .from(ttsGlobalResources)
    .where(sql`text_hash = ${textHash} AND voice = ${voice} AND speed = ${speed} AND source = ${source} AND book_id = ${bookId} AND deleted_at IS NULL`)
    .get() || null;
}

/**
 * 创建全局 TTS 资源
 */
export function createTtsGlobalResource(
  db: any,
  bookId: string,
  chapterId: string | null,
  textHash: string,
  voice: string,
  speed: number,
  audioPath: string,
  fileSize: number | null,
  segmentIndex?: number | null,
  source = 'edgetts',
): any {
  const now = new Date().toISOString();
  const id = uuidv4();
  db.insert(ttsGlobalResources).values({
    id,
    bookId,
    chapterId,
    segmentIndex: segmentIndex ?? null,
    source,
    textHash,
    voice,
    speed,
    audioPath,
    fileSize,
    createdAt: now,
    deletedAt: null,
  }).run();
  return { id, bookId, chapterId, segmentIndex: segmentIndex ?? null, source, textHash, voice, speed, audioPath, createdAt: now };
}

/**
 * 创建用户 TTS 引用
 */
export function createTtsRef(
  db: any,
  userId: string,
  globalResourceId: string,
  localCacheId: string | null,
): any {
  const now = new Date().toISOString();
  const id = uuidv4();
  db.insert(ttsRefs).values({
    id,
    userId,
    globalResourceId,
    localCacheId,
    refCount: 1,
    deletedAt: null,
    createdAt: now,
  }).run();
  return { id, userId, globalResourceId, refCount: 1 };
}

/**
 * 删除用户 TTS 引用
 */
export function removeTtsRef(db: any, userId: string, globalResourceId: string): boolean {
  const ref = db.select()
    .from(ttsRefs)
    .where(sql`user_id = ${userId} AND global_resource_id = ${globalResourceId} AND deleted_at IS NULL`)
    .get() as any;
  if (!ref) return false;

  const now = new Date().toISOString();
  db.update(ttsRefs)
    .set({ deletedAt: now } as any)
    .where(sql`id = ${ref.id}`)
    .run();

  const activeRefs = db.select({ count: sql<number>`count(*)` })
    .from(ttsRefs)
    .where(sql`global_resource_id = ${globalResourceId} AND deleted_at IS NULL`)
    .get()?.count ?? 0;

  if (activeRefs === 0) {
    const gRes = db.select()
      .from(ttsGlobalResources)
      .where(sql`id = ${globalResourceId}`)
      .get() as any;
    if (gRes && !gRes.deletedAt) {
      db.update(ttsGlobalResources)
        .set({ deletedAt: now } as any)
        .where(sql`id = ${globalResourceId}`)
        .run();
    }
  }

  return true;
}

// ===== 定时清理（30天过期资源） =====

const CLEANUP_THRESHOLD_DAYS = 30;

/**
 * 清理所有引用归零且超过30天的全局资源
 */
export function cleanupExpiredResources(db: any, dataDir: string): CleanupResult {
  const threshold = new Date(Date.now() - CLEANUP_THRESHOLD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result: CleanupResult = { booksDeleted: 0, ttsResourcesDeleted: 0, filesDeleted: 0 };

  // ── 清理全局书籍 ──
  const expiredBooks = db.select()
    .from(globalBooks)
    .where(sql`deleted_at IS NOT NULL AND deleted_at < ${threshold}`)
    .all() as any[];

  for (const gBook of expiredBooks) {
    const activeRefs = db.select({ count: sql<number>`count(*)` })
      .from(userBookRefs)
      .where(sql`global_book_id = ${gBook.id} AND deleted_at IS NULL`)
      .get()?.count ?? 0;
    if (activeRefs > 0) {
      db.update(globalBooks).set({ deletedAt: null } as any).where(sql`id = ${gBook.id}`).run();
      continue;
    }

    // 删除物理文件
    try {
      const bookDir = path.dirname(gBook.filePath);
      if (fs.existsSync(bookDir)) {
        fs.rmSync(bookDir, { recursive: true, force: true });
        result.filesDeleted++;
      }
    } catch { /* ignore */ }

    // 删除关联 TTS 全局资源
    const relatedTts = db.select()
      .from(ttsGlobalResources)
      .where(sql`book_id = ${gBook.id}`)
      .all() as any[];
    for (const tts of relatedTts) {
      try { if (fs.existsSync(tts.audioPath)) { fs.unlinkSync(tts.audioPath); result.filesDeleted++; } } catch { }
      db.delete(ttsRefs).where(sql`global_resource_id = ${tts.id}`).run();
      db.delete(ttsGlobalResources).where(sql`id = ${tts.id}`).run();
      result.ttsResourcesDeleted++;
    }

    // 删除引用记录
    db.delete(userBookRefs).where(sql`global_book_id = ${gBook.id}`).run();

    // 删除所有用户的 local book 记录
    const localBooks = db.select().from(books)
      .where(sql`id IN (SELECT local_book_id FROM user_book_refs WHERE global_book_id = ${gBook.id})`)
      .all() as any[];
    for (const lb of localBooks) {
      db.delete(readingProgress).where(sql`book_id = ${lb.id}`).run();
      db.delete(bookChapters).where(sql`book_id = ${lb.id}`).run();
      db.delete(ttsGenerationJobs).where(sql`book_id = ${lb.id}`).run();
      db.delete(ttsCache).where(sql`book_id = ${lb.id}`).run();
      db.delete(bookContentCache).where(sql`book_id = ${lb.id}`).run();
      db.delete(voiceCache).where(sql`book_id = ${lb.id}`).run();
      db.delete(books).where(sql`id = ${lb.id}`).run();
    }

    db.delete(globalBooks).where(sql`id = ${gBook.id}`).run();
    result.booksDeleted++;
  }

  // ── 清理全局 TTS 资源 ──
  const expiredTts = db.select()
    .from(ttsGlobalResources)
    .where(sql`deleted_at IS NOT NULL AND deleted_at < ${threshold}`)
    .all() as any[];

  for (const tts of expiredTts) {
    const activeRefs = db.select({ count: sql<number>`count(*)` })
      .from(ttsRefs)
      .where(sql`global_resource_id = ${tts.id} AND deleted_at IS NULL`)
      .get()?.count ?? 0;
    if (activeRefs > 0) {
      db.update(ttsGlobalResources).set({ deletedAt: null } as any).where(sql`id = ${tts.id}`).run();
      continue;
    }

    try { if (fs.existsSync(tts.audioPath)) { fs.unlinkSync(tts.audioPath); result.filesDeleted++; } } catch { }
    db.delete(ttsRefs).where(sql`global_resource_id = ${tts.id}`).run();
    db.delete(ttsGlobalResources).where(sql`id = ${tts.id}`).run();
    result.ttsResourcesDeleted++;
  }

  if (result.booksDeleted > 0 || result.ttsResourcesDeleted > 0) {
    console.log(`[全局清理] 完成: ${result.booksDeleted} 本书, ${result.ttsResourcesDeleted} 个TTS资源, ${result.filesDeleted} 个文件`);
  }

  return result;
}

/**
 * 初始化全局清理定时器（每小时执行一次）
 */
export function startCleanupScheduler(db: any, dataDir: string, intervalMs: number = 60 * 60 * 1000): NodeJS.Timeout {
  console.log(`[全局清理] 定时器已启动，间隔 ${intervalMs / 1000 / 60} 分钟`);
  setTimeout(() => cleanupExpiredResources(db, dataDir), 5000);
  return setInterval(() => cleanupExpiredResources(db, dataDir), intervalMs);
}