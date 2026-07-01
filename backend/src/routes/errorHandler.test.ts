import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { errorHandler, AppError } from '../middleware/errorHandler.js';

describe('Error Handler', () => {
  const app = express();
  app.get('/test-error', () => {
    throw new AppError(400, '测试错误');
  });
  app.get('/test-unexpected', () => {
    throw new Error('意外错误');
  });
  app.use(errorHandler);

  it('should handle AppError with correct status code', async () => {
    const res = await request(app).get('/test-error');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('测试错误');
  });

  it('should handle unexpected errors as 500', async () => {
    const res = await request(app).get('/test-unexpected');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('服务器内部错误，请稍后重试');
  });
});
