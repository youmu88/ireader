/**
 * TTS Generation Service
 * 后台异步生成书籍的语音转换，按章节分片存储管理
 * 支持全书生成、部分章节生成
 * 使用队列控制并发，避免过度消耗资源
 */
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { ttsGenerationJobs, bookChapters, ttsSettings } from '../db/schema.js';
import { synthesize } from './ttsProxyService.js';
import { saveToCache } from './ttsCacheService.js';
import { parseTxt, getChapterContent } from '../parser/index.js';
import path from 'path';
import fs from 'fs';

// ===== 类型定义 =====

export interface GenerationJob {
  id: string;
  userId: string;
  bookId: string;
  chapterId: string | null;
  voice: string;
  speed: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  totalChunks: number;
  completedChunks: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ===== 并发控制 =====

const MAX_CONCURRENT_JOBS = 2; // 最多同时运行 2 个生成任务
const activeJobs = new Set<string>();

/**
 * 尝试启动队列中的下一个待处理任务
 */
function tryProcessQueue(db: any, dataDir: string): void {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) return;

  const nextJob = db.select().from(ttsGenerationJobs)
    .where(sql`status = 'pending'`)
    .orderBy(ttsGenerationJobs.createdAt)
    .limit(1)
    .get();

  if (nextJob) {
    activeJobs.add(nextJob.id);
    processJob(db, dataDir, nextJob).finally(() => {
      activeJobs.delete(nextJob.id);
      // 尝试处理队列中的下一个任务
      tryProcessQueue(db, dataDir);
    });
  }
}

// ===== 创建生成任务 =====

/**
 * 创建全书 TTS 生成任务
 * 为书籍的每个章节创建生成任务（或一个任务包含所有章节）
 */
export function createFullBookGenerationJob(
  db: any,
  bookId: string,
  userId: string,
  voice: string,
  speed: number,
): GenerationJob {
  const now = new Date().toISOString();
  const jobId = uuidv4();

  const chapters = db.select().from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .orderBy(bookChapters.order)
    .all();

  const totalChunks = chapters.reduce((sum: number, ch: any) => {
    // 估算每个章节的分段数（按每段 200 字符估算）
    const estSize = ch.endOffset ? (ch.endOffset - (ch.startOffset || 0)) : 2000;
    return sum + Math.max(1, Math.ceil(estSize / 200));
  }, 0);

  const job: GenerationJob = {
    id: jobId,
    userId,
    bookId,
    chapterId: null,
    voice,
    speed,
    status: 'pending',
    progress: 0,
    totalChunks,
    completedChunks: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(ttsGenerationJobs).values(job).run();

  // 尝试立即处理队列
  tryProcessQueue(db, dataDir);

  return job;
}

/**
 * 创建部分章节 TTS 生成任务
 */
export function createPartialGenerationJob(
  db: any,
  bookId: string,
  userId: string,
  voice: string,
  speed: number,
  chapterCount: number,
): GenerationJob {
  const now = new Date().toISOString();
  const jobId = uuidv4();

  const chapters = db.select().from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .orderBy(bookChapters.order)
    .limit(chapterCount)
    .all();

  const totalChunks = chapters.reduce((sum: number, ch: any) => {
    const estSize = ch.endOffset ? (ch.endOffset - (ch.startOffset || 0)) : 2000;
    return sum + Math.max(1, Math.ceil(estSize / 200));
  }, 0);

  const job: GenerationJob = {
    id: jobId,
    userId,
    bookId,
    chapterId: null,
    voice,
    speed,
    status: 'pending',
    progress: 0,
    totalChunks,
    completedChunks: 0,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(ttsGenerationJobs).values(job).run();
  tryProcessQueue(db, dataDir);
  return job;
}

// ===== 处理单个任务 =====

async function processJob(
  db: any,
  dataDir: string,
  job: GenerationJob,
): Promise<void> {
  try {
    // 标记为运行中
    db.update(ttsGenerationJobs)
      .set({ status: 'running', updatedAt: new Date().toISOString() })
      .where(sql`id = ${job.id}`)
      .run();

    const chapters = db.select().from(bookChapters)
      .where(sql`book_id = ${job.bookId}`)
      .orderBy(bookChapters.order)
      .all();

    const book = db.select().from(import('../db/schema.js').books)
      .where(sql`id = ${job.bookId}`)
      .get();

    if (!book) {
      throw new Error('图书不存在');
    }

    let completedChunks = 0;

    for (const chapter of chapters) {
      // 获取章节文本
      let chapterText = '';
      if (book.format === 'txt') {
        if (chapter.startOffset != null) {
          const parseResult = parseTxt(book.filePath);
          chapterText = getChapterContent(parseResult.content, chapter.startOffset, chapter.endOffset || parseResult.content.length);
        }
      } else {
        if (chapter.href) {
          const extractedPath = path.join(path.dirname(book.filePath), 'extracted', chapter.href);
          if (fs.existsSync(extractedPath)) {
            chapterText = fs.readFileSync(extractedPath, 'utf-8');
          }
        }
      }

      if (!chapterText) {
        completedChunks += Math.max(1, Math.ceil(2000 / 200));
        continue;
      }

      // 按句子分段
      const segments = chapterText.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [chapterText];
      const chunkSize = 200;
      const chunks: string[] = [];
      let current = '';
      for (const seg of segments) {
        if ((current + seg).length > chunkSize && current.length > 0) {
          chunks.push(current.trim());
          current = seg;
        } else {
          current += seg;
        }
      }
      if (current.trim()) chunks.push(current.trim());

      // 逐段合成并缓存
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        try {
          const result = await synthesize({
            input: chunk,
            voice: job.voice,
            speed: job.speed,
            response_format: 'wav',
          });

          if (result.success && result.audio) {
            // 保存到 TTS 缓存（按用户隔离）
            saveToCache(db, dataDir, chunk, job.voice, job.speed, result.audio, 'wav', job.userId);
          }
        } catch {
          // 单段失败不中断整个任务
        }

        completedChunks++;
        const progress = Math.round((completedChunks / job.totalChunks) * 100);

        db.update(ttsGenerationJobs)
          .set({
            progress,
            completedChunks,
            updatedAt: new Date().toISOString(),
          })
          .where(sql`id = ${job.id}`)
          .run();
      }
    }

    // 标记为完成
    db.update(ttsGenerationJobs)
      .set({
        status: 'completed',
        progress: 100,
        completedChunks,
        updatedAt: new Date().toISOString(),
      })
      .where(sql`id = ${job.id}`)
      .run();
  } catch (err: any) {
    db.update(ttsGenerationJobs)
      .set({
        status: 'failed',
        error: err.message || '生成失败',
        updatedAt: new Date().toISOString(),
      })
      .where(sql`id = ${job.id}`)
      .run();
  }
}

// ===== 查询任务状态 =====

/**
 * 获取书籍的所有生成任务
 */
export function getBookGenerationJobs(
  db: any,
  bookId: string,
  userId: string,
): GenerationJob[] {
  return db.select().from(ttsGenerationJobs)
    .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
    .orderBy(ttsGenerationJobs.createdAt)
    .all();
}

/**
 * 获取书籍的语音生成统计
 */
export function getBookTTSStats(
  db: any,
  bookId: string,
  userId: string,
): { totalChapters: number; generatedChapters: number; generationProgress: number } {
  const chapters = db.select().from(bookChapters)
    .where(sql`book_id = ${bookId}`)
    .all();

  const totalChapters = chapters.length;

  // 统计已生成语音的章节数（通过 tts_cache 表按章节文本哈希去重估算）
  // 更精确：检查 tts_generation_jobs 中 completed 的任务
  const completedJobs = db.select({ count: sql<number>`count(*)` }).from(ttsGenerationJobs)
    .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status = 'completed'`)
    .get()?.count ?? 0;

  // 检查是否有正在运行的任务
  const runningJob = db.select().from(ttsGenerationJobs)
    .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status IN ('pending', 'running')`)
    .limit(1)
    .get();

  const generationProgress = runningJob ? runningJob.progress : (completedJobs > 0 ? 100 : 0);

  return {
    totalChapters,
    generatedChapters: completedJobs > 0 ? totalChapters : 0, // 简化：有 completed 任务则视为全部生成
    generationProgress,
  };
}

/**
 * 获取用户所有书籍的语音生成统计（用于书架展示）
 */
export function getAllBooksTTSStats(
  db: any,
  userId: string,
): Record<string, { totalChapters: number; generatedChapters: number; generationProgress: number }> {
  const allJobs = db.select().from(ttsGenerationJobs)
    .where(sql`user_id = ${userId}`)
    .all();

  const stats: Record<string, any> = {};
  for (const job of allJobs) {
    if (!stats[job.bookId]) {
      stats[job.bookId] = { totalChapters: 0, generatedChapters: 0, generationProgress: 0 };
    }
    if (job.status === 'completed') {
      stats[job.bookId].generatedChapters = job.totalChunks > 0 ? 1 : 0;
      stats[job.bookId].generationProgress = 100;
    } else if (job.status === 'running' || job.status === 'pending') {
      stats[job.bookId].generationProgress = Math.max(stats[job.bookId].generationProgress, job.progress);
    }
  }

  // 补充 totalChapters
  for (const bookId of Object.keys(stats)) {
    const chapters = db.select({ count: sql<number>`count(*)` }).from(bookChapters)
      .where(sql`book_id = ${bookId}`)
      .get();
    stats[bookId].totalChapters = chapters?.count ?? 0;
  }

  return stats;
}

/**
 * 当用户切换音色时，触发后台重新生成所有已缓存书籍的语音
 * 同时保留旧音色缓存（LRU 淘汰由 voiceCacheService 管理）
 */
export function regenerateAllForNewVoice(
  db: any,
  userId: string,
  newVoice: string,
  speed: number,
  dataDir: string,
): number {
  const userBooks = db.select().from(import('../db/schema.js').books)
    .where(sql`user_id = ${userId}`)
    .all();

  let created = 0;
  for (const book of userBooks) {
    const job = createFullBookGenerationJob(db, book.id, userId, newVoice, speed);
    if (job) created++;
  }
  return created;
}