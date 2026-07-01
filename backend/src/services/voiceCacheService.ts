/**
 * Voice Cache Service
 * 管理音色 LRU 缓存：每本书保留最近 N 个音色的缓存
 * 当用户切换音色时，旧音色的缓存保留，后续 LRU 淘汰
 * 默认每本书保留最近 3 个音色
 */
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { voiceCache, ttsCache, bookChapters, ttsGenerationJobs } from '../db/schema.js';
import fs from 'fs';

const MAX_VOICES_PER_BOOK = 3;

// ===== 类型定义 =====

export interface VoiceCacheEntry {
  id: string;
  userId: string;
  bookId: string;
  voice: string;
  speed: number;
  lastUsedAt: string;
  createdAt: string;
}

// ===== 记录音色使用 =====

/**
 * 记录音色使用（每次 TTS 请求时调用）
 * 如果该音色已存在，更新 lastUsedAt
 * 如果不存在，新增记录
 * 如果该书的音色数超过 MAX_VOICES_PER_BOOK，淘汰最久未使用的
 */
export function recordVoiceUsage(
  db: any,
  bookId: string,
  userId: string,
  voice: string,
  speed: number,
): VoiceCacheEntry {
  const now = new Date().toISOString();

  // 检查是否已有该音色记录
  const existing = db.select().from(voiceCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId} AND voice = ${voice} AND speed = ${speed}`)
    .get();

  if (existing) {
    // 更新最后使用时间
    db.update(voiceCache)
      .set({ lastUsedAt: now })
      .where(sql`id = ${existing.id}`)
      .run();
    return { ...existing, lastUsedAt: now };
  }

  // 新增记录
  const id = uuidv4();
  db.insert(voiceCache).values({
    id,
    userId,
    bookId,
    voice,
    speed,
    lastUsedAt: now,
    createdAt: now,
  }).run();

  // LRU 淘汰：检查该书音色数是否超过限制
  evictExcessVoices(db, bookId, userId);

  return { id, userId, bookId, voice, speed, lastUsedAt: now, createdAt: now };
}

// ===== LRU 淘汰 =====

/**
 * 淘汰指定书籍超出限制的音色缓存
 * 保留最近 MAX_VOICES_PER_BOOK 个音色，删除更旧的
 */
export function evictExcessVoices(
  db: any,
  bookId: string,
  userId: string,
): number {
  const allVoices = db.select().from(voiceCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .orderBy(voiceCache.lastUsedAt, 'desc')
    .all();

  if (allVoices.length <= MAX_VOICES_PER_BOOK) return 0;

  const toDelete = allVoices.slice(MAX_VOICES_PER_BOOK);
  let deleted = 0;

  for (const entry of toDelete) {
    // 删除该音色对应的 TTS 缓存（tts_cache 表中匹配 voice 的记录）
    const ttsEntries = db.select().from(ttsCache)
      .where(sql`user_id = ${userId} AND voice = ${entry.voice}`)
      .all();
    for (const ttsEntry of ttsEntries) {
      try {
        if (fs.existsSync(ttsEntry.audioPath)) {
          fs.unlinkSync(ttsEntry.audioPath);
        }
      } catch { /* 忽略 */ }
      db.delete(ttsCache).where(sql`id = ${ttsEntry.id}`).run();
    }

    // 删除 voice_cache 记录
    db.delete(voiceCache).where(sql`id = ${entry.id}`).run();
    deleted++;
  }

  return deleted;
}

// ===== 查询 =====

/**
 * 获取指定书籍的音色缓存列表（按最后使用时间降序）
 */
export function getBookVoiceCache(
  db: any,
  bookId: string,
  userId: string,
): VoiceCacheEntry[] {
  return db.select().from(voiceCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .orderBy(voiceCache.lastUsedAt, 'desc')
    .all();
}

/**
 * 获取书籍的语音生成统计
 */
export function getBookVoiceStats(
  db: any,
  bookId: string,
  userId: string,
): { totalChapters: number; generatedChapters: number; currentVoice: string | null } {
  const totalChapters = db.select({ count: sql<number>`count(*)` }).from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .get()?.count ?? 0;

  // 统计已生成语音的章节数（通过 tts_generation_jobs 表）
  const generatedChapters = db.select({ count: sql<number>`count(*)` }).from(ttsGenerationJobs)
    .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status = 'completed'`)
    .get()?.count ?? 0;

  // 获取当前使用的音色
  const latestVoice = db.select().from(voiceCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .orderBy(voiceCache.lastUsedAt, 'desc')
    .limit(1)
    .get();

  return {
    totalChapters,
    generatedChapters,
    currentVoice: latestVoice?.voice || null,
  };
}

/**
 * 清除指定书籍的音色缓存
 */
export function clearBookVoiceCache(
  db: any,
  bookId: string,
  userId: string,
): number {
  const entries = db.select().from(voiceCache)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .all();
  for (const entry of entries) {
    db.delete(voiceCache).where(sql`id = ${entry.id}`).run();
  }
  return entries.length;
}