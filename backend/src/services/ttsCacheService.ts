/**
 * TTS Cache Service
 * 管理 TTS 音频缓存：生成缓存键、查找缓存、写入缓存、清理缓存
 * 缓存存储：磁盘文件（data/tts-cache/）+ 数据库记录（tts_cache 表）
 */

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { sql, and } from 'drizzle-orm';
import { ttsCache } from '../db/schema.js';

// ===== 类型定义 =====

export interface CacheEntry {
  id: string;
  bookId?: string | null;
  chapterId?: string | null;
  segmentIndex?: number | null;
  source?: string;
  textHash: string;
  voice: string;
  speed: number;
  audioPath: string;
  createdAt: string;
}

// ===== 缓存键生成 =====

/**
 * 计算 apiUrl 指纹（缓存键身份维度，D14）：换引擎/换地址不得命中旧音频。
 * 无 apiUrl 返回空串（与未配置语义一致）。
 */
export function computeApiUrlHash(apiUrl?: string | null): string {
  if (!apiUrl) return '';
  return crypto.createHash('sha256').update(apiUrl).digest('hex').slice(0, 8);
}

/**
 * 根据文本、音色、语速生成唯一的缓存键（D14：v2_ 前缀 + source|model|apiUrlHash 身份维度）
 * v2_ 前缀同时用于历史键（纯 md5 hex）的一次性清理识别（evictLegacyCacheKeys）
 */
export function generateCacheKey(
  text: string,
  voice: string,
  speed: number,
  source = 'openai',
  model = '',
  apiUrlHash = '',
): string {
  return `v2_${crypto.createHash('md5').update(`${source}|${model}|${apiUrlHash}|${voice}|${speed}|${text}`).digest('hex')}`;
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
  source = 'openai',
  model = '',
  apiUrl?: string | null,
): CacheEntry | null {
  const textHash = generateCacheKey(text, voice, speed, source, model, computeApiUrlHash(apiUrl));
  // D3 修复：drizzle 链式 .where() 是赋值覆盖而非 AND 组合，必须 and(...) 单次传入，
  // 否则带 userId 时文本/音色条件全部失效 → 任意文本命中任意缓存音频（错音）
  const conditions = [
    sql`text_hash = ${textHash}`,
    sql`voice = ${voice}`,
    sql`speed = ${speed}`,
    sql`source = ${source}`,
  ];
  if (userId) conditions.push(sql`user_id = ${userId}`);
  const result = db.select()
    .from(ttsCache)
    .where(and(...conditions))
    .get();
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
  segmentIndex?: number | null,
  source = 'openai',
  model = '',
  apiUrl?: string | null,
): CacheEntry {
  const textHash = generateCacheKey(text, voice, speed, source, model, computeApiUrlHash(apiUrl));
  const cacheDir = getCacheDir(dataDir);
  const audioPath = getCacheFilePath(cacheDir, textHash, format);
  const effectiveUserId = userId || 'default-user';

  // 写入磁盘（幂等：同 hash 同内容，覆盖安全）
  fs.writeFileSync(audioPath, audioBuffer);

  const now = new Date().toISOString();

  // P1-6：INSERT OR IGNORE 占位竞争 — 唯一索引 (text_hash, voice, speed, source, user_id) 保证并发安全
  const id = uuidv4();
  db.insert(ttsCache).values({
    id,
    userId: effectiveUserId,
    bookId: bookId || null,
    chapterId: chapterId || null,
    segmentIndex: segmentIndex ?? null,
    source,
    textHash,
    voice,
    speed,
    audioPath,
    createdAt: now,
  }).onConflictDoNothing().run();

  // 查询最终记录（可能是本次插入的，也可能是并发竞争者先插入的）——D3：and() 单传
  const final = db.select()
    .from(ttsCache)
    .where(and(
      sql`text_hash = ${textHash}`,
      sql`voice = ${voice}`,
      sql`speed = ${speed}`,
      sql`source = ${source}`,
      sql`user_id = ${effectiveUserId}`,
    ))
    .get() as CacheEntry;

  if (final && final.id !== id) {
    // 竞争者先插入，补充 bookId/chapterId/segmentIndex 元数据
    db.update(ttsCache)
      .set({ audioPath, bookId: bookId ?? final.bookId, chapterId: chapterId ?? final.chapterId, segmentIndex: segmentIndex ?? final.segmentIndex })
      .where(sql`id = ${final.id}`)
      .run();
  }

  // LRU eviction: keep max 1000 entries
  evictStaleCache(db, dataDir, 1000);

  return final || { id, bookId: bookId || null, chapterId: chapterId || null, segmentIndex: segmentIndex ?? null, source, textHash, voice, speed, audioPath, createdAt: now };
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
  source = 'openai',
): CacheEntry[] {
  // D3 修复：and() 单传（原链式覆盖导致 batch-cache 跨书返回全部缓存）
  const conditions = [
    sql`book_id = ${bookId}`,
    sql`voice = ${voice}`,
    sql`speed = ${speed}`,
    sql`source = ${source}`,
  ];
  if (userId) conditions.push(sql`user_id = ${userId}`);
  const results = db.select()
    .from(ttsCache)
    .where(and(...conditions))
    .orderBy(sql`chapter_id ASC, segment_index ASC, created_at ASC`)
    .all();
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
  source = 'openai',
  model = '',
  apiUrl?: string | null,
): void {
  const textHash = generateCacheKey(text, voice, speed, source, model, computeApiUrlHash(apiUrl));
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
  // D3 修复：and() 单传（原链式覆盖导致 DELETE 丢条件）
  const conditions = userId ? [sql`user_id = ${userId}`] : [];
  const selectBase = db.select().from(ttsCache);
  const allEntries = (conditions.length ? selectBase.where(and(...conditions)) : selectBase).all();
  let deleted = 0;
  for (const entry of allEntries) {
    try {
      if (fs.existsSync(entry.audioPath)) {
        fs.unlinkSync(entry.audioPath);
      }
    } catch { /* 忽略 */ }
    const delConditions = [sql`id = ${entry.id}`];
    if (userId) delConditions.push(sql`user_id = ${userId}`);
    db.delete(ttsCache).where(and(...delConditions)).run();
    deleted++;
  }
  return deleted;
}

/**
 * 历史缓存键一次性清理（D14 配套）：v2_ 前缀之外的记录均为旧键算法产物，
 * 新键查询永不命中，保留只会占用磁盘/数据库。启动时幂等调用。
 */
export function evictLegacyCacheKeys(
  db: ReturnType<typeof import('../db/init.js').initDatabase>,
): number {
  const legacy = db.select().from(ttsCache)
    .where(sql`text_hash NOT LIKE 'v2_%'`)
    .all() as CacheEntry[];
  let deleted = 0;
  for (const entry of legacy) {
    try {
      if (fs.existsSync(entry.audioPath)) fs.unlinkSync(entry.audioPath);
    } catch { /* 忽略 */ }
    db.delete(ttsCache).where(sql`id = ${entry.id}`).run();
    deleted++;
  }
  if (deleted > 0) console.log(`[TTS Cache] 已清理旧版本缓存键记录 ${deleted} 条（D14 键升级）`);
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