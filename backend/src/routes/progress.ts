import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { readingProgress, books } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

export function createProgressRouter(db: any): Router {
  const router = Router();

  // GET /api/books/:id/progress - 获取阅读进度
  router.get('/books/:id/progress', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const progress = db.select().from(readingProgress)
        .where(sql`book_id = ${req.params.id} AND user_id = ${userId}`).get();
      res.json({ success: true, data: progress || null });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/books/:id/progress - 保存阅读进度
  router.put('/books/:id/progress', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const now = new Date().toISOString();
      const existing = db.select().from(readingProgress)
        .where(sql`book_id = ${req.params.id} AND user_id = ${userId}`).get();

      const progressData = {
        userId,
        chapterId: req.body.chapterId || null,
        cfi: req.body.cfi || null,
        textOffset: req.body.textOffset ?? null,
        percentage: req.body.percentage ?? null,
        pageIndex: req.body.pageIndex ?? null,
        updatedAt: now,
      };

      if (existing) {
        db.update(readingProgress).set(progressData)
          .where(sql`book_id = ${req.params.id} AND user_id = ${userId}`).run();
      } else {
        db.insert(readingProgress).values({
          id: uuidv4(),
          bookId: req.params.id,
          ...progressData,
        }).run();
      }

      res.json({ success: true, message: '进度已保存' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
