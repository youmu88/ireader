/**
 * 书签云同步路由
 *
 * 沿 progress.ts 既有的「用户维 + GET/PUT + 冲突合并」范式：
 *  - GET  /api/books/:id/bookmarks → 该用户该书全部书签
 *  - PUT  /api/books/:id/bookmarks → 全量同步（客户端以本地书签数组为准，服务端按
 *    (user_id, book_id, cfi) 唯一键 diff：在库不在客户端 = 删除，客户端新增 = 插入，
 *    excerpt/globalPage 有更新 = 覆盖）
 *
 * 范式来源：readingProgress 的版本冲突合并（ev_8320f71f7bfb17e7 支持的 offline-first
 * /multi-device CRDT 式合并思路在书签这类「CFI 幂等键 + 文档级覆盖」数据上足够）。
 */
import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import { books, bookmarks } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';

interface BookmarkSyncItem {
  cfi: string;
  excerpt?: string | null;
  chapterHref?: string | null;
  globalPage?: number | null;
  createdAt?: string;
}

export function createBookmarksRouter(db: any): Router {
  const router = Router();

  // GET /api/books/:id/bookmarks - 获取该书全部书签
  router.get('/books/:id/bookmarks', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const rows = db.select().from(bookmarks)
        .where(sql`book_id = ${req.params.id} AND user_id = ${userId}`)
        .all() as any[];
      res.json({ success: true, data: rows.map(r => ({
        id: r.id,
        cfi: r.cfi,
        excerpt: r.excerpt || '',
        chapterHref: r.chapterHref,
        globalPage: r.globalPage,
        createdAt: r.createdAt,
      })) });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/books/:id/bookmarks - 全量同步（以客户端数组为权威，服务端 diff 落库）
  router.put('/books/:id/bookmarks', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const incoming: BookmarkSyncItem[] = Array.isArray(req.body?.bookmarks) ? req.body.bookmarks : [];
      const existing = db.select().from(bookmarks)
        .where(sql`book_id = ${req.params.id} AND user_id = ${userId}`)
        .all() as any[];
      const existingByCfi = new Map(existing.map(r => [r.cfi, r]));
      const now = new Date().toISOString();

      // 1) 客户端不存在 → 服务端删除
      const incomingCfi = new Set(incoming.map(i => i.cfi).filter(Boolean));
      for (const row of existing) {
        if (!incomingCfi.has(row.cfi)) {
          db.delete(bookmarks).where(sql`id = ${row.id}`).run();
        }
      }

      // 2) 客户端有 → 服务端新增或覆盖
      for (const item of incoming) {
        if (!item.cfi) continue;
        const row = existingByCfi.get(item.cfi);
        const payload = {
          excerpt: item.excerpt ?? '',
          chapterHref: item.chapterHref || null,
          globalPage: item.globalPage ?? null,
          updatedAt: now,
        };
        if (row) {
          db.update(bookmarks).set(payload).where(sql`id = ${row.id}`).run();
        } else {
          db.insert(bookmarks).values({
            id: uuidv4(),
            userId,
            bookId: req.params.id,
            cfi: item.cfi,
            excerpt: item.excerpt ?? '',
            chapterHref: item.chapterHref || null,
            globalPage: item.globalPage ?? null,
            createdAt: item.createdAt || now,
            updatedAt: now,
          }).run();
        }
      }

      res.json({ success: true, data: { synced: incomingCfi.size } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
