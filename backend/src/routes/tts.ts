/**
 * TTS 路由 — Phase 2: 核心迁移
 * 提供语音服务选择、音色列表、连接测试、语音合成等 API
 */
import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { getSources, getVoices, checkHealth, synthesize } from '../services/ttsProxyService.js';
import { ttsSettings } from '../db/schema.js';
import { findCache, isCacheValid, saveToCache, clearAllCache, evictStaleCache } from '../services/ttsCacheService.js';

export function createTtsRouter(db: ReturnType<typeof import('../db/init.js').initDatabase>, dataDir?: string) {
  const router = Router();

  // ── TTS 源列表 ──
  router.get('/sources', (_req: Request, res: Response) => {
    const sources = getSources();
    res.json({ success: true, data: sources });
  });

  // ── 音色列表 ──
  router.get('/voices', async (req: Request, res: Response) => {
    const source = (req.query.source as string) || 'kokoro';
    const result = await getVoices(source);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 健康检查 / 连接测试 ──
  router.get('/health', async (req: Request, res: Response) => {
    const source = (req.query.source as string) || 'kokoro';
    const result = await checkHealth(source);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── 语音合成代理（带缓存） ──
  router.post('/', async (req: Request, res: Response) => {
    const { input, voice, speed, response_format, tts_source } = req.body;

    // 尝试从缓存读取
    if (dataDir) {
      try {
        const cached = findCache(db, input, voice || 'zf_xiaobei', speed || 1.0);
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

    const result = await synthesize({ input, voice, speed, response_format, tts_source });
    if (!result.success) {
      res.status(result.status || 502).json({ success: false, error: result.error });
      return;
    }

    // 保存到缓存
    if (dataDir && result.audio) {
      try {
        saveToCache(db, dataDir, input, voice || 'zf_xiaobei', speed || 1.0, result.audio, response_format || 'wav');
      } catch { /* 缓存写入失败不影响主流程 */ }
    }

    res.setHeader('Content-Type', result.contentType || 'audio/wav');
    res.setHeader('Content-Length', result.audio!.length);
    res.setHeader('X-TTS-Cache', 'MISS');
    res.send(result.audio);
  });

  // ── 连接测试（POST 版本，兼容前端表单） ──
  router.post('/test', async (req: Request, res: Response) => {
    const source = req.body.tts_source || 'kokoro';
    const result = await checkHealth(source);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  });

  // ── TTS 设置读取 ──
  router.get('/settings', (req: Request, res: Response) => {
    try {
      const row = db.select().from(ttsSettings).where(sql`id = 1`).get();
      if (!row) {
        res.status(404).json({ success: false, error: 'TTS settings not found' });
        return;
      }
      res.json({ success: true, data: row });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to read TTS settings' });
    }
  });

  // ── TTS 设置保存 ──
  router.put('/settings', (req: Request, res: Response) => {
    try {
      const { enabled, source, voiceId, speed, preGenerateConcurrency, firstChunkMaxSize, normalChunkMaxSize } = req.body;
      const now = new Date().toISOString();
      const existing = db.select().from(ttsSettings).where(sql`id = 1`).get();

      if (existing) {
        db.update(ttsSettings)
          .set({
            ...(enabled !== undefined ? { enabled } : {}),
            ...(source !== undefined ? { source } : {}),
            ...(voiceId !== undefined ? { voiceId } : {}),
            ...(speed !== undefined ? { speed } : {}),
            ...(preGenerateConcurrency !== undefined ? { preGenerateConcurrency } : {}),
            ...(firstChunkMaxSize !== undefined ? { firstChunkMaxSize } : {}),
            ...(normalChunkMaxSize !== undefined ? { normalChunkMaxSize } : {}),
            updatedAt: now,
          })
          .where(sql`id = 1`)
          .run();
      } else {
        db.insert(ttsSettings).values({
          id: 1,
          enabled: enabled ?? true,
          source: source ?? 'kokoro',
          voiceId: voiceId ?? 'zf_xiaobei',
          speed: speed ?? 1.0,
          preGenerateConcurrency: preGenerateConcurrency ?? 3,
          firstChunkMaxSize: firstChunkMaxSize ?? 32,
          normalChunkMaxSize: normalChunkMaxSize ?? 128,
          updatedAt: now,
        }).run();
      }

      const updated = db.select().from(ttsSettings).where(sql`id = 1`).get();
      res.json({ success: true, data: updated });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to save TTS settings' });
    }
  });

  // ── TTS 缓存清除 ──
  router.post('/cache/clear', (req: Request, res: Response) => {
    try {
      if (!dataDir) {
        res.status(400).json({ success: false, error: '缓存目录未配置' });
        return;
      }
      const deleted = clearAllCache(db, dataDir);
      res.json({ success: true, deleted, message: `已清除 ${deleted} 条缓存` });
    } catch (error) {
      res.status(500).json({ success: false, error: '清除缓存失败' });
    }
  });


  return router;
}
