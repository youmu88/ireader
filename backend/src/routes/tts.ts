/**
 * TTS 路由 — 提供语音服务选择、音色列表、连接测试、语音合成等 API
 * 所有 API 需要用户登录鉴权（用户隔离）
 */
import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { getSources, getVoices, getModels, checkHealth, synthesize } from '../services/ttsProxyService.js';
import { ttsSettings, ttsCache, ttsGenerationJobs, books, ttsGlobalResources, ttsRefs, userBookRefs } from '../db/schema.js';
import { findCache, isCacheValid, saveToCache, clearAllCache, evictStaleCache, findCachedSegmentsByBook } from '../services/ttsCacheService.js';
import { findTtsGlobalResource, createTtsGlobalResource, createTtsRef, removeTtsRef } from '../services/globalResourceService.js';
import { requireAuth } from '../middleware/auth.js';
import { regenerateAllForNewVoice, createFullBookGenerationJob, cancelJob, cancelJobs, cancelAllUserJobs, deleteJobs, clearTerminatedJobs } from '../services/ttsGenerationService.js';

export function createTtsRouter(db: ReturnType<typeof import('../db/init.js').initDatabase>, dataDir?: string) {
  const router = Router();

  // ── TTS 源列表（无需登录，属于通用服务信息） ──
  router.get('/sources', (_req: Request, res: Response) => {
    const sources = getSources();
    res.json({ success: true, data: sources });
  });

  // ── 音色列表（无需登录；支持自定义 apiUrl/apiKey 查询参数） ──
  router.get('/voices', async (req: Request, res: Response) => {
    const apiUrl = req.query.apiUrl as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const result = await getVoices(apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 模型列表（无需登录；支持自定义 apiUrl/apiKey 查询参数） ──
  router.get('/models', async (req: Request, res: Response) => {
    const apiUrl = req.query.apiUrl as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const result = await getModels(apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 健康检查 / 连接测试（无需登录；支持自定义 apiUrl/apiKey 查询参数） ──
  router.get('/health', async (req: Request, res: Response) => {
    const apiUrl = req.query.apiUrl as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const result = await checkHealth(apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 语音合成代理（带全局缓存；同时按同书+同文本+同音色共享） ──
  router.post('/', requireAuth, async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { input, voice, speed, response_format, no_cache, book_id } = req.body;

    // 加载用户的 TTS 设置（获取 API URL/Key/Model）
    const userSettings = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();
    const apiUrl = userSettings?.apiUrl || undefined;
    const apiKey = userSettings?.apiKey || undefined;
    const model = userSettings?.model || undefined;
    const source = 'openai';  // 统一标识，用于缓存键

    // ⭐ 全局资源查找：全局资源表的 book_id 是 globalBookId，需要映射
    if (!no_cache && dataDir && book_id) {
      try {
        const textHash = crypto.createHash('md5').update(`${source}|${voice || 'alloy'}|${speed || 1.0}|${input}`).digest('hex');

        // localBookId → globalBookId 映射
        const userRef = db.select().from(userBookRefs).where(
          sql`local_book_id = ${book_id} AND deleted_at IS NULL`
        ).get() as any;
        const globalBookId = userRef?.globalBookId || book_id;

        // 先查全局资源（同书+同文本+同音色共享）
        const globalRes = findTtsGlobalResource(db, textHash, voice || 'alloy', speed || 1.0, globalBookId, source);
        if (globalRes && fs.existsSync(globalRes.audioPath)) {
          // 创建/更新用户的 tts_ref
          const existingRef = db.select().from(ttsRefs).where(
            sql`user_id = ${userId} AND global_resource_id = ${globalRes.id} AND deleted_at IS NULL`
          ).get();
          if (!existingRef) {
            createTtsRef(db, userId, globalRes.id, null);
          }

          const audioBuffer = fs.readFileSync(globalRes.audioPath);
          const ext = path.extname(globalRes.audioPath).toLowerCase();
          const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', audioBuffer.length);
          res.setHeader('X-TTS-Cache', 'GLOBAL_HIT');
          res.send(audioBuffer);
          return;
        }
      } catch { /* 全局缓存读取失败，回退到本地缓存或实时合成 */ }
    }

    // ⭐ 回退到本地缓存（按用户隔离）
    if (!no_cache && dataDir) {
      try {
        const cached = findCache(db, input, voice || 'alloy', speed || 1.0, userId, source);
        if (cached && isCacheValid(cached)) {
          const audioBuffer = fs.readFileSync(cached.audioPath);
          const ext = path.extname(cached.audioPath).toLowerCase();
          const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', audioBuffer.length);
          res.setHeader('X-TTS-Cache', 'LOCAL_HIT');
          res.send(audioBuffer);
          return;
        }
      } catch { /* 缓存读取失败，回退到实时合成 */ }
    }

    const result = await synthesize({ input, voice, speed, model, response_format, apiUrl: apiUrl!, apiKey });
    if (!result.success) {
      res.status(result.status || 502).json({ success: false, error: result.error });
      return;
    }

    // ⭐ 合成成功 → 保存到全局资源 + 本地缓存
    if (!no_cache && dataDir && result.audio) {
      try {
        const textHash = crypto.createHash('md5').update(`${source}|${voice || 'alloy'}|${speed || 1.0}|${input}`).digest('hex');

        // 检查全局是否已有（防并发重复写入）
        // 先做 localBookId → globalBookId 映射
        const globalBookId2 = (() => {
          const ref = db.select().from(userBookRefs).where(
            sql`local_book_id = ${book_id} AND deleted_at IS NULL`
          ).get() as any;
          return ref?.globalBookId || book_id;
        })();

        let globalRes = findTtsGlobalResource(db, textHash, voice || 'alloy', speed || 1.0, globalBookId2, source);
        if (!globalRes && book_id) {
          // 存到全局目录
          const audioFormat = response_format || 'wav';
          const audioExt = audioFormat === 'mp3' ? '.mp3' : '.wav';
          const globalAudioDir = path.join(dataDir, 'tts-global');
          if (!fs.existsSync(globalAudioDir)) fs.mkdirSync(globalAudioDir, { recursive: true });
          const globalAudioPath = path.join(globalAudioDir, `${textHash}${audioExt}`);
          fs.writeFileSync(globalAudioPath, result.audio);

          globalRes = createTtsGlobalResource(db, globalBookId2, null, textHash, voice || 'alloy', speed || 1.0, globalAudioPath, result.audio.length, null, source);
        }

        if (globalRes) {
          createTtsRef(db, userId, globalRes.id, null);
        }

        // 同时保持本地缓存（向后兼容）
        saveToCache(db, dataDir, input, voice || 'alloy', speed || 1.0, result.audio, response_format || 'wav', userId, book_id, null, null, source);
      } catch { /* 缓存写入失败不影响主流程 */ }
    }

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Content-Length', result.audio!.length);
    res.setHeader('X-TTS-Cache', 'MISS');
    res.send(result.audio);
  });

  // ── 连接测试（POST 版本，无需登录；支持自定义 apiUrl/apiKey） ──
  router.post('/test', async (req: Request, res: Response) => {
    const apiUrl = req.body.apiUrl as string | undefined;
    const apiKey = req.body.apiKey as string | undefined;
    const result = await checkHealth(apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── TTS 设置读取（按用户隔离，返回 apiUrl/apiKey） ──
  router.get('/settings', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const row = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();
      if (!row) {
        // 无设置则返回默认值
        const defaults = {
          userId,
          enabled: true,
          source: 'openai',
          model: null as string | null,
          voiceId: 'alloy',
          speed: 1.0,
          apiUrl: null as string | null,
          apiKey: null as string | null,
          preGenerateConcurrency: 3,
          firstChunkMaxSize: 32,
          normalChunkMaxSize: 128,
          autoPreSynthesize: false,
          updatedAt: new Date().toISOString(),
        };
        db.insert(ttsSettings).values(defaults).run();
        res.json({ success: true, data: defaults });
        return;
      }
      res.json({ success: true, data: row });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to read TTS settings' });
    }
  });

  // ── TTS 设置保存（按用户隔离，支持 apiUrl/apiKey 持久化） ──
  router.put('/settings', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { enabled, source, model, voiceId, speed, apiUrl, apiKey, preGenerateConcurrency, firstChunkMaxSize, normalChunkMaxSize, autoPreSynthesize } = req.body;
      const now = new Date().toISOString();
      const existing = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();

      const updateData: any = { updatedAt: now };
      if (enabled !== undefined) updateData.enabled = enabled;
      if (source !== undefined) updateData.source = source;
      if (model !== undefined) updateData.model = model || null;
      if (voiceId !== undefined) updateData.voiceId = voiceId;
      if (speed !== undefined) updateData.speed = speed;
      if (apiUrl !== undefined) updateData.apiUrl = apiUrl || null;
      if (apiKey !== undefined) updateData.apiKey = apiKey || null;
      if (preGenerateConcurrency !== undefined) updateData.preGenerateConcurrency = preGenerateConcurrency;
      if (firstChunkMaxSize !== undefined) updateData.firstChunkMaxSize = firstChunkMaxSize;
      if (normalChunkMaxSize !== undefined) updateData.normalChunkMaxSize = normalChunkMaxSize;
      if (autoPreSynthesize !== undefined) updateData.autoPreSynthesize = autoPreSynthesize;

      if (existing) {
        db.update(ttsSettings).set(updateData).where(sql`user_id = ${userId}`).run();
      } else {
        db.insert(ttsSettings).values({
          userId,
          enabled: enabled ?? true,
          source: source ?? 'openai',
          model: model || null,
          voiceId: voiceId ?? 'alloy',
          speed: speed ?? 1.0,
          apiUrl: apiUrl || null,
          apiKey: apiKey || null,
          preGenerateConcurrency: preGenerateConcurrency ?? 3,
          firstChunkMaxSize: firstChunkMaxSize ?? 32,
          normalChunkMaxSize: normalChunkMaxSize ?? 128,
          autoPreSynthesize: autoPreSynthesize ?? false,
          updatedAt: now,
        }).run();
      }

      // 检测是否需要触发全量预生成任务（仅后台预合成开启时）
      // 合并处理「音色变更」和「自动预合成刚开启」两种场景，避免重复创建任务
      const isPreSynthOn = autoPreSynthesize !== undefined ? autoPreSynthesize : existing?.autoPreSynthesize;
      const wasPreSynthOff = existing && !existing.autoPreSynthesize;
      const voiceChanged = voiceId !== undefined && existing && existing.voiceId !== voiceId;

      if (dataDir && isPreSynthOn && (voiceChanged || (autoPreSynthesize === true && wasPreSynthOff))) {
        try {
          if (voiceChanged) {
            // 音色变更：为所有书创建新音色任务（createFullBookGenerationJob 内含去重检查）
            regenerateAllForNewVoice(db, userId, voiceId, speed ?? existing.speed ?? 1.0, dataDir);
          } else {
            // 刚开启自动预合成：为所有书创建任务
            const voice = existing?.voiceId || 'alloy';
            const spd = existing?.speed ?? 1.0;
            const userBooks = db.select().from(books).where(sql`user_id = ${userId}`).all();
            for (const b of userBooks) {
              createFullBookGenerationJob(db, b.id, userId, voice, spd, dataDir);
            }
          }
        } catch { /* 全量预合成触发失败不影响主流程 */ }
      }

      const updated = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();
      res.json({ success: true, data: updated });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to save TTS settings' });
    }
  });

  // ── TTS 缓存清除（按用户隔离） ──
  router.post('/cache/clear', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      if (!dataDir) {
        res.status(400).json({ success: false, error: '缓存目录未配置' });
        return;
      }
      const deleted = clearAllCache(db, dataDir, userId);
      res.json({ success: true, deleted, message: `已清除 ${deleted} 条缓存` });
    } catch (error) {
      res.status(500).json({ success: false, error: '清除缓存失败' });
    }
  });

  // ── GET /api/tts/batch-cache/:bookId - 批量获取某本书所有已缓存的音频段落 ──
  // 前端缓存全书时调用，跳过逐段 POST /api/tts，直接下载已预合成的音频文件
  // 现在支持从全局资源 + 本地缓存共同返回
  router.get('/batch-cache/:bookId', requireAuth, async (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { bookId } = req.params;
      const voice = (req.query.voice as string) || 'alloy';
      const speed = parseFloat(req.query.speed as string) || 1.0;
      const source = (req.query.source as string) || 'openai';

      // 1. 查全局资源：需要将 localBookId → globalBookId
      const userRef = db.select()
        .from(userBookRefs)
        .where(sql`local_book_id = ${bookId} AND deleted_at IS NULL`)
        .get() as any;
      const globalBookId = userRef?.globalBookId || bookId;

      const globalEntries = db.select()
        .from(ttsGlobalResources)
        .where(sql`book_id = ${globalBookId} AND voice = ${voice} AND speed = ${speed} AND source = ${source} AND deleted_at IS NULL`)
        .all() as any[];

      const segments: any[] = [];

      for (const entry of globalEntries) {
        if (!fs.existsSync(entry.audioPath)) continue;
        // 检查用户是否有引用，没有则自动创建
        const ref = db.select()
          .from(ttsRefs)
          .where(sql`user_id = ${userId} AND global_resource_id = ${entry.id} AND deleted_at IS NULL`)
          .get();
        if (!ref) {
          createTtsRef(db, userId, entry.id, null);
        }
        segments.push({
          chapterId: entry.chapterId,
          segmentIndex: entry.segmentIndex,
          textHash: entry.textHash,
          audioUrl: `/api/tts/cache-file/${entry.id}`,
          voice: entry.voice,
          speed: entry.speed,
          cachedAt: entry.createdAt,
          source: 'global',
        });
      }

      // 2. 补充本地缓存（未在全局资源表中的）
      const localEntries = findCachedSegmentsByBook(db, bookId, voice, speed, userId)
        .filter(entry => (entry.source || 'openai') === source);
      for (const local of localEntries) {
        // 去重：如果已包含相同 text_hash+voice+speed 的全局资源，跳过
        const alreadyExists = segments.some(s => s.textHash === local.textHash && s.voice === local.voice && s.speed === local.speed);
        if (!alreadyExists && local.chapterId && local.segmentIndex != null) {
          segments.push({
            chapterId: local.chapterId,
            segmentIndex: local.segmentIndex,
            textHash: local.textHash,
            audioUrl: `/api/tts/cache-file/${local.id}`,
            voice: local.voice,
            speed: local.speed,
            cachedAt: local.createdAt,
            source: 'local',
          });
        }
      }

      res.json({
        success: true,
        data: segments.filter(segment => segment.chapterId && segment.segmentIndex != null),
        total: segments.filter(segment => segment.chapterId && segment.segmentIndex != null).length,
      });
    } catch (error: any) {
      console.error('[TTS] 批量获取缓存失败:', error);
      res.status(500).json({ success: false, error: '批量获取缓存失败' });
    }
  });

  // ── GET /api/tts/cache-file/:cacheId - 下载指定缓存条目对应的音频文件 ──
  // 优先查全局资源，回退到本地缓存
  router.get('/cache-file/:cacheId', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { cacheId } = req.params;

      // 先查全局 TTS 资源
      const globalEntry = db.select().from(ttsGlobalResources).where(sql`id = ${cacheId}`).get() as any;
      if (globalEntry && fs.existsSync(globalEntry.audioPath)) {
        // 检查用户是否有引用
        const hasRef = db.select({ count: sql<number>`count(*)` })
          .from(ttsRefs)
          .where(sql`user_id = ${userId} AND global_resource_id = ${globalEntry.id} AND deleted_at IS NULL`)
          .get()?.count ?? 0;
        if (hasRef > 0) {
          const audioBuffer = fs.readFileSync(globalEntry.audioPath);
          const ext = path.extname(globalEntry.audioPath).toLowerCase();
          const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Disposition', `attachment; filename="${globalEntry.textHash}${ext}"`);
          res.send(audioBuffer);
          return;
        }
      }

      // 回退：本地 tts_cache
      const entry = db.select().from(ttsCache).where(sql`id = ${cacheId}`).get() as any;
      if (!entry) {
        res.status(404).json({ success: false, error: '缓存条目不存在' });
        return;
      }
      // 用户隔离检查
      if (entry.userId !== userId) {
        res.status(403).json({ success: false, error: '无权访问' });
        return;
      }
      if (!isCacheValid(entry)) {
        res.status(404).json({ success: false, error: '缓存文件已失效' });
        return;
      }
      const audioBuffer = fs.readFileSync(entry.audioPath);
      const ext = path.extname(entry.audioPath).toLowerCase();
      const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${entry.textHash}${ext}"`);
      res.send(audioBuffer);
    } catch (error: any) {
      console.error('[TTS] 下载缓存文件失败:', error);
      res.status(500).json({ success: false, error: '下载缓存文件失败' });
    }
  });


  // ── GET /api/tts/jobs - 获取当前用户所有 TTS 生成任务（含书名） ──
  router.get('/jobs', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const jobs = db.select().from(ttsGenerationJobs)
        .where(sql`tts_generation_jobs.user_id = ${userId}`)
        .orderBy(sql`tts_generation_jobs.created_at DESC`)
        .all() as any[];

      // 附带书名
      const enriched = jobs.map((job: any) => {
        const book = db.select({ title: books.title }).from(books)
          .where(sql`id = ${job.bookId}`)
          .get() as any;
        return { ...job, bookTitle: book?.title || '未知' };
      });

      res.json({ success: true, data: enriched });
    } catch (error) {
      res.status(500).json({ success: false, error: '获取 TTS 任务列表失败' });
    }
  });

  // ── DELETE /api/tts/jobs/:jobId - 取消单个生成任务 ──
  router.delete('/jobs/:jobId', requireAuth, (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const ok = cancelJob(db, jobId);
      if (!ok) {
        res.status(404).json({ success: false, error: '任务不存在或无法取消' });
        return;
      }
      res.json({ success: true, message: '任务已取消' });
    } catch (error) {
      res.status(500).json({ success: false, error: '取消任务失败' });
    }
  });

  // ── POST /api/tts/jobs/batch-cancel - 批量取消生成任务 ──
  router.post('/jobs/batch-cancel', requireAuth, (req: Request, res: Response) => {
    try {
      const { jobIds } = req.body;
      if (!Array.isArray(jobIds) || jobIds.length === 0) {
        res.status(400).json({ success: false, error: '请提供 jobIds 数组' });
        return;
      }
      const count = cancelJobs(db, jobIds);
      res.json({ success: true, cancelled: count, message: `已取消 ${count} 个任务` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: '批量取消任务失败' });
    }
  });

  // ── POST /api/tts/jobs/clear-all - 清除用户所有排队/运行中的任务 ──
  router.post('/jobs/clear-all', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const count = cancelAllUserJobs(db, userId);
      res.json({ success: true, cleared: count, message: `已清除 ${count} 个排队任务` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: '清除任务失败' });
    }
  });

  // ── POST /api/tts/jobs/delete - 删除指定任务（不限状态，直接删除记录） ──
  router.post('/jobs/delete', requireAuth, (req: Request, res: Response) => {
    try {
      const { jobIds } = req.body;
      if (!Array.isArray(jobIds) || jobIds.length === 0) {
        res.status(400).json({ success: false, error: '请提供 jobIds 数组' });
        return;
      }
      const count = deleteJobs(db, jobIds);
      res.json({ success: true, deleted: count, message: `已删除 ${count} 个任务` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: '批量删除任务失败' });
    }
  });

  // ── POST /api/tts/jobs/clear-terminated - 清除用户所有已完成/失败的任务 ──
  router.post('/jobs/clear-terminated', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const count = clearTerminatedJobs(db, userId);
      res.json({ success: true, cleared: count, message: `已清除 ${count} 个已完成/失败任务` });
    } catch (error: any) {
      res.status(500).json({ success: false, error: '清除任务失败' });
    }
  });

  return router;
}