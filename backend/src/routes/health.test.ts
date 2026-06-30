import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import healthRouter from './health.js';

describe('Health API', () => {
  const app = express();
  app.use('/api', healthRouter);

  it('GET /api/health should return ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status).toBe('ok');
    expect(res.body.version).toBe('0.1.0');
    expect(res.body.timestamp).toBeDefined();
  });
});
