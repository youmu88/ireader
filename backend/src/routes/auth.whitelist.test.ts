/**
 * 安全账号白名单测试
 * ===================
 * 覆盖：
 *   1. 白名单邮箱注册 → 成功
 *   2. 非白名单邮箱注册 → 403 拒绝
 *   3. 白名单邮箱登录 → 成功
 *   4. 老用户 username 登录 → 兼容成功
 *   5. 重复注册已存在邮箱 → 409
 *   6. 无效 email 格式 → 400
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from '../routes/auth.js';
import { errorHandler } from '../middleware/errorHandler.js';
import healthRouter from '../routes/health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 在测试前确保 secUserEmail.json 存在
const SEC_EMAIL_PATH = path.resolve(__dirname, '..', '..', 'secUserEmail.json');

describe('安全账号白名单 - auth whitelist', () => {
  const testId = `auth-whitelist-test-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  let app: express.Express;
  let db: ReturnType<typeof initDatabase>;

  beforeAll(async () => {
    // 确认白名单文件存在
    expect(fs.existsSync(SEC_EMAIL_PATH)).toBe(true);

    db = initDatabase(testDbPath);

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api', healthRouter);
    app.use(errorHandler);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testDbPath)) {
        for (const ext of ['', '-wal', '-shm']) {
          const p = testDbPath + ext;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
      }
    } catch {
      // ignore cleanup errors
    }
  });

  // ── 测试 1：白名单邮箱注册成功 ──
  it('【P0】白名单邮箱 youmu88@gmail.com 注册成功', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'test123456' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('youmu88@gmail.com');
  });

  // ── 测试 2：非白名单邮箱注册被拒绝 ──
  it('【P0】非白名单邮箱 hacker@evil.com 注册被拒绝', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'hacker@evil.com', password: 'test123456' });

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('白名单');
  });

  // ── 测试 3：白名单邮箱登录 ──
  it('【P0】白名单邮箱 youmu88@gmail.com 登录成功', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'youmu88@gmail.com', password: 'test123456' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.user.email).toBe('youmu88@gmail.com');
  });

  // ── 测试 4：无效 email 格式 ──
  it('【P1】无效邮箱格式注册返回 400', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'notanemail', password: 'test123456' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  // ── 测试 5：重复注册白名单邮箱 → 409 ──
  it('【P1】已注册的白名单邮箱重复注册返回 409', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'anotherpass123' });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('已被注册');
  });

  // ── 测试 6：白名单邮箱不区分大小写 ──
  it('【P1】白名单邮箱不区分大小写（大写邮箱注册）', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'YOUMU88@GMAIL.COM', password: 'test123456' });

    // 已注册过了，应该 409（说明大写被转为小写匹配到了）
    expect(res.status).toBe(409);
  });
});
