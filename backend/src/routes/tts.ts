/**
 * TTS 路由 — 提供语音服务选择、音色列表、连接测试、语音合成等 API
 * 所有 API 需要用户登录鉴权（用户隔离）
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { getSources, getVoices, checkHealth, synthesize } from '../services/ttsProxyService.js';
import { ttsSettings, ttsCache } from '../db/schema.js';
import { findCache, isCacheValid, saveToCache, clearAllCache, evictStaleCache } from '../services/ttsCacheService.js';
import { requireAuth } from '../middleware/auth.js';
import { regenerateAllForNewVoice } from '../services/ttsGenerationService.js';

export function createTtsRouter(db: ReturnType<typeof import('../db/init.js').initDatabase>, dataDir?: string) {
  const router = Router();

  // ── TTS 源列表（无需登录，属于通用服务信息） ──
  router.get('/sources', (_req: Request, res: Response) => {
    const sources = getSources();
    res.json({ success: true, data: sources });
  });

  // ── 音色列表（无需登录；支持自定义 apiUrl/apiKey 查询参数） ──
  router.get('/voices', async (req: Request, res: Response) => {
    const source = (req.query.source as string) || process.env.TTS_DEFAULT_SOURCE || 'edgetts';
    const apiUrl = req.query.apiUrl as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const result = await getVoices(source, apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 健康检查 / 连接测试（无需登录；支持自定义 apiUrl/apiKey 查询参数） ──
  router.get('/health', async (req: Request, res: Response) => {
    const source = (req.query.source as string) || process.env.TTS_DEFAULT_SOURCE || 'edgetts';
    const apiUrl = req.query.apiUrl as string | undefined;
    const apiKey = req.query.apiKey as string | undefined;
    const result = await checkHealth(source, apiUrl, apiKey);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 语音合成代理（带缓存，按用户隔离；自动加载用户自定义 API 配置） ──
  router.post('/', requireAuth, async (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const { input, voice, speed, response_format, tts_source, no_cache } = req.body;

    // 加载用户的 TTS 设置（获取自定义 API URL/Key）
    const userSettings = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();
    const apiUrl = userSettings?.apiUrl || undefined;
    const apiKey = userSettings?.apiKey || undefined;
    const source = tts_source || userSettings?.source || process.env.TTS_DEFAULT_SOURCE || 'edgetts';

    // ⭐ 调试模式：no_cache=true 时跳过后端音频缓存，每次都实时合成
    if (!no_cache && dataDir) {
      try {
        const cached = findCache(db, input, voice || 'zh-CN-XiaoxiaoNeural', speed || 1.0, userId);
        if (cached && isCacheValid(cached)) {
          const audioBuffer = fs.readFileSync(cached.audioPath);
          const ext = path.extname(cached.audioPath).toLowerCase();
          const contentType = ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', audioBuffer.length);
          res.setHeader('X-TTS-Cache', 'HIT');
          res.send(audioBuffer);
          return;
        }
      } catch { /* 缓存读取失败，回退到实时合成 */ }
    }

    const result = await synthesize({ input, voice, speed, response_format, tts_source: source, apiUrl, apiKey });
    if (!result.success) {
      res.status(result.status || 502).json({ success: false, error: result.error });
      return;
    }

    // 保存到缓存（按用户隔离，调试模式 no_cache 时不写入缓存）
    if (!no_cache && dataDir && result.audio) {
      try {
        saveToCache(db, dataDir, input, voice || 'zh-CN-XiaoxiaoNeural', speed || 1.0, result.audio, response_format || 'wav', userId);
      } catch { /* 缓存写入失败不影响主流程 */ }
    }

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Content-Length', result.audio!.length);
    res.setHeader('X-TTS-Cache', 'MISS');
    res.send(result.audio);
  });

  // ── 连接测试（POST 版本，无需登录；支持自定义 apiUrl/apiKey） ──
  router.post('/test', async (req: Request, res: Response) => {
    const source = req.body.tts_source || process.env.TTS_DEFAULT_SOURCE || 'edgetts';
    const apiUrl = req.body.apiUrl as string | undefined;
    const apiKey = req.body.apiKey as string | undefined;
    const result = await checkHealth(source, apiUrl, apiKey);
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
          source: process.env.TTS_DEFAULT_SOURCE || 'edgetts',
          voiceId: 'zh-CN-XiaoxiaoNeural',
          speed: 1.0,
          apiUrl: null as string | null,
          apiKey: null as string | null,
          preGenerateConcurrency: 3,
          firstChunkMaxSize: 32,
          normalChunkMaxSize: 128,
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
  router.put('/settings', requireAuth, (req: Request, res: Response) => {
    try {
      const userId = req.user!.userId;
      const { enabled, source, voiceId, speed, apiUrl, apiKey, preGenerateConcurrency, firstChunkMaxSize, normalChunkMaxSize } = req.body;
      const now = new Date().toISOString();
      const existing = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();

      const updateData: any = { updatedAt: now };
      if (enabled !== undefined) updateData.enabled = enabled;
      if (source !== undefined) updateData.source = source;
      if (voiceId !== undefined) updateData.voiceId = voiceId;
      if (speed !== undefined) updateData.speed = speed;
      if (apiUrl !== undefined) updateData.apiUrl = apiUrl || null;
      if (apiKey !== undefined) updateData.apiKey = apiKey || null;
      if (preGenerateConcurrency !== undefined) updateData.preGenerateConcurrency = preGenerateConcurrency;
      if (firstChunkMaxSize !== undefined) updateData.firstChunkMaxSize = firstChunkMaxSize;
      if (normalChunkMaxSize !== undefined) updateData.normalChunkMaxSize = normalChunkMaxSize;

      if (existing) {
        db.update(ttsSettings).set(updateData).where(sql`user_id = ${userId}`).run();
      } else {
        db.insert(ttsSettings).values({
          userId,
          enabled: enabled ?? true,
          source: source ?? (process.env.TTS_DEFAULT_SOURCE || 'edgetts'),
          voiceId: voiceId ?? 'zh-CN-XiaoxiaoNeural',
          speed: speed ?? 1.0,
          apiUrl: apiUrl || null,
          apiKey: apiKey || null,
          preGenerateConcurrency: preGenerateConcurrency ?? 3,
          firstChunkMaxSize: firstChunkMaxSize ?? 32,
          normalChunkMaxSize: normalChunkMaxSize ?? 128,
          updatedAt: now,
        }).run();
      }

      // 检测音色是否变更，若变更则异步触发全量预生成
      if (voiceId !== undefined && existing && existing.voiceId !== voiceId && dataDir) {
        try {
          regenerateAllForNewVoice(db, userId, voiceId, speed ?? existing.speed ?? 1.0, dataDir);
        } catch { /* 触发预生成失败不影响主流程 */ }
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

  return router;
}
