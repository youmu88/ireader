/**
 * 用户偏好 KV 路由集成测试
 * 覆盖：读空态 / upsert / 覆盖更新 / 用户隔离 / key 校验 / 值大小限制 / 未登录 401
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from './auth.js';
import { createPrefsRouter } from './prefs.js';
import { errorHandler } from '../middleware/errorHandler.js';

// D34：secUserEmail.json 已移出仓库，CI/新环境无此文件时写入测试用白名单
const SEC_EMAIL_PATH = path.resolve(__dirname, '..', '..', 'secUserEmail.json');

describe('User Prefs Routes', () => {
  const testDbPath = path.join('/tmp', `prefs-test-${Date.now()}.sqlite`);
  let app: express.Express;
  let tokenA: string;
  let tokenB: string;

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
    app.use('/api/prefs', createPrefsRouter(db));
    app.use(errorHandler);

    const rA = await request(app)
      .post('/api/auth/register')
      .send({ email: '276935214@qq.com', password: 'test123456' });
    tokenA = rA.body.data.token;
    const rB = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'test123456' });
    tokenB = rB.body.data.token;
  });

  afterAll(() => {
    try {
      for (const ext of ['', '-wal', '-shm']) {
        const p = testDbPath + ext;
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    } catch { /* ignore */ }
  });

  it('读空态：无偏好时返回空对象', async () => {
    const res = await request(app).get('/api/prefs').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.prefs).toEqual({});
  });

  it('PUT upsert 后 GET 可读回', async () => {
    const put = await request(app)
      .put('/api/prefs/ireader_scroll_damping')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ value: '5' });
    expect(put.status).toBe(200);
    expect(put.body.data.key).toBe('ireader_scroll_damping');
    expect(put.body.data.updatedAt).toBeTruthy();

    const get = await request(app).get('/api/prefs').set('Authorization', `Bearer ${tokenA}`);
    expect(get.body.data.prefs.ireader_scroll_damping.value).toBe('5');
  });

  it('再次 PUT 覆盖同 key 并刷新 updatedAt', async () => {
    await request(app).put('/api/prefs/ireader-theme').set('Authorization', `Bearer ${tokenA}`).send({ value: 'light' });
    const first = await request(app).get('/api/prefs').set('Authorization', `Bearer ${tokenA}`);
    const t1 = first.body.data.prefs['ireader-theme'].updatedAt;
    await new Promise(r => setTimeout(r, 10));
    await request(app).put('/api/prefs/ireader-theme').set('Authorization', `Bearer ${tokenA}`).send({ value: 'dark' });
    const second = await request(app).get('/api/prefs').set('Authorization', `Bearer ${tokenA}`);
    expect(second.body.data.prefs['ireader-theme'].value).toBe('dark');
    expect(second.body.data.prefs['ireader-theme'].updatedAt >= t1).toBe(true);
  });

  it('用户隔离：B 用户看不到 A 的偏好', async () => {
    const res = await request(app).get('/api/prefs').set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.data.prefs).toEqual({});
  });

  it('非法 key → 400', async () => {
    const res = await request(app)
      .put('/api/prefs/bad%20key!').set('Authorization', `Bearer ${tokenA}`).send({ value: 'x' });
    expect(res.status).toBe(400);
  });

  it('超大 value → 413', async () => {
    const res = await request(app)
      .put('/api/prefs/big_key').set('Authorization', `Bearer ${tokenA}`)
      .send({ value: 'x'.repeat(17 * 1024) });
    expect(res.status).toBe(413);
  });

  it('未登录 → 401', async () => {
    const res = await request(app).get('/api/prefs');
    expect([401, 403]).toContain(res.status);
  });
});
