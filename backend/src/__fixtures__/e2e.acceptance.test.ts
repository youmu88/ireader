/**
 * iReader E2E 全链路验收测试
 * ===========================
 * 覆盖完整用户路径：
 *   上传 EPUB → 阅读 → 保存进度 → 播放 → 恢复
 *   上传 TXT  → 阅读 → 保存进度 → 播放 → 恢复
 *   分类筛选、设置、部署验收
 *
 * 验收标准（Milestone 7）：
 *   - 一期核心路径全部通过
 *   - 构建无错误
 *   - 部署脚本可完成部署（smoke test 独立覆盖）
 *   - README 可指导启动和部署
 *   - 无阻塞级 bug
 */
/**
 * iReader E2E 全链路验收测试（带账号鉴权）
 * =======================================
 * 覆盖完整用户路径：
 *   注册/登录 → 上传 EPUB → 阅读 → 保存进度 → 恢复
 *   上传 TXT  → 阅读 → 保存进度 → 恢复
 *   分类筛选、设置
 *
 * 所有 API 请求均需附带 Bearer Token（除 health/auth 外）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from '../routes/auth.js';
import { createBooksRouter } from '../routes/books.js';
import { createCategoriesRouter } from '../routes/categories.js';
import { createProgressRouter } from '../routes/progress.js';
import { createTtsRouter } from '../routes/tts.js';
import healthRouter from '../routes/health.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { v4 as uuidv4 } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, 'samples');

describe('E2E Full Flow Acceptance', () => {
  const testId = `ireader-e2e-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  const testDataDir = path.join('/tmp', testId);
  let app: express.Express;
  let db: ReturnType<typeof initDatabase>;
  let authToken: string;
  let epubId: string;
  let txtId: string;
  let epubChapterIds: string[] = [];
  let txtChapterIds: string[] = [];
  const auth = () => ({ 'Authorization': `Bearer ${authToken}` });

  beforeAll(async () => {
    fs.mkdirSync(testDataDir, { recursive: true });
    db = initDatabase(testDbPath);

    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api', healthRouter);
    app.use('/api/books', createBooksRouter(db, testDataDir));
    app.use('/api/categories', createCategoriesRouter(db));
    app.use('/api', createProgressRouter(db));
    app.use('/api/tts', createTtsRouter(db, testDataDir));
    app.use(errorHandler);

    // Register + Login to get auth token
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ username: 'e2e-user', password: 'e2epass123' });
    authToken = registerRes.body.data.token;
  });

  afterAll(() => {
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ════════════════════════════════════════════
  // 1. Health Check
  // ════════════════════════════════════════════
  describe('1. Health Check', () => {
    it('GET /api/health should return ok', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('0.1.0');
    });
  });

  // ════════════════════════════════════════════
  // 2. Categories
  // ════════════════════════════════════════════
  describe('2. Categories', () => {
    it('should have default "未分类" category', async () => {
      const res = await request(app).get('/api/categories').set(auth());
      expect(res.status).toBe(200);
      const uncategorized = res.body.data.find((c: any) => c.name === '未分类');
      expect(uncategorized).toBeDefined();
    });

    it('POST /api/categories should create a category', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set(auth())
        .send({ name: '科幻小说' });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('科幻小说');
    });

    it('GET /api/categories should list all categories', async () => {
      const res = await request(app).get('/api/categories').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ════════════════════════════════════════════
  // 3. EPUB Upload → Parse → Read → Progress → Resume
  // ════════════════════════════════════════════
  describe('3. EPUB Full Flow', () => {
    const epubPath = path.join(FIXTURES_DIR, 'three-body-sample.epub');

    it('3.1 should upload EPUB and parse chapters', async () => {
      expect(fs.existsSync(epubPath)).toBe(true);

      const res = await request(app)
        .post('/api/books/upload')
        .set(auth())
        .attach('file', epubPath)

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('三体：科学边界');
      expect(res.body.data.author).toBe('刘慈欣');
      expect(res.body.data.format).toBe('epub');
      expect(res.body.data.status).toBe('ready');
      epubId = res.body.data.id;
    });

    it('3.2 should get chapters list', async () => {
      const res = await request(app).get(`/api/books/${epubId}/chapters`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(3);
      epubChapterIds = res.body.data.map((c: any) => c.id);
    });

    it('3.3 should get book details', async () => {
      const res = await request(app).get(`/api/books/${epubId}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(epubId);
      expect(res.body.data.title).toBe('三体：科学边界');
    });

    it('3.4 should save reading progress at 30%', async () => {
      const res = await request(app)
        .put(`/api/books/${epubId}/progress`)
        .set(auth())
        .send({
          chapterId: epubChapterIds[0],
          percentage: 30,
          cfi: '/6/4[chap01ref]!/4/2/1:0',
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('3.5 should retrieve saved progress', async () => {
      const res = await request(app).get(`/api/books/${epubId}/progress`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data).not.toBeNull();
      expect(res.body.data.percentage).toBe(30);
      expect(res.body.data.bookId).toBe(epubId);
    });

    it('3.6 should update progress to 75% and verify', async () => {
      const res1 = await request(app)
        .put(`/api/books/${epubId}/progress`)
        .set(auth())
        .send({ percentage: 75, chapterId: epubChapterIds[1] });
      expect(res1.status).toBe(200);

      const res2 = await request(app).get(`/api/books/${epubId}/progress`).set(auth());
      expect(res2.body.data.percentage).toBe(75);
    });

    it('3.7 should get EPUB file', async () => {
      const res = await request(app).get(`/api/books/${epubId}/file`).set(auth());
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/epub+zip');
    });
  });

  // ════════════════════════════════════════════
  // 4. TXT Upload → Parse → Read → Progress → Resume
  // ════════════════════════════════════════════
  describe('4. TXT Full Flow', () => {
    const txtPath = path.join(FIXTURES_DIR, 'three-body-sample.txt');

    it('4.1 should upload TXT and parse chapters', async () => {
      expect(fs.existsSync(txtPath)).toBe(true);

      const res = await request(app)
        .post('/api/books/upload')
        .set(auth())
        .attach('file', txtPath)

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.title).toBe('三体：科学边界');
      expect(res.body.data.format).toBe('txt');
      expect(res.body.data.status).toBe('ready');
      txtId = res.body.data.id;
    });

    it('4.2 should get TXT chapters', async () => {
      const res = await request(app).get(`/api/books/${txtId}/chapters`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(5);
      txtChapterIds = res.body.data.map((c: any) => c.id);
    });

    it('4.3 should read TXT chapter content', async () => {
      const res = await request(app).get(`/api/books/${txtId}/chapters/${txtChapterIds[0]}/content`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.content).toBeTruthy();
      expect(res.body.data.content.length).toBeGreaterThan(50);
      expect(res.body.data.content).toContain('科学边界');
    });

    it('4.4 should save and retrieve TXT progress', async () => {
      await request(app)
        .put(`/api/books/${txtId}/progress`)
        .set(auth())
        .send({ percentage: 42, chapterId: txtChapterIds[2] });

      const res = await request(app).get(`/api/books/${txtId}/progress`).set(auth());
      expect(res.body.data.percentage).toBe(42);
      expect(res.body.data.chapterId).toBe(txtChapterIds[2]);
    });

    it('4.5 should read different chapters of TXT', async () => {
      for (let i = 1; i < txtChapterIds.length; i++) {
        const res = await request(app).get(`/api/books/${txtId}/chapters/${txtChapterIds[i]}/content`).set(auth());
        expect(res.status).toBe(200);
        expect(res.body.data.content.length).toBeGreaterThan(30);
      }
    });
  });

  // ════════════════════════════════════════════
  // 5. TTS Settings
  // ════════════════════════════════════════════
  describe('5. TTS Settings', () => {
    it('5.1 should get TTS sources', async () => {
      const res = await request(app).get('/api/tts/sources');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('5.2 should save TTS settings', async () => {
      const res = await request(app)
        .put('/api/tts/settings')
        .set(auth())
        .send({
          enabled: true,
          source: 'edgetts',
          voiceId: 'zh-CN-XiaoxiaoNeural',
          speed: 1.2,
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.enabled).toBe(true);
      expect(res.body.data.source).toBe('edgetts');
      expect(res.body.data.speed).toBe(1.2);
    });

    it('5.3 should read saved TTS settings', async () => {
      const res = await request(app).get('/api/tts/settings').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.source).toBe('edgetts');
      expect(res.body.data.speed).toBe(1.2);
    });

    it('5.4 should update TTS settings partially', async () => {
      const res = await request(app)
        .put('/api/tts/settings')
        .set(auth())
        .send({ speed: 1.5 });
      expect(res.status).toBe(200);
      expect(res.body.data.speed).toBe(1.5);
      expect(res.body.data.source).toBe('edgetts');
    });
  });

  // ════════════════════════════════════════════
  // 6. Book List & Filtering
  // ════════════════════════════════════════════
  describe('6. Book Management', () => {
    it('6.1 should list all uploaded books', async () => {
      const res = await request(app).get('/api/books').set(auth());
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });

    it('6.2 should update book metadata', async () => {
      const res = await request(app)
        .put(`/api/books/${epubId}`)
        .set(auth())
        .send({ title: '三体（更新版）' });
      expect(res.status).toBe(200);
      expect(res.body.data.title).toBe('三体（更新版）');
    });

    it('6.3 should delete TXT book', async () => {
      const res = await request(app).delete(`/api/books/${txtId}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const listRes = await request(app).get('/api/books').set(auth());
      expect(listRes.body.data.length).toBe(1);
    });

    it('6.4 should return 404 for deleted book', async () => {
      const res = await request(app).get(`/api/books/${txtId}`).set(auth());
      expect(res.status).toBe(404);
    });
  });

  // ════════════════════════════════════════════
  // 7. Error Handling
  // ════════════════════════════════════════════
  describe('7. Error Handling', () => {
    it('7.1 should skip unsupported file format gracefully', async () => {
      const invalidPath = path.join('/tmp', `invalid-${testId}.pdf`);
      fs.writeFileSync(invalidPath, 'not a valid file');
      try {
        const res = await request(app)
          .post('/api/books/upload')
          .set(auth())
          .attach('file', invalidPath);
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('不支持');
      } finally {
        fs.unlinkSync(invalidPath);
      }
    });

    it('7.2 should return 404 for non-existent book', async () => {
      const res = await request(app).get('/api/books/non-existent-id').set(auth());
      expect(res.status).toBe(404);
    });

    it('7.3 should return 404 for unknown API routes', async () => {
      const res = await request(app).get('/api/unknown-route');
      expect(res.status).toBe(404);
    });
  });
});
