/**
 * Phase 0 安全加固测试
 * ====================
 * 覆盖：
 *   - D6  JWT_SECRET 启动强校验（缺失/过短拒启）
 *   - D8  TTS 五接口（sources/voices/models/health/test）鉴权 + apiUrl 协议校验
 *   - D24 阅读进度版本号服务端权威（客户端投毒值不参与版本计算）
 *   - D25 GET /settings apiKey 掩码脱敏 + PUT 掩码不覆盖真值
 *   - 登录限速（滑动窗 5 次/分钟/IP，成功不计入，窗口过期恢复）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { initDatabase } from '../db/init.js';
import { books } from '../db/schema.js';
import { createAuthRouter } from '../routes/auth.js';
import { createTtsRouter } from '../routes/tts.js';
import { createProgressRouter } from '../routes/progress.js';
import { createLoginRateLimiter } from '../middleware/rateLimit.js';
import { assertJwtSecret } from '../middleware/auth.js';
import { unsafeApiUrlReason } from '../middleware/urlGuard.js';
import { errorHandler } from '../middleware/errorHandler.js';

describe('Phase 0 安全加固', () => {
  const testId = `phase0-security-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  let app: express.Express;
  let db: ReturnType<typeof initDatabase>;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    db = initDatabase(testDbPath);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api/tts', createTtsRouter(db));
    app.use('/api', createProgressRouter(db));
    app.use(errorHandler);

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'test123456' });
    expect(reg.status).toBe(201);
    token = reg.body.data.token;
    userId = reg.body.data.user.userId;

    // 为 D24 测试准备一本书
    const now = new Date().toISOString();
    db.insert(books).values({
      id: 'p0-progress-book',
      userId,
      title: 'Phase0 测试书',
      format: 'txt',
      filePath: `/tmp/${testId}-book.txt`,
      size: 1,
      createdAt: now,
      updatedAt: now,
    }).run();
  });

  afterAll(() => {
    try {
      for (const ext of ['', '-wal', '-shm']) {
        const p = testDbPath + ext;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch { /* ignore */ }
  });

  // ─────────── D6：JWT_SECRET 启动强校验 ───────────
  describe('D6 JWT_SECRET 启动强校验', () => {
    function withEnv(value: string | undefined, fn: () => void): void {
      const orig = process.env.JWT_SECRET;
      if (value === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = value;
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('PROCESS_EXIT');
      }) as never);
      try {
        fn();
      } finally {
        exitSpy.mockRestore();
        if (orig === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = orig;
      }
    }

    it('缺失 JWT_SECRET → process.exit(1)', () => {
      withEnv(undefined, () => {
        expect(() => assertJwtSecret()).toThrow('PROCESS_EXIT');
      });
    });

    it('JWT_SECRET 短于 32 字符 → process.exit(1)', () => {
      withEnv('short-secret', () => {
        expect(() => assertJwtSecret()).toThrow('PROCESS_EXIT');
      });
    });

    it('合法 JWT_SECRET（≥32 字符）→ 正常通过', () => {
      withEnv('a'.repeat(32), () => {
        expect(() => assertJwtSecret()).not.toThrow();
      });
    });
  });

  // ─────────── D8：TTS 五接口鉴权 + 协议校验 ───────────
  describe('D8 TTS 接口鉴权与 SSRF 收口', () => {
    it('未登录访问 sources/voices/models/health → 401', async () => {
      const paths = ['/api/tts/sources', '/api/tts/voices', '/api/tts/models', '/api/tts/health'];
      for (const p of paths) {
        const res = await request(app).get(p);
        expect(res.status).toBe(401);
      }
    });

    it('未登录 POST /api/tts/test → 401', async () => {
      const res = await request(app).post('/api/tts/test').send({ apiUrl: 'http://127.0.0.1:8883' });
      expect(res.status).toBe(401);
    });

    it('登录后访问 sources → 200（纯静态列表，不外呼）', async () => {
      const res = await request(app).get('/api/tts/sources').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('登录后非 http/https 协议 apiUrl → 400（外呼发生前拦截）', async () => {
      const res = await request(app)
        .get('/api/tts/voices?apiUrl=' + encodeURIComponent('ftp://example.com'))
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('http/https');
    });

    it('内网/本机地址不因协议校验被拒（自部署同机 TTS 场景保留）', async () => {
      const res = await request(app)
        .get('/api/tts/voices?apiUrl=' + encodeURIComponent('http://127.0.0.1:59999'))
        .set('Authorization', `Bearer ${token}`);
      // 本机无服务 → 502（外呼失败），但绝不应是 400（协议校验放行）或 401
      expect(res.status).toBe(502);
    });
  });

  describe('urlGuard 协议校验纯函数', () => {
    it('http/https 放行（含内网地址）', () => {
      expect(unsafeApiUrlReason('http://127.0.0.1:8883')).toBeNull();
      expect(unsafeApiUrlReason('https://api.openai.com/v1')).toBeNull();
      expect(unsafeApiUrlReason('http://192.168.1.10:9999')).toBeNull();
    });

    it('非 http/https 协议拒绝', () => {
      expect(unsafeApiUrlReason('ftp://example.com')).toContain('http/https');
      expect(unsafeApiUrlReason('file:///etc/passwd')).toContain('http/https');
      expect(unsafeApiUrlReason('javascript:alert(1)')).toContain('http/https');
    });

    it('非法 URL 与空值处理', () => {
      expect(unsafeApiUrlReason('not-a-url')).toContain('格式不正确');
      expect(unsafeApiUrlReason('')).toBeNull();
      expect(unsafeApiUrlReason(undefined)).toBeNull();
    });
  });

  // ─────────── D25：apiKey 掩码脱敏 ───────────
  describe('D25 apiKey 掩码脱敏', () => {
    it('PUT 明文后 GET 返回掩码（尾 4 位），不含明文', async () => {
      const put = await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ apiKey: 'sk-test-abcdef123456' });
      expect(put.status).toBe(200);

      const res = await request(app).get('/api/tts/settings').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.apiKey).toMatch(/^\*\*.*3456$/);
      expect(res.body.data.apiKey).not.toContain('abcdef');
      expect(res.body.data.hasApiKey).toBe(true);
    });

    it('PUT 掩码值视为未修改，不覆盖真值', async () => {
      const put = await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ apiKey: '****9999' });
      expect(put.status).toBe(200);

      const res = await request(app).get('/api/tts/settings').set('Authorization', `Bearer ${token}`);
      expect(res.body.data.apiKey).toMatch(/^\*\*.*3456$/); // 仍是原值尾 4 位
    });

    it('PUT 空字符串清除 apiKey', async () => {
      await request(app)
        .put('/api/tts/settings')
        .set('Authorization', `Bearer ${token}`)
        .send({ apiKey: '' });
      const res = await request(app).get('/api/tts/settings').set('Authorization', `Bearer ${token}`);
      expect(res.body.data.apiKey).toBeNull();
      expect(res.body.data.hasApiKey).toBe(false);
    });
  });

  // ─────────── D24：进度版本号服务端权威 ───────────
  describe('D24 进度版本号防投毒', () => {
    const putProgress = (version: number) =>
      request(app)
        .put('/api/books/p0-progress-book/progress')
        .set('Authorization', `Bearer ${token}`)
        .send({ chapterId: 'ch-1', percentage: 10, progressVersion: version, deviceId: 'phase0-test' });

    it('客户端投毒超大版本号 → 服务端仍按自身 max+1 递增', async () => {
      const r1 = await putProgress(999999);
      expect(r1.status).toBe(200);
      expect(r1.body.data.progressVersion).toBe(1); // 首写固定 1，不采纳 999999

      const r2 = await putProgress(999999);
      expect(r2.body.data.progressVersion).toBe(2); // 服务端权威 +1
    });

    it('过期版本仍被拒写（冲突保护保留），返回服务端最新状态', async () => {
      const res = await putProgress(0); // 过期版本
      expect(res.status).toBe(200);
      expect(res.body.conflict).toBe(true);
      expect(res.body.data.progressVersion).toBe(2);
    });
  });

  // ─────────── 登录限速 ───────────
  describe('登录限速（滑动窗）', () => {
    it('失败达上限后 allow=false，其他 IP 不受影响', () => {
      const limiter = createLoginRateLimiter(60_000, 5);
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow('10.0.0.1')).toBe(true);
        limiter.recordFailure('10.0.0.1');
      }
      expect(limiter.allow('10.0.0.1')).toBe(false);
      expect(limiter.allow('10.0.0.2')).toBe(true);
    });

    it('窗口过期后恢复（windowMs=10ms）', async () => {
      const limiter = createLoginRateLimiter(10, 1);
      limiter.recordFailure('expired-ip');
      expect(limiter.allow('expired-ip')).toBe(false);
      await new Promise(r => setTimeout(r, 20));
      expect(limiter.allow('expired-ip')).toBe(true);
    });

    it('集成：连续失败 5 次后第 6 次登录返回 429；成功登录不计入失败', async () => {
      // 成功登录 5 次不应触发限速
      for (let i = 0; i < 5; i++) {
        const ok = await request(app)
          .post('/api/auth/login')
          .send({ email: 'youmu88@gmail.com', password: 'test123456' });
        expect(ok.status).toBe(200);
      }
      // 失败 5 次后第 6 次 → 429
      for (let i = 0; i < 5; i++) {
        const bad = await request(app)
          .post('/api/auth/login')
          .send({ email: 'ratelimit-probe@x.com', password: 'wrong-password' });
        expect(bad.status).toBe(401);
      }
      const blocked = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ratelimit-probe@x.com', password: 'wrong-password' });
      expect(blocked.status).toBe(429);
    });
  });
});
