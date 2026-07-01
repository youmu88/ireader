import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { categories } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

export function createCategoriesRouter(db: any): Router {
  const router = Router();

  // GET /api/categories - 分类列表
  router.get('/', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const all = db.select().from(categories)
        .where(sql`user_id = ${userId}`)
        .orderBy(categories.sort).all();
      res.json({ success: true, data: all });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/categories - 新增分类
  router.post('/', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        throw new AppError(400, '分类名称不能为空');
      }

      const newCat = {
        id: uuidv4(),
        userId,
        name: name.trim(),
        sort: Date.now(),
      };

      db.insert(categories).values(newCat).run();
      res.status(201).json({ success: true, data: newCat });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/categories/:id - 修改分类
  router.put('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const existing = db.select().from(categories).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!existing) throw new AppError(404, '分类不存在');

      const { name } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        throw new AppError(400, '分类名称不能为空');
      }

      db.update(categories).set({ name: name.trim() })
        .where(sql`id = ${req.params.id} AND user_id = ${userId}`).run();
      res.json({ success: true, message: '分类已更新' });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/categories/:id - 删除分类
  router.delete('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const existing = db.select().from(categories).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!existing) throw new AppError(404, '分类不存在');

      db.delete(categories).where(sql`id = ${req.params.id} AND user_id = ${userId}`).run();
      res.json({ success: true, message: '分类已删除' });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
