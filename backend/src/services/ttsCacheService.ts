/**
 * TTS Cache Service
 * 管理 TTS 音频缓存：生成缓存键、查找缓存、写入缓存、清理缓存
 * 缓存存储：磁盘文件（data/tts-cache/）+ 数据库记录（tts_cache 表）
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { ttsCache } from '../db/schema.js';

// ===== 类型定义 =====

export interface CacheEntry {
  id: string;
  bookId?: string | null;
  chapterId?: string | null;
  textHash: string;
  voice: string;
  speed: number;
  audioPath: string;
  createdAt: string;
}

// ===== 缓存键生成 =====

/**
 * 根据文本、音色、语速生成唯一的缓存键（MD5）
 */
export function generateCacheKey(text: string, voice: string, speed: number): string {
  return crypto.createHash('md5').update(`${voice}|${speed}|${text}`).digest('hex');
}

// ===== 缓存目录 =====

/**
 * 获取 TTS 缓存目录，确保存在
 */
export function getCacheDir(dataDir: string): string {
  const cacheDir = path.join(dataDir, 'tts-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

/**
 * 获取缓存文件的完整路径
 */
export function getCacheFilePath(cacheDir: string, textHash: string, format: string = 'wav'): string {
  return path.join(cacheDir, `${textHash}.${format}`);
}

// ===== 查找缓存 =====

/**
 * 在数据库中查找缓存记录
 */
export function findCache(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  text: string,
  voice: string,
  speed: number,
  userId?: string,
): CacheEntry | null {
  const textHash = generateCacheKey(text, voice, speed);
  let query: any = db.select()
    .from(ttsCache)
    .where(sql`text_hash = ${textHash} AND voice = ${voice} AND speed = ${speed}`);
  if (userId) {
    query = query.where(sql`user_id = ${userId}`);
  }
  const result = query.get();
  return result || null;
}

/**
 * 检查缓存是否有效（文件存在 + hash 一致性校验）
 * 防止 DB 记录中 audio_path 指向与 text_hash 不匹配的错误文件
 */
export function isCacheValid(entry: CacheEntry): boolean {
  try {
    if (!fs.existsSync(entry.audioPath)) return false;
    // ⭐ 验证 audio_path 的文件 hash 与 text_hash 一致
    // 文件名格式为 {textHash}.{format}，如 25b8993c...wav
    const filename = path.basename(entry.audioPath);
    const dotIdx = filename.lastIndexOf('.');
    const fileHash = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    if (fileHash !== entry.textHash) {
      console.warn(`[TTS Cache] 缓存记录 hash 不匹配，已丢弃: text_hash=${entry.textHash}, audio_file=${filename}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ===== 写入缓存 =====

/**
 * 将音频写入缓存（磁盘文件 + 数据库记录）
 */
export function saveToCache(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  dataDir: string,
  text: string,
  voice: string,
  speed: number,
  audioBuffer: Buffer,
  format: string = 'wav',
  userId?: string,
  bookId?: string | null,
  chapterId?: string | null,
): CacheEntry {
  const textHash = generateCacheKey(text, voice, speed);
  const cacheDir = getCacheDir(dataDir);
  const audioPath = getCacheFilePath(cacheDir, textHash, format);

  // 写入磁盘
  fs.writeFileSync(audioPath, audioBuffer);

  const now = new Date().toISOString();

  // 检查是否已有记录（按用户隔离，同时过滤 voice + speed 防止跨音色/语速的意外覆盖）
  let query: any = db.select()
    .from(ttsCache)
    .where(sql`text_hash = ${textHash} AND voice = ${voice} AND speed = ${speed}`);
  if (userId) {
    query = query.where(sql`user_id = ${userId}`);
  }
  const existing = query.get();

  if (existing) {
    // 更新已有记录
    db.update(ttsCache)
      .set({ audioPath, createdAt: now, bookId: bookId ?? existing.bookId, chapterId: chapterId ?? existing.chapterId })
      .where(sql`id = ${existing.id}`)
      .run();
    return { ...existing, audioPath, createdAt: now, bookId: bookId ?? existing.bookId, chapterId: chapterId ?? existing.chapterId };
  }

  // Insert new record
  const id = uuidv4();
  db.insert(ttsCache).values({
    id,
    userId: userId || 'default-user',
    bookId: bookId || null,
    chapterId: chapterId || null,
    textHash,
    voice,
    speed,
    audioPath,
    createdAt: now,
  }).run();

  // LRU eviction: keep max 1000 entries
  evictStaleCache(db, dataDir, 1000);

  return { id, textHash, voice, speed, audioPath, createdAt: now };
}

// ===== 批量查询 =====

/**
 * 按 bookId 查询所有已缓存的段落（支持 voice + speed 过滤）
 * 用于前端缓存全书时批量拉取已预合成的音频
 */
export function findCachedSegmentsByBook(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  bookId: string,
  voice: string,
  speed: number,
  userId?: string,
): CacheEntry[] {
  let query: any = db.select()
    .from(ttsCache)
    .where(sql`book_id = ${bookId} AND voice = ${voice} AND speed = ${speed}`)
    .orderBy(sql`chapter_id ASC, created_at ASC`);
  if (userId) {
    query = query.where(sql`user_id = ${userId}`);
  }
  const results = query.all();
  // 过滤掉无效缓存（文件不存在或 hash 不匹配）
  return results.filter((entry: any) => isCacheValid(entry));
}


// ===== 清理缓存 =====

/**
 * 清理指定文本的缓存（用于强制刷新）
 */
export function clearCacheByText(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  text: string,
  voice: string,
  speed: number,
): void {
  const textHash = generateCacheKey(text, voice, speed);
  const entry = db.select()
    .from(ttsCache)
    .where(sql`text_hash = ${textHash} AND voice = ${voice} AND speed = ${speed}`)
    .get();

  if (entry) {
    // 删除磁盘文件
    try {
      if (fs.existsSync(entry.audioPath)) {
        fs.unlinkSync(entry.audioPath);
      }
    } catch { /* 文件可能已被删除 */ }
    // 删除数据库记录
    db.delete(ttsCache).where(sql`id = ${entry.id}`).run();
  }
}

/**
 * 清除全部缓存（删除所有缓存文件和数据库记录）
 */
export function clearAllCache(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  dataDir: string,
  userId?: string,
): number {
  let query: any = db.select().from(ttsCache);
  if (userId) {
    query = query.where(sql`user_id = ${userId}`);
  }
  const allEntries = query.all();
  let deleted = 0;
  for (const entry of allEntries) {
    try {
      if (fs.existsSync(entry.audioPath)) {
        fs.unlinkSync(entry.audioPath);
      }
    } catch { /* 忽略 */ }
    let delQuery: any = db.delete(ttsCache).where(sql`id = ${entry.id}`);
    if (userId) {
      delQuery = delQuery.where(sql`user_id = ${userId}`);
    }
    delQuery.run();
    deleted++;
  }
  return deleted;
}

/**
 * LRU 缓存淘汰：保留最近使用的 maxEntries 条，删除其余
 * 每次添加新缓存时自动触发
 */
export function evictStaleCache(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
  dataDir: string,
  maxEntries: number = 1000,
): number {
  const count = db.select({ count: sql<number>`count(*)` }).from(ttsCache).get();
  const total = count?.count ?? 0;
  if (total <= maxEntries) return 0;

  const toDelete = db.select().from(ttsCache)
    .orderBy(sql`created_at ASC`)
    .limit(total - maxEntries)
    .all();

  let deleted = 0;
  for (const entry of toDelete) {
    try {
      if (fs.existsSync(entry.audioPath)) {
        fs.unlinkSync(entry.audioPath);
      }
    } catch { /* 忽略 */ }
    db.delete(ttsCache).where(sql`id = ${entry.id}`).run();
    deleted++;
  }
  return deleted;
}
