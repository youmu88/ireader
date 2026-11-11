/**
 * 登出路由集成测试
 * 覆盖：已登录 200 success / 未认证 401
 * （JWT 无状态：服务端仅返回契约响应，登出由前端 removeToken 完成）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from './auth.js';
import { errorHandler } from '../middleware/errorHandler.js';

const SEC_EMAIL_PATH = path.resolve(__dirname, '..', '..', 'secUserEmail.json');

describe('Auth Logout Route', () => {
  const testDbPath = path.join('/tmp', `auth-logout-test-${Date.now()}.sqlite`);
  let app: express.Express;
  let token: string;

  beforeAll(async () => {
    if (!fs.existsSync(SEC_EMAIL_PATH)) {
      fs.writeFileSync(
        SEC_EMAIL_PATH,
        JSON.stringify(['youmu88@gmail.com', '276935214@qq.com'], null, 2),
        'utf-8',
      );
    }
    const db = initDatabase(testDbPath);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use(errorHandler);

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'Passw0rd!', displayName: '登出测试' });
    expect([200, 201]).toContain(reg.status);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'youmu88@gmail.com', password: 'Passw0rd!' });
    expect(login.status).toBe(200);
    token = login.body.data?.token ?? login.body.token;
    expect(token).toBeTruthy();
  });

  afterAll(() => {
    try {
      fs.rmSync(testDbPath, { force: true });
      fs.rmSync(`${testDbPath}-wal`, { force: true });
      fs.rmSync(`${testDbPath}-shm`, { force: true });
    } catch { /* ignore */ }
  });

  it('POST /logout 已登录 → 200 success', async () => {
    const res = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /logout 未认证 → 401', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });
});
