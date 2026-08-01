/**
 * TTS 路由集成测试
 * 测试 TTS API 端点的正确响应（OpenAI 兼容模式）
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
  /** 语音端点可用（带 key 探测 /v1/audio/voices，与真实请求一致；/health 免鉴权不代表可用） */
  let ttsVoicesAvailable = false;
  /** models 端点可用（edge-tts 等部分服务无 /v1/models 端点） */
  let ttsModelsAvailable = false;
  /** 本地 edge-tts 服务默认 API Key（与 ai-agent edge-tts-server.py 对齐），可用环境变量覆盖 */
  const TTS_API_KEY = process.env.TTS_API_KEY || 'sk-tts-demo-key-2024';
  const TTS_BASE = 'http://127.0.0.1:8883';

  beforeAll(async () => {
    // 探测与真实请求一致：带 key 探测 voices/models 端点
    try {
      const voicesRes = await fetch(`${TTS_BASE}/v1/audio/voices`, {
        headers: { Authorization: `Bearer ${TTS_API_KEY}` },
        signal: AbortSignal.timeout(2000),
      });
      ttsVoicesAvailable = voicesRes.ok;
    } catch {
      ttsVoicesAvailable = false;
    }
    try {
      const modelsRes = await fetch(`${TTS_BASE}/v1/models`, {
        headers: { Authorization: `Bearer ${TTS_API_KEY}` },
        signal: AbortSignal.timeout(2000),
      });
      ttsModelsAvailable = modelsRes.ok;
    } catch {
      ttsModelsAvailable = false;
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
    it('should return OpenAI-compatible source', async () => {
      const res = await request(app).get('/api/tts/sources');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].id).toBe('openai');
    });
  });

  describe('GET /api/tts/voices', () => {
    it('should return voices list or error gracefully', async () => {
      const res = await request(app).get(`/api/tts/voices?apiUrl=${TTS_BASE}&apiKey=${TTS_API_KEY}`);
      if (ttsVoicesAvailable) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('voices');
        expect(Array.isArray(res.body.data.voices)).toBe(true);
      } else {
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
      }
    });
  });

  describe('GET /api/tts/models', () => {
    it('should return models list or error gracefully', async () => {
      const res = await request(app).get(`/api/tts/models?apiUrl=${TTS_BASE}&apiKey=${TTS_API_KEY}`);
      if (ttsModelsAvailable) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data).toHaveProperty('models');
        expect(Array.isArray(res.body.data.models)).toBe(true);
      } else {
        // 服务无 /v1/models 端点（如 edge-tts）→ 502 优雅降级
        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
      }
    });
  });

  describe('GET /api/tts/health', () => {
    it('should return health status or error gracefully', async () => {
      const res = await request(app).get(`/api/tts/health?apiUrl=${TTS_BASE}&apiKey=${TTS_API_KEY}`);
      if (ttsVoicesAvailable) {
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
      // POST /api/tts 从用户 TTS 设置读取 apiUrl/apiKey，先配置（与真实前端流程一致）；
      // 注意只设 apiUrl/apiKey，不碰 voiceId，避免污染后续「默认设置」断言（默认 voiceId='alloy'）
      await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ apiUrl: TTS_BASE, apiKey: TTS_API_KEY });
      const res = await request(app)
        .post('/api/tts')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ input: '你好世界', voice: 'zh-CN-XiaoxiaoNeural' });
      if (ttsVoicesAvailable) {
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
          .send({ apiUrl: TTS_BASE, apiKey: TTS_API_KEY });
        if (ttsVoicesAvailable) {
          expect(res.status).toBe(200);
          expect(res.body.success).toBe(true);
        } else {
          expect(res.status).toBe(502);
          expect(res.body.success).toBe(false);
        }
      } catch (err: any) {
        if (!ttsVoicesAvailable && (err.code === 'ECONNRESET' || err.message?.includes('socket hang up'))) {
          return;
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
      expect(res.body.data).toHaveProperty('model');
    });

    it('should have default values', async () => {
      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.data.source).toBe('openai');
      expect(res.body.data.voiceId).toBe('alloy');
      expect(res.body.data.speed).toBe(1.0);
      expect(res.body.data.enabled).toBe(true);
    });
  });

  describe('PUT /api/tts/settings', () => {
    it('should update TTS settings including model', async () => {
      const res = await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ source: 'openai', model: 'tts-1-hd', voiceId: 'echo', speed: 1.5, apiUrl: 'http://127.0.0.1:8883' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.model).toBe('tts-1-hd');
      expect(res.body.data.voiceId).toBe('echo');
      expect(res.body.data.speed).toBe(1.5);
      expect(res.body.data.apiUrl).toBe('http://127.0.0.1:8883');
    });

    it('should persist updated settings', async () => {
      const res = await request(app)
        .get('/api/tts/settings')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.body.data.model).toBe('tts-1-hd');
      expect(res.body.data.voiceId).toBe('echo');
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
      expect(res.body.data.model).toBe('tts-1-hd'); // should keep previous value
    });
  });
});
