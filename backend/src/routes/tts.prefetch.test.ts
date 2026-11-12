/**
 * POST /api/tts/prefetch-chapter 端点测试（听书适配性：当前章预合成）
 * - 鉴权 401 / 参数 400 / 书 404
 * - 正常触发：建章级高优 job（created=true, pendingChunks>0）
 * - 幂等去重：重复调用复用同一 pending job（jobId 不变、段行不重复）
 * - TTS 关闭：created=false, disabled=true
 * - 缓存全命中：不建任务（created=false, cachedAll=true）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { sql } from 'drizzle-orm';
import { initDatabase } from '../db/init.js';
import { books, bookChapters, ttsSettings, ttsGenerationJobs, ttsGenerationSegments } from '../db/schema.js';
import { createAuthRouter } from '../routes/auth.js';
import { createTtsRouter } from '../routes/tts.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { saveToCache, findCache, isCacheValid } from '../services/ttsCacheService.js';
import { ensureChapterSegments } from '../services/contentSegmentService.js';

describe('POST /api/tts/prefetch-chapter', () => {
  const testId = `tts-prefetch-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  const dataDir = path.join('/tmp', `${testId}-data`);
  let app: express.Express;
  let db: ReturnType<typeof initDatabase>;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    db = initDatabase(testDbPath);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api/tts', createTtsRouter(db, dataDir));
    app.use(errorHandler);

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email: 'youmu88@gmail.com', password: 'test123456' });
    expect(reg.status).toBe(201);
    token = reg.body.data.token;
    userId = reg.body.data.user.userId;

    const now = new Date().toISOString();
    db.insert(books).values({
      id: 'pf-book', userId, title: '预合成测试书', format: 'txt',
      filePath: `/tmp/${testId}-book.txt`, size: 1, createdAt: now, updatedAt: now,
    }).run();
    db.insert(bookChapters).values({
      id: 'pf-ch1', bookId: 'pf-book', title: '第一章 测试章', order: 0,
      normalizedText: '第一章 测试章\n这是第一章的正文内容。它足够长，会被切成多个朗读分段。'.repeat(20),
      startOffset: 0, endOffset: 800, createdAt: now, updatedAt: now,
    }).run();
    db.insert(bookChapters).values({
      id: 'pf-ch2', bookId: 'pf-book', title: '第二章', order: 1,
      normalizedText: '第二章正文，足够长以产生多个分段，用于验证缓存全命中时不建任务。'.repeat(30),
      startOffset: 800, endOffset: 1600, createdAt: now, updatedAt: now,
    }).run();
  });

  afterAll(() => {
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.unlinkSync(testDbPath); } catch { /* ignore */ }
  });

  it('未登录 → 401', async () => {
    const res = await request(app).post('/api/tts/prefetch-chapter').send({ bookId: 'pf-book', chapterId: 'pf-ch1' });
    expect(res.status).toBe(401);
  });

  it('缺参数 → 400', async () => {
    const res = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book' });
    expect(res.status).toBe(400);
  });

  it('书不存在/非本人 → 404', async () => {
    const res = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'no-such-book', chapterId: 'pf-ch1' });
    expect(res.status).toBe(404);
  });

  it('正常触发：建章级 job，段数>0，chapter_id 落库', async () => {
    const res = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book', chapterId: 'pf-ch1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.pendingChunks).toBeGreaterThan(0);
    const job = db.select().from(ttsGenerationJobs)
      .where(sql`book_id = 'pf-book' AND chapter_id = 'pf-ch1'`)
      .get() as any;
    expect(job).toBeTruthy();
    // 后台 tryProcessQueue 会立即开始执行（测试环境引擎不可达会很快 failed），只断言任务已建立
    expect(['pending', 'running', 'failed']).toContain(job.status);
    expect(job.chapterId).toBe('pf-ch1');
    const rows = db.select().from(ttsGenerationSegments)
      .where(sql`job_id = ${job.id}`)
      .all() as any[];
    expect(rows.length).toBe(res.body.data.pendingChunks);
  });

  it('幂等去重：重复触发复用同一 pending job，段行不重复', async () => {
    const first = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book', chapterId: 'pf-ch1' });
    const second = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book', chapterId: 'pf-ch1' });
    expect(second.body.data.created).toBe(true);
    expect(second.body.data.jobId).toBe(first.body.data.jobId);
    const rows = db.select().from(ttsGenerationSegments)
      .where(sql`job_id = ${first.body.data.jobId}`)
      .all() as any[];
    expect(rows.length).toBe(first.body.data.pendingChunks);
  });

  it('TTS 关闭 → created=false, disabled=true', async () => {
    db.insert(ttsSettings).values({ userId, enabled: false, updatedAt: new Date().toISOString() }).run();
    const res = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book', chapterId: 'pf-ch2' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.disabled).toBe(true);
    db.update(ttsSettings).set({ enabled: true }).where(sql`user_id = ${userId}`).run();
  });

  it('缓存全命中 → 不建任务（created=false, cachedAll=true）', async () => {
    const ch = db.select().from(bookChapters).where(sql`id = 'pf-ch2'`).get() as any;
    const segs = ensureChapterSegments(db, 'pf-book', ch);
    // 与默认引擎配置一致地写缓存（voice=alloy/speed=1/source=openai）
    let cached = 0;
    for (const seg of segs) {
      saveToCache(db, dataDir, seg.text, 'alloy', 1.0, Buffer.from('fake-audio'), 'wav', userId, 'pf-book', seg.chapterId, seg.segmentIndex, 'openai', '', undefined);
      const hit = findCache(db, seg.text, 'alloy', 1.0, userId, 'openai', '', undefined);
      if (hit && isCacheValid(hit)) cached++;
    }
    expect(cached).toBe(segs.length); // 前置：缓存确实全命中（防 saveToCache 静默失败）
    const res = await request(app)
      .post('/api/tts/prefetch-chapter')
      .set('Authorization', `Bearer ${token}`)
      .send({ bookId: 'pf-book', chapterId: 'pf-ch2' });
    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(false);
    expect(res.body.data.cachedAll).toBe(true);
  });
});
