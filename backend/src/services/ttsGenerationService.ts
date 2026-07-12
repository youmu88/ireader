/**
 * TTS Generation Service
 * 后台异步生成书籍的语音转换，按章节分片存储管理
 * 支持全书生成、部分章节生成
 * 使用队列控制并发，避免过度消耗资源
 */
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { ttsGenerationJobs, bookChapters, ttsSettings, books } from '../db/schema.js';
import { synthesize } from './ttsProxyService.js';
import { saveToCache } from './ttsCacheService.js';
import { parseTxt, getChapterContent } from '../parser/index.js';
import path from 'path';
import fs from 'fs';

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去除 HTML 标签，保留文本内容 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

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
const STUCK_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无更新视为卡住
const activeJobs = new Set<string>();

/**
 * 恢复卡住的任务：检查长时间 running 无进展的任务，重置为 pending
 * 每次恢复时重新计算 totalChunks（章节可能已变动），并限制最大恢复次数
 */
function recoverStuckJobs(db: any): number {
  const cutoff = new Date(Date.now() - STUCK_JOB_TIMEOUT_MS).toISOString();
  const stuckJobs = db.select().from(ttsGenerationJobs)
    .where(sql`status = 'running' AND updated_at < ${cutoff}`)
    .all() as GenerationJob[];

  for (const job of stuckJobs) {
    // 检查恢复次数：error 字段累加 "任务超时自动恢复" 次数
    const recoveryCount = (job.error?.match(/任务超时自动恢复/g) || []).length;
    const MAX_RECOVERIES = 3; // 最多自动恢复 3 次，避免无限死循环

    if (recoveryCount >= MAX_RECOVERIES) {
      console.log(`[TTS] 任务 ${job.id} (book: ${job.bookId}) 已自动恢复 ${recoveryCount} 次，超过上限，标记为失败`);
      db.update(ttsGenerationJobs)
        .set({
          status: 'failed',
          error: `任务超时已达上限(${MAX_RECOVERIES}次)，人工介入`,
          updatedAt: new Date().toISOString(),
        })
        .where(sql`id = ${job.id}`)
        .run();
      continue;
    }

    // 重新计算 totalChunks（章节可能已更新）
    const chapters = db.select().from(bookChapters)
      .where(sql`book_id = ${job.bookId}`)
      .all();
    const newTotalChunks = chapters.reduce((sum: number, ch: any) => {
      const estSize = ch.endOffset ? (ch.endOffset - (ch.startOffset || 0)) : 2000;
      return sum + Math.max(1, Math.ceil(estSize / 200));
    }, 0);

    console.log(`[TTS] 恢复卡住的任务 ${job.id} (book: ${job.bookId}, 上次更新: ${job.updatedAt}, 重算 totalChunks: ${newTotalChunks})`);
    db.update(ttsGenerationJobs)
      .set({
        status: 'pending',
        progress: 0,
        completedChunks: 0,
        totalChunks: newTotalChunks,
        error: (job.error || '') + (job.error ? '; ' : '') + `任务超时自动恢复(第${recoveryCount + 1}次)`,
        updatedAt: new Date().toISOString(),
      })
      .where(sql`id = ${job.id}`)
      .run();
  }
  return stuckJobs.length;
}

/**
 * 带超时的 synthesize 调用
 */
async function synthesizeWithTimeout(
  params: any,
  timeoutMs: number = 120000,
): Promise<any> {
  const { synthesize } = await import('./ttsProxyService.js');
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('TTS 合成超时')), timeoutMs),
  );
  return Promise.race([synthesize(params), timeout]);
}

/**
 * 尝试启动队列中的下一个待处理任务
 */
export function tryProcessQueue(db: any, dataDir: string): void {
  if (activeJobs.size >= MAX_CONCURRENT_JOBS) return;

  // 先恢复卡住的任务
  recoverStuckJobs(db);

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
  dataDir: string,
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

  // 去重检查：如果已存在相同书+音色+速度的未完成任务，不再重复创建
  const existingJob = db.select().from(ttsGenerationJobs)
    .where(sql`book_id = ${bookId} AND voice = ${voice} AND speed = ${speed} AND status != 'completed' AND status != 'failed'`)
    .get();
  if (existingJob) {
    return existingJob as unknown as GenerationJob;
  }

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
  dataDir: string,
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

    const book = db.select().from(books)
      .where(sql`id = ${job.bookId}`)
      .get();

    if (!book) {
      throw new Error('图书不存在');
    }

    let completedChunks = 0;
    let chapterChunks = 0; // 实际总片数（用于更新 totalChunks）

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
          // 处理含锚点 (#) 的 href，常见于合集型 EPUB（所有章节指向同一文件的不同锚点）
          const hrefPath = chapter.href.split('#')[0]; // 去掉锚点部分，只保留文件路径
          let basePath = chapter.href;
          if (hrefPath) {
            basePath = hrefPath;
          }
          const extractedPath = path.join(path.dirname(book.filePath), 'extracted', basePath);
          if (fs.existsSync(extractedPath)) {
            const fullContent = fs.readFileSync(extractedPath, 'utf-8');

            // 如果 href 包含锚点 (#)，尝试提取锚点对应区段的文本
            const anchorId = chapter.href.includes('#') ? chapter.href.split('#')[1] : null;
            if (anchorId) {
              // 尝试匹配 <section id="toc_X"> 或 <div id="toc_X"> 或任意 id="toc_X" 标签
              // 提取从该锚点开始到下一个相同层级标签或文件末尾之间的内容
              const anchorRegex = new RegExp(
                `<[^>]+?id=(["'])${escapeRegex(anchorId)}\\1[^>]*>([\\s\\S]*?)(?=<[^>]+?id=(["'])[^>"']+\\3[^>]*>|$)`,
                'i'
              );
              const anchorMatch = fullContent.match(anchorRegex);
              if (anchorMatch) {
                chapterText = stripHtmlTags(anchorMatch[2]);
              } else {
                // 降级：尝试仅查找 id 并提取其后内容到下一个块级标签
                const fallbackMatch = fullContent.match(
                  new RegExp(`id=(["'])${escapeRegex(anchorId)}\\1[^>]*>([\\s\\S]*?)(?:<[^>]+?id=(["'])|$)`, 'i')
                );
                if (fallbackMatch) {
                  chapterText = stripHtmlTags(fallbackMatch[2]);
                }
              }
            }

            // 如果没有锚点 或 锚点解析失败，使用完整文件内容
            if (!chapterText) {
              chapterText = stripHtmlTags(fullContent);
            }
          }
        }
      }

      if (!chapterText) {
        // 使用与 totalChunks 估算相同的逻辑计算空章节应计分片数
        const estSize = chapter.endOffset ? (chapter.endOffset - (chapter.startOffset || 0)) : 2000;
        const estimatedChunks = Math.max(1, Math.ceil(estSize / 200));
        chapterChunks += estimatedChunks;
        completedChunks += estimatedChunks;
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

      // 记录当前章节实际分片数（用于更新 totalChunks）
      chapterChunks += chunks.length;

      // 加载用户自定义 TTS API 配置
      const userSettings = db.select().from(ttsSettings).where(sql`user_id = ${job.userId}`).get();

      // 如果用户关闭了 TTS 功能，则跳过此任务
      if (userSettings && !userSettings.enabled) {
        throw new Error('TTS 语音功能已关闭');
      }

      const apiUrl = userSettings?.apiUrl || undefined;
      const apiKey = userSettings?.apiKey || undefined;
      const source = userSettings?.source || process.env.TTS_DEFAULT_SOURCE || 'edgetts';

      // 逐段合成并缓存
      for (const chunk of chunks) {
        if (!chunk.trim()) continue;
        try {
          const result = await synthesizeWithTimeout({
            input: chunk,
            voice: job.voice,
            speed: job.speed,
            response_format: 'wav',
            tts_source: source,
            apiUrl,
            apiKey,
          });

          if (result.success && result.audio) {
            // 保存到 TTS 缓存（按用户隔离）
            saveToCache(db, dataDir, chunk, job.voice, job.speed, result.audio, 'wav', job.userId, job.bookId, job.chapterId);

            // ⭐ 同时写入全局资源（便于跨用户共享）
            try {
              const { findTtsGlobalResource, createTtsGlobalResource } = await import('./globalResourceService.js');
              const textHash = (crypto as any).createHash('md5').update(`${job.voice}|${job.speed}|${chunk}`).digest('hex');

              // localBookId → globalBookId 映射
              const { userBookRefs } = await import('../db/schema.js');
              const userRef = db.select().from(userBookRefs).where(
                sql`local_book_id = ${job.bookId} AND deleted_at IS NULL`
              ).get() as any;
              const globalBookId = userRef?.globalBookId || job.bookId;

              const existing = findTtsGlobalResource(db, textHash, job.voice, job.speed, globalBookId);
              if (!existing) {
                // 复制音频到全局目录
                const globalAudioDir = path.join(dataDir, 'tts-global');
                if (!fs.existsSync(globalAudioDir)) fs.mkdirSync(globalAudioDir, { recursive: true });
                const globalAudioPath = path.join(globalAudioDir, `${textHash}.wav`);
                if (!fs.existsSync(globalAudioPath)) {
                  fs.writeFileSync(globalAudioPath, result.audio);
                }
                createTtsGlobalResource(db, globalBookId, job.chapterId || null, textHash, job.voice, job.speed, globalAudioPath, result.audio.length);
              }
              // 为用户创建 TTS 引用
              const { ttsRefs } = await import('../db/schema.js');
              const refExists = db.select().from(ttsRefs).where(
                sql`user_id = ${job.userId} AND global_resource_id = ${existing?.id || textHash}`
              ).get();
              if (!refExists) {
                const { v4: uuidv4 } = await import('uuid');
                db.insert(ttsRefs).values({
                  id: uuidv4(),
                  userId: job.userId,
                  globalResourceId: existing?.id,
                  localCacheId: null,
                  bookId: job.bookId,
                  refCount: 1,
                  createdAt: new Date().toISOString(),
                  deletedAt: null,
                } as any).run();
              }
            } catch (err) {
              // 全局资源写入失败不应中断主流程
              console.warn(`[TTS] 写入全局资源失败(非致命):`, (err as Error).message);
            }
          } else if (result && !result.success) {
            console.warn(`[TTS] 段落合成失败: ${result.error || '未知错误'} (book: ${job.bookId.slice(0,8)})`);
          }
        } catch (err: any) {
          // 单段失败不中断整个任务，但记录错误
          console.warn(`[TTS] 段落合成异常: ${err.message || err} (book: ${job.bookId.slice(0,8)})`);
        }

        completedChunks++;
        // 用实际总片数 chapterChunks 计算进度，避免 totalChunks（创建时估算值）偏差导致进度虚假
        const actualTotal = Math.max(job.totalChunks, chapterChunks);
        const progress = Math.min(100, Math.round((completedChunks / actualTotal) * 100));

        db.update(ttsGenerationJobs)
          .set({
            progress,
            completedChunks,
            totalChunks: actualTotal, // 实时更新 totalChunks 为实际值
            updatedAt: new Date().toISOString(),
          })
          .where(sql`id = ${job.id}`)
          .run();

        // 检查任务是否被用户取消（取消后 status 变为 'failed'）
        const activeCheck = db.select({ status: ttsGenerationJobs.status }).from(ttsGenerationJobs)
          .where(sql`id = ${job.id}`)
          .get();
        if (!activeCheck || activeCheck.status !== 'running') {
          console.log(`[TTS] 任务 ${job.id} 已被用户取消，停止处理`);
          return;
        }
      }
    }

    // 标记为完成
    db.update(ttsGenerationJobs)
      .set({
        status: 'completed',
        progress: 100,
        totalChunks: Math.max(job.totalChunks, chapterChunks),
        completedChunks,
        updatedAt: new Date().toISOString(),
      })
      .where(sql`id = ${job.id}`)
      .run();

    // 记录音色使用（激活 LRU 缓存管理）
    try {
      const { recordVoiceUsage } = await import('./voiceCacheService.js');
      recordVoiceUsage(db, job.bookId, job.userId, job.voice, job.speed);
    } catch { /* 不影响主流程 */ }
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

// ===== 取消任务 =====

/**
 * 取消单个生成任务

/**
 * 删除任务（不限状态，可直接删除 failed/completed 等任务）
 */
export function deleteJobs(db: any, jobIds: string[]): number {
  let count = 0;
  for (const id of jobIds) {
    const job = db.select().from(ttsGenerationJobs)
      .where(sql`id = ${id}`)
      .get();
    if (!job) continue;
    // 如果任务正在运行，先从 activeJobs 移除
    activeJobs.delete(id);
    db.delete(ttsGenerationJobs)
      .where(sql`id = ${id}`)
      .run();
    count++;
  }
  return count;
}

/**
 * 删除用户所有已完成/失败的任务
 */
export function clearTerminatedJobs(db: any, userId: string): number {
  const jobs = db.select().from(ttsGenerationJobs)
    .where(sql`user_id = ${userId} AND status IN ('completed', 'failed')`)
    .all();

  for (const job of jobs) {
    db.delete(ttsGenerationJobs)
      .where(sql`id = ${job.id}`)
      .run();
  }
  return jobs.length;
}

/**
 * 取消单个生成任务
 * 从 activeJobs 移除以停止实际处理，更新状态为 'failed'
 */
export function cancelJob(db: any, jobId: string): boolean {
  const job = db.select().from(ttsGenerationJobs)
    .where(sql`id = ${jobId}`)
    .get();

  if (!job) return false;
  if (job.status !== 'pending' && job.status !== 'running') return false;

  // 从活跃任务集合中移除，使正在运行的 processJob 循环在下次检查时停止
  activeJobs.delete(jobId);

  db.update(ttsGenerationJobs)
    .set({
      status: 'failed',
      error: '用户取消了任务',
      updatedAt: new Date().toISOString(),
    })
    .where(sql`id = ${jobId}`)
    .run();

  return true;
}

/**
 * 批量取消生成任务
 */
export function cancelJobs(db: any, jobIds: string[]): number {
  let count = 0;
  for (const id of jobIds) {
    if (cancelJob(db, id)) count++;
  }
  return count;
}

/**
 * 取消用户所有 pending/running 的生成任务
 */
export function cancelAllUserJobs(db: any, userId: string): number {
  const jobs = db.select().from(ttsGenerationJobs)
    .where(sql`user_id = ${userId} AND status IN ('pending', 'running')`)
    .all();

  for (const job of jobs) {
    activeJobs.delete(job.id);
    db.update(ttsGenerationJobs)
      .set({
        status: 'failed',
        error: '用户取消了任务',
        updatedAt: new Date().toISOString(),
      })
      .where(sql`id = ${job.id}`)
      .run();
  }
  return jobs.length;
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
  const userBooks = db.select().from(books)
    .where(sql`user_id = ${userId}`)
    .all();

  let created = 0;
  for (const book of userBooks) {
    const job = createFullBookGenerationJob(db, book.id, userId, newVoice, speed, dataDir);
    if (job) created++;
  }
  return created;
}