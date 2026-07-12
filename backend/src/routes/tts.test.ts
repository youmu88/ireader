/**
 * TTS 路由集成测试
 * 测试 TTS API 端点的正确响应
 * 注意：Kokoro TTS 服务可能在 8880 端口运行，测试会动态适配
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from './auth.js';
import { createTtsRouter } from './tts.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('TTS Routes', () => {
  const testId = `tts-test-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  let app: express.Express;
  let authToken: string;
  let ttsAvailable = false;

  beforeAll(async () => {
    // Check if TTS backend is available
    try {
      const healthRes = await fetch('http://127.0.0.1:8883/health', { signal: AbortSignal.timeout(2000) });
      ttsAvailable = healthRes.ok;
    } catch {
      ttsAvailable = false;
    }

    const db = initDatabase(testDbPath);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api/tts', createTtsRouter(db));
    app.use(errorHandler);

    // Register a test user and get token
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ email: '276935214@qq.com', password: 'test123456' });
    authToken = registerRes.body.data.token;
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch { /* ignore */ }
  });

  describe('GET /api/tts/sources', () => {
    it('should return TTS sources list', async () => {
      const res = await request(app).get('/api/tts/sources');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data[0]).toHaveProperty('id');
      expect(res.body.data[0]).toHaveProperty('name');
      expect(res.body.data[0]).toHaveProperty('description');
    });

    it('should include kokoro as default source', async () => {
      const res = await request(app).get('/api/tts/sources');
      const kokoro = res.body.data.find((s: any) => s.id === 'kokoro');
      expect(kokoro).toBeDefined();
      expect(kokoro.name).toContain('Kokoro');
    });
  });

  describe('GET /api/tts/voices', () => {
    it('should return voices list or error gracefully', async () => {
      const res = await request(app).get('/api/tts/voices?source=edgetts');
      if (ttsAvailable) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('voices');
        expect(Array.isArray(res.body.data.voices)).toBe(true);
        expect(res.body.data.voices.length).toBeGreaterThan(0);
      } else {
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
      }
    });
  });

  describe('GET /api/tts/health', () => {
    it('should return health status or error gracefully', async () => {
      const res = await request(app).get('/api/tts/health?source=edgetts');
      if (ttsAvailable) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body).toHaveProperty('status');
      } else {
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
      }
    });
  });

  describe('POST /api/tts', () => {
    it('should synthesize audio or return error gracefully', async () => {
      const res = await request(app)
        .post('/api/tts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ input: '你好世界', voice: 'zh-CN-XiaoxiaoNeural' });
      if (ttsAvailable) {
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^audio\//);
        expect(parseInt(res.headers['content-length'] || '0')).toBeGreaterThan(0);
      } else {
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
      }
    }, 15000);
  });

  describe('POST /api/tts/test', () => {
    it('should test connection or return error gracefully', async () => {
      try {
        const res = await request(app)
          .post('/api/tts/test')
          .send({ tts_source: 'edgetts' });
        if (ttsAvailable) {
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        } else {
          expect(res.status).toBe(502);
          expect(res.body.success).toBe(false);
        }
      } catch (err: any) {
        // 当 TTS 服务不可用时，某些环境可能抛出 ECONNRESET
        if (!ttsAvailable && (err.code === 'ECONNRESET' || err.message?.includes('socket hang up'))) {
          return; // TTS 服务未运行，连接被重置属于正常行为
        }
        throw err;
      }
    });
  });

  describe('GET /api/tts/settings', () => {
    it('should return TTS settings from database', async () => {
      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('source');
      expect(res.body.data).toHaveProperty('voiceId');
      expect(res.body.data).toHaveProperty('speed');
    });

    it('should have default values', async () => {
      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.data.source).toBe('edgetts');
      expect(res.body.data.voiceId).toBe('zh-CN-XiaoxiaoNeural');
      expect(res.body.data.speed).toBe(1.0);
      expect(res.body.data.enabled).toBe(true);
    });
  });

  describe('PUT /api/tts/settings', () => {
    it('should update TTS settings', async () => {
      const res = await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ source: 'megatts3', voiceId: 'voice1', speed: 1.5 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.source).toBe('megatts3');
      expect(res.body.data.voiceId).toBe('voice1');
      expect(res.body.data.speed).toBe(1.5);
    });

    it('should persist updated settings', async () => {
      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.data.source).toBe('megatts3');
      expect(res.body.data.voiceId).toBe('voice1');
    });

    it('should allow partial updates', async () => {
      await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ speed: 0.8 });

      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.data.speed).toBe(0.8);
      expect(res.body.data.source).toBe('megatts3'); // should keep previous value
    });
  });
});
