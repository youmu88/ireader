import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { sql } from 'drizzle-orm';
import { books, bookChapters, readingProgress } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { parseBook, getChapterContent, parseTxt } from '../parser/index.js';

/**
 * Simple string hash (djb2) for deterministic hue generation.
 */
function hashCode(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Escape XML special characters for safe SVG text injection.
 */
function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

export function createBooksRouter(db: any, dataDir: string): Router {
  const router = Router();

  // Ensure books directory exists
  const booksDir = path.join(dataDir, 'books');
  if (!fs.existsSync(booksDir)) {
    fs.mkdirSync(booksDir, { recursive: true });
  }

  // Multer config - 500MB max file size
  const upload = multer({
    dest: path.join(dataDir, 'uploads'),
    limits: { fileSize: 500 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext !== '.epub' && ext !== '.txt') {
        return cb(new AppError(400, '仅支持 EPUB 和 TXT 格式'));
      }
      cb(null, true);
    },
  });

  // Ensure uploads directory exists
  const uploadsDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  /**
   * Process a single uploaded file: save, parse, insert into DB.
   * Returns the final book record or null on failure.
   */
  const processUpload = async (file: Express.Multer.File, now: string, userId: string): Promise<any> => {
    const ext = path.extname(file.originalname).toLowerCase();
    const format = ext === '.epub' ? 'epub' : 'txt';
    const bookId = uuidv4();
    const bookDir = path.join(booksDir, bookId);
    const targetPath = path.join(bookDir, `original${ext}`);

    // Create book directory
    fs.mkdirSync(bookDir, { recursive: true });

    // Move uploaded file to book directory
    fs.renameSync(file.path, targetPath);

    // Create book record (processing)
    const bookRecord = {
      id: bookId,
      userId,
      title: path.basename(file.originalname, ext),
      author: null,
      format,
      categoryId: null,
      filePath: targetPath,
      coverPath: null,
      size: file.size,
      status: 'processing' as const,
      parseError: null,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(books).values(bookRecord).run();

    // Parse book (await since parseBook is async)
    try {
      const parseResult = await parseBook(targetPath, format, bookDir);

      // Update book metadata from parse result
      const updateData: any = {
        title: parseResult.title,
        author: parseResult.author || bookRecord.author,
        status: 'ready',
        updatedAt: now,
      };

      if (parseResult.coverPath) {
        // EPUB parser extracts files to {bookDir}/extracted/
        const coverSrc = path.join(bookDir, 'extracted', parseResult.coverPath);
        const coverExt = path.extname(coverSrc) || '.jpg';
        const coverDest = path.join(bookDir, `cover${coverExt}`);
        if (fs.existsSync(coverSrc)) {
          fs.copyFileSync(coverSrc, coverDest);
          updateData.coverPath = coverDest;
        }
      }

      db.update(books).set(updateData).where(sql`id = ${bookId}`).run();

      // Insert chapters
      for (const chapter of parseResult.chapters) {
        db.insert(bookChapters).values({
          id: uuidv4(),
          bookId,
          title: chapter.title,
          href: (chapter as any).href || null,
          startOffset: (chapter as any).startOffset ?? null,
          endOffset: (chapter as any).endOffset ?? null,
          order: chapter.order,
          level: chapter.level,
        }).run();
      }
    } catch (parseErr: any) {
      // Mark as failed
      db.update(books).set({
        status: 'failed',
        parseError: parseErr.message || '解析失败',
        updatedAt: now,
      }).where(sql`id = ${bookId}`).run();
    }

    return db.select().from(books).where(sql`id = ${bookId}`).get();
  };

  // ── POST /api/books/upload - 上传图书（支持多文件）──
  router.post('/upload', requireAuth, upload.array('files', 10), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        throw new AppError(400, '请选择要上传的文件');
      }

      const now = new Date().toISOString();
      const results: any[] = [];
      const userId = req.user!.userId;

      for (const file of files) {
        const finalBook = await processUpload(file, now, userId);
        results.push(finalBook);
      }

      res.status(201).json({ success: true, data: results });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/cover - 获取图书封面 ──
  router.get('/:id/cover', (req: Request, res: Response, next: NextFunction) => {
    try {
      const book = db.select().from(books).where(sql`id = ${req.params.id}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      // Try the stored cover path first
      if (book.coverPath && fs.existsSync(book.coverPath)) {
        return res.sendFile(book.coverPath);
      }

      // Try common cover locations
      const bookDir = path.join(booksDir, req.params.id);
      const candidates = ['cover.jpg', 'cover.jpeg', 'cover.png', 'cover.webp'];
      for (const c of candidates) {
        const fp = path.join(bookDir, c);
        if (fs.existsSync(fp)) return res.sendFile(fp);
      }

      // Generate an SVG placeholder cover on the fly
      const initials = (book.title || '?').charAt(0).toUpperCase();
      const hue = (hashCode(book.id) % 360);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400" viewBox="0 0 300 400">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:hsl(${hue},55%,45%)" />
            <stop offset="100%" style="stop-color:hsl(${(hue + 40) % 360},55%,35%)" />
          </linearGradient>
        </defs>
        <rect width="300" height="400" fill="url(#bg)" rx="12" />
        <text x="150" y="200" text-anchor="middle" dominant-baseline="central"
              font-size="96" font-weight="bold" fill="rgba(255,255,255,0.9)"
              font-family="'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif">
          ${initials}
        </text>
        <text x="150" y="360" text-anchor="middle" font-size="14"
              fill="rgba(255,255,255,0.7)"
              font-family="'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif">
          ${escapeXml(book.title)}
        </text>
      </svg>`;

      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.send(svg);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books - 图书列表 ──
  router.get('/', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      // Support category filter
      const categoryId = req.query.category_id as string | undefined;
      let query = db.select().from(books).where(sql`user_id = ${userId}`);
      if (categoryId) {
        query = query.where(sql`category_id = ${categoryId}`);
      }
      const allBooks = query.all();
      res.json({ success: true, data: allBooks });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id - 图书详情 ──
  router.get('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');
      res.json({ success: true, data: book });
    } catch (err) {
      next(err);
    }
  });

  // ── PUT /api/books/:id - 更新图书信息 ──
  router.put('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const existing = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!existing) throw new AppError(404, '图书不存在');

      const updateData: any = { updatedAt: new Date().toISOString() };
      if (req.body.title !== undefined) updateData.title = req.body.title;
      if (req.body.author !== undefined) updateData.author = req.body.author;
      if (req.body.categoryId !== undefined) updateData.categoryId = req.body.categoryId;

      db.update(books).set(updateData).where(sql`id = ${req.params.id} AND user_id = ${userId}`).run();
      const updated = db.select().from(books).where(sql`id = ${req.params.id}`).get();
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/file - 获取原始文件 ──
  router.get('/:id/file', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');
      if (!fs.existsSync(book.filePath)) throw new AppError(404, '文件不存在');

      const ext = path.extname(book.filePath).toLowerCase();
      const contentType = ext === '.epub' ? 'application/epub+zip' : 'text/plain; charset=utf-8';
      res.setHeader('Content-Type', contentType);
      res.sendFile(book.filePath);
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/chapters - 获取章节目录 ──
  router.get('/:id/chapters', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const chapters = db.select().from(bookChapters)
        .where(sql`book_id = ${req.params.id}`)
        .orderBy(bookChapters.order)
        .all();

      res.json({ success: true, data: chapters });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/chapters/:chapterId/content - 获取章节内容（TXT） ──
  router.get('/:id/chapters/:chapterId/content', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      const chapter = db.select().from(bookChapters)
        .where(sql`id = ${req.params.chapterId} AND book_id = ${req.params.id}`)
        .get();
      if (!chapter) throw new AppError(404, '章节不存在');

      if (book.format === 'txt') {
        // For TXT, read content from the original file using offsets
        if (chapter.startOffset == null) {
          throw new AppError(400, '该章节没有偏移量信息');
        }

        // Need to read the TXT file content
        const parseResult = parseTxt(book.filePath);
        const content = getChapterContent(parseResult.content, chapter.startOffset, chapter.endOffset || parseResult.content.length);
        res.json({ success: true, data: { content, chapter } });
      } else {
        // For EPUB, return the extracted file path for the chapter
        if (!chapter.href) {
          throw new AppError(400, 'EPUB 章节没有文件路径');
        }
        // Check if extracted file exists
        const extractedPath = path.join(path.dirname(book.filePath), 'extracted', chapter.href);
        if (fs.existsSync(extractedPath)) {
          const chapterContent = fs.readFileSync(extractedPath, 'utf-8');
          res.json({ success: true, data: { content: chapterContent, chapter } });
        } else {
          res.json({ success: true, data: { content: null, chapter, note: 'EPUB 章节内容需由前端通过 epubjs 加载' } });
        }
      }
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/books/:id - 删除图书 ──
  router.delete('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      // Delete reading progress
      db.delete(readingProgress).where(sql`book_id = ${req.params.id}`).run();
      // Delete chapters
      db.delete(bookChapters).where(sql`book_id = ${req.params.id}`).run();
      // Delete book record
      db.delete(books).where(sql`id = ${req.params.id}`).run();

      // Delete physical files
      const bookDir = path.join(booksDir, req.params.id);
      if (fs.existsSync(bookDir)) {
        fs.rmSync(bookDir, { recursive: true, force: true });
      }

      res.json({ success: true, message: '图书已删除' });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/books/:id/cache - 缓存书籍内容（全书或 N 章节） ──
  router.post('/:id/cache', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bookId = req.params.id;
      const { type, count } = req.body; // type: 'full' | 'partial', count: number of chapters

      const { cacheFullBook, cacheNChapters } = await import('../services/contentCacheService.js');
      let result: { cached: number; failed: number };

      if (type === 'full') {
        result = await cacheFullBook(db, bookId, userId, dataDir);
      } else {
        const chapterCount = Math.max(1, Math.min(count || 5, 100));
        result = await cacheNChapters(db, bookId, userId, dataDir, chapterCount);
      }

      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/books/:id/tts-generate - 后台生成 TTS 语音 ──
  router.post('/:id/tts-generate', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bookId = req.params.id;
      const { voice, speed, chapterCount } = req.body;

      // 获取当前 TTS 设置
      const { ttsSettings } = await import('../db/schema.js');
      const settings = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();
      const ttsVoice = voice || settings?.voiceId || 'zf_xiaobei';
      const ttsSpeed = speed ?? settings?.speed ?? 1.0;

      const { createFullBookGenerationJob, createPartialGenerationJob } = await import('../services/ttsGenerationService.js');

      let job;
      if (chapterCount && chapterCount > 0) {
        job = createPartialGenerationJob(db, bookId, userId, ttsVoice, ttsSpeed, chapterCount, dataDir);
      } else {
        job = createFullBookGenerationJob(db, bookId, userId, ttsVoice, ttsSpeed, dataDir);
      }

      res.status(201).json({ success: true, data: job });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/tts-jobs - 获取书籍的 TTS 生成任务列表 ──
  router.get('/:id/tts-jobs', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bookId = req.params.id;
      const { ttsGenerationJobs } = require('../db/schema.js');
      const jobs = db.select().from(ttsGenerationJobs)
        .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
        .orderBy(sql`created_at DESC`)
        .all();
      res.json({ success: true, data: jobs });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/stats - 获取书籍统计信息（阅读百分比 + 语音生成率） ──
  router.get('/:id/stats', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bookId = req.params.id;

      const book = db.select().from(books).where(sql`id = ${bookId} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      // 阅读百分比
      const progress = db.select().from(readingProgress)
        .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
        .get();
      const readingPercentage = progress?.percentage ?? 0;

      // 语音生成率
      const totalChapters = db.select({ count: sql<number>`count(*)` }).from(bookChapters)
        .where(sql`book_id = ${bookId}`)
        .get()?.count ?? 0;

      const { ttsGenerationJobs } = require('../db/schema.js');
      const completedJobs = db.select({ count: sql<number>`count(*)` }).from(ttsGenerationJobs)
        .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status = 'completed'`)
        .get()?.count ?? 0;

      const voiceGenerationRate = totalChapters > 0 ? Math.min(1, completedJobs / totalChapters) : 0;

      // 缓存统计
      const { getBookCacheStats } = require('../services/contentCacheService.js');
      const cacheStats = getBookCacheStats(db, bookId, userId);

      res.json({
        success: true,
        data: {
          readingPercentage,
          voiceGenerationRate,
          totalChapters,
          completedVoiceChapters: completedJobs,
          cachedChapters: cacheStats.cachedChapters,
          cacheType: cacheStats.cacheType,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
