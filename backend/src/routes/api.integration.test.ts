import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { initDatabase } from '../db/init.js';
import { createAuthRouter } from './auth.js';
import { createBooksRouter } from './books.js';
import { createCategoriesRouter } from './categories.js';
import { createProgressRouter } from './progress.js';
import healthRouter from './health.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { v4 as uuidv4 } from 'uuid';

describe('API Integration', () => {
  const testId = `ireader-integration-test-${Date.now()}`;
  const testDbPath = path.join('/tmp', `${testId}.sqlite`);
  const testDataDir = path.join('/tmp', testId);
  let app: express.Express;
  let authToken: string;
  let testUserId: string;

  beforeAll(async () => {
    // Create test data directory
    fs.mkdirSync(testDataDir, { recursive: true });

    const db = initDatabase(testDbPath);
    app = express();
    app.use(express.json());
    app.use('/api/auth', createAuthRouter(db));
    app.use('/api', healthRouter);
    app.use('/api/books', createBooksRouter(db, testDataDir));
    app.use('/api/categories', createCategoriesRouter(db));
    app.use('/api', createProgressRouter(db));
    app.use(errorHandler);

    // Register test user and get token
    const registerRes = await request(app)
      .post('/api/auth/register')
      .send({ email: `youmu88@gmail.com`, password: 'test123456', displayName: '测试用户' });
    expect(registerRes.status).toBe(201);
    authToken = registerRes.body.data.token;
    testUserId = registerRes.body.data.userId;
  });

  afterAll(() => {
    // Cleanup test files
    try {
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
      if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // ── Health ──
  describe('GET /api/health', () => {
    it('should return ok status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('0.1.0');
    });
  });

  // ── Auth ──
  describe('Auth API', () => {
    it('POST /api/auth/login should login', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: `youmu88@gmail.com`, password: 'test123456' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeTruthy();
      expect(res.body.data.user.email).toBe(`youmu88@gmail.com`);
      expect(res.body.data.user.username).toBe('youmu88');
    });

    it('POST /api/auth/register should reject duplicate email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `youmu88@gmail.com`, password: 'test123456' });
      expect(res.status).toBe(409);
    });

    it('POST /api/auth/login should reject wrong password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: `youmu88@gmail.com`, password: 'wrongpass' });
      expect(res.status).toBe(401);
    });

    it('GET /api/auth/me should return user info', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.username).toBe('youmu88');
      expect(res.body.data.email).toBe('youmu88@gmail.com');
    });
  });

  // ── Categories ──
  describe('Categories CRUD', () => {
    let categoryId: string;

    it('POST /api/categories should create a category', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: '科幻' });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe('科幻');
      categoryId = res.body.data.id;
    });

    it('POST /api/categories should reject empty name', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: '' });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('GET /api/categories should list categories', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);

      // Should include default "未分类"
      const uncategorized = res.body.data.find((c: any) => c.name === '未分类');
      expect(uncategorized).toBeDefined();
    });

    it('PUT /api/categories/:id should update category name', async () => {
      const res = await request(app)
        .put(`/api/categories/${categoryId}`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: '科幻小说' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('PUT /api/categories/:id should reject invalid id', async () => {
      const res = await request(app)
        .put('/api/categories/non-existent')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ name: '测试' });
      expect(res.status).toBe(404);
    });

    it('DELETE /api/categories/:id should delete category', async () => {
      const res = await request(app)
        .delete(`/api/categories/${categoryId}`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('DELETE /api/categories/:id should reject non-existent', async () => {
      const res = await request(app)
        .delete('/api/categories/non-existent')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
    });
  });

  // ── Books ──
  describe('Books API', () => {
    let bookId: string;

    it('GET /api/books should return empty list initially', async () => {
      const res = await request(app)
        .get('/api/books')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('GET /api/books/:id should return 404 for non-existent', async () => {
      const res = await request(app)
        .get('/api/books/non-existent')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('DELETE /api/books/:id should return 404 for non-existent', async () => {
      const res = await request(app)
        .delete('/api/books/non-existent')
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ── Reading Progress ──
  describe('Reading Progress API', () => {
    const testBookId = uuidv4();

    it('GET /api/books/:id/progress should return 404 for non-existent book', async () => {
      const res = await request(app)
        .get(`/api/books/${testBookId}/progress`)
        .set('Authorization', `Bearer ${authToken}`);
      expect(res.status).toBe(404);
    });

    it('PUT /api/books/:id/progress should return 404 for non-existent book', async () => {
      const res = await request(app)
        .put(`/api/books/${testBookId}/progress`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({ percentage: 50 });
      expect(res.status).toBe(404);
    });
  });

  // ── 404 Route ──
  describe('Unknown routes', () => {
    it('should return 404 for undefined API routes', async () => {
      const res = await request(app).get('/api/unknown-route');
      expect(res.status).toBe(404);
    });
  });
});
