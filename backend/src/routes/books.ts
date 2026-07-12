import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { sql } from 'drizzle-orm';
import { books, bookChapters, readingProgress, ttsGenerationJobs, ttsSettings, ttsCache } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { parseBook, getChapterContent, parseTxt } from '../parser/index.js';
import { getBookCacheStats } from '../services/contentCacheService.js';
import crypto from 'crypto';

/**
 * 计算文件 SHA256 哈希（流式读取，适合大文件）
 */
function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

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

  // Multer config - 500MB max file size, no fileFilter (validation done in handler)
  const upload = multer({
    dest: path.join(dataDir, 'uploads'),
    limits: { fileSize: 500 * 1024 * 1024 },
  });

  // Ensure uploads directory exists
  const uploadsDir = path.join(dataDir, 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  /**
   * 智能检测文件格式：兼容 .epub.zip 双扩展名
   * - foo.epub → epub
   * - foo.epub.zip → epub
   * - foo.txt → txt
   * - 其他 → 根据扩展名判定
   */
  function detectBookFormat(fileName: string): { format: 'epub' | 'txt' | null; ext: string } {
    const lower = fileName.toLowerCase();
    // 优先检测 .epub.zip 双扩展名
    if (lower.endsWith('.epub.zip')) {
      return { format: 'epub', ext: '.epub.zip' };
    }
    if (lower.endsWith('.epub')) {
      return { format: 'epub', ext: '.epub' };
    }
    if (lower.endsWith('.txt')) {
      return { format: 'txt', ext: '.txt' };
    }
    // 不支持的格式
    return { format: null, ext: path.extname(lower) };
  }

  /**
   * 提取书名：去掉文件扩展名（兼容双扩展名如 .epub.zip）
   */
  function extractTitle(fileName: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.epub.zip')) {
      return fileName.slice(0, -9); // 去掉 .epub.zip (9个字符)
    }
    const ext = path.extname(fileName);
    return ext ? fileName.slice(0, -ext.length) : fileName;
  }

  /**
   * 构建存储路径：统一将 .epub.zip 存储为 .epub
   */
  function buildStorageExt(detectedExt: string): string {
    if (detectedExt === '.epub.zip') return '.epub';
    return detectedExt;
  }

  /**
   * Process a single uploaded file: save, parse, insert into DB.
   * Returns the final book record or null on failure.
   */
  const processUpload = async (file: Express.Multer.File, now: string, userId: string): Promise<any> => {
    const { format, ext: detectedExt } = detectBookFormat(file.originalname);
    const storageExt = buildStorageExt(detectedExt);
    const bookId = uuidv4();
    const bookDir = path.join(booksDir, bookId);
    const targetPath = path.join(bookDir, `original${storageExt}`);

    // Create book directory
    fs.mkdirSync(bookDir, { recursive: true });

    // Move uploaded file to book directory
    fs.renameSync(file.path, targetPath);

    // 先创建记录（不含 fileHash），上传响应不阻塞哈希计算
    const bookRecord = {
      id: bookId,
      userId,
      title: extractTitle(file.originalname),
      author: null,
      format,
      categoryId: null,
      filePath: targetPath,
      coverPath: null,
      fileHash: null,
      size: file.size,
      status: 'processing' as const,
      parseError: null,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(books).values(bookRecord).run();

    // 异步计算文件哈希（大文件不阻塞上传响应）
    computeFileHash(targetPath).then(hash => {
      db.update(books).set({ fileHash: hash, updatedAt: new Date().toISOString() })
        .where(sql`id = ${bookId}`).run();
    }).catch(err => {
      console.error(`[异步哈希] 计算失败 (book: ${bookId}):`, err.message);
    });

    // Parse book (await since parseBook is async)
    try {
      const parseResult = await parseBook(targetPath, format!, bookDir);

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

  // ── POST /api/books/upload - 上传单本图书（前端队列逐本上传）──
  router.post('/upload', requireAuth, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        throw new AppError(400, '请选择要上传的文件');
      }

      const now = new Date().toISOString();
      const userId = req.user!.userId;
      const { format: detectedFormat, ext: detectedExt } = detectBookFormat(file.originalname);

      // Validate file format (兼容 .epub.zip 双扩展名)
      if (detectedFormat !== 'epub' && detectedFormat !== 'txt') {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          error: `不支持 ${detectedExt} 格式，仅支持 EPUB 和 TXT`,
        });
      }

      try {
        const finalBook = await processUpload(file, now, userId);
        res.status(201).json({ success: true, data: finalBook });
      } catch (err: any) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        res.status(500).json({
          success: false,
          error: err.message || '上传处理失败',
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/books/upload-batch - 批量上传（兼容旧版，最多 20 本/次）──
  router.post('/upload-batch', requireAuth, upload.array('files', 20), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        throw new AppError(400, '请选择要上传的文件');
      }

      const now = new Date().toISOString();
      const results: any[] = [];
      const skipped: Array<{ fileName: string; reason: string }> = [];
      const supportedFiles: Express.Multer.File[] = [];
      const userId = req.user!.userId;

      for (const file of files) {
        const { format: detectedFormat, ext: detectedExt } = detectBookFormat(file.originalname);
        if (detectedFormat !== 'epub' && detectedFormat !== 'txt') {
          skipped.push({ fileName: file.originalname, reason: `不支持 ${detectedExt} 格式，仅支持 EPUB 和 TXT` });
          continue;
        }
        supportedFiles.push(file);
      }

      if (supportedFiles.length === 0) {
        return res.json({
          success: true,
          data: [],
          skipped,
          message: '没有可上传的书籍（所选文件均不支持）',
        });
      }

      for (const file of supportedFiles) {
        try {
          const finalBook = await processUpload(file, now, userId);
          results.push(finalBook);
        } catch (err: any) {
          skipped.push({ fileName: file.originalname, reason: err.message || '未知错误' });
        }
      }

      res.status(201).json({ success: true, data: results, skipped: skipped.length > 0 ? skipped : undefined });
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
      
      // 1. Fetch books with the new pinned field
      let query = db.select().from(books).where(sql`user_id = ${userId}`);
      if (categoryId) {
        query = query.where(sql`category_id = ${categoryId}`);
      }
      const allBooks = query.all() as Array<any>;
      
      // 2. Fetch last read time per book from readingProgress (aggregate in SQL)
      let lastReadMap = new Map<string, string>();
      if (allBooks.length > 0) {
        // Use drizzle's select with groupBy to get MAX(updated_at) per book
        const lastReadRows = db.select({
          bookId: readingProgress.bookId,
          lastReadAt: sql<string>`MAX(${readingProgress.updatedAt})`.as('lastReadAt'),
        })
          .from(readingProgress)
          .groupBy(readingProgress.bookId)
          .all();
        lastReadMap = new Map(lastReadRows.map((r: { bookId: string; lastReadAt: string }) => [r.bookId, r.lastReadAt]));
      }
      
      // 3. Attach lastReadAt and sort: pinned DESC → lastReadAt DESC → createdAt DESC
      const enriched = allBooks.map(b => ({
        ...b,
        lastReadAt: lastReadMap.get(b.id) || null,
      }));
      enriched.sort((a, b) => {
        // pinned first
        if ((a.pinned || 0) !== (b.pinned || 0)) {
          return (b.pinned || 0) - (a.pinned || 0);
        }
        // then by lastReadAt DESC
        const aTime = a.lastReadAt || a.createdAt;
        const bTime = b.lastReadAt || b.createdAt;
        return bTime.localeCompare(aTime);
      });
      
      res.json({ success: true, data: enriched });
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
      if (req.body.pinned !== undefined) updateData.pinned = req.body.pinned ? 1 : 0;

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
        // ⚠️ 章节 href 可能包含 # 锚点（如 index.html#toc_29），读取文件时需移除锚点部分
        const hrefWithoutAnchor = chapter.href.split('#')[0];
        const extractedPath = path.join(path.dirname(book.filePath), 'extracted', hrefWithoutAnchor);
        if (fs.existsSync(extractedPath)) {
          let chapterContent = fs.readFileSync(extractedPath, 'utf-8');

          // ⚠️ 如果 href 带锚点（#toc_X），从 HTML 中提取对应章节片段
          const anchor = chapter.href.split('#')[1];
          if (anchor && chapter.href.includes('#')) {
            // 尝试多种锚点模式提取：id="toc_X"、id="章节标题"、name="toc_X"
            const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 匹配 h1-h6 中 id/name 为锚点的标签，提取到下一个同级别标题或文件结尾
            const sectionRegex = new RegExp(
              `<h[1-6][^>]*\\b(id|name)\\s*=\\s*["']\\s*${escapedAnchor}\\s*["'][^>]*>[\\s\\S]*?(?=<h[1-6]\\b|$)`,
              'i'
            );
            const sectionMatch = chapterContent.match(sectionRegex);
            if (sectionMatch) {
              chapterContent = sectionMatch[0];
            } else {
              // 兜底：如果锚点没匹配到，返回原始文件内容（已有修复前的行为）
              console.warn(`[EPUB] 锚点 ${anchor} 在 ${hrefWithoutAnchor} 中未找到，返回全文`);
            }
          }

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
  // ── POST /api/books/:id/reparse - 重新解析已有书籍章节 ──
  router.post('/:id/reparse', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const bookId = req.params.id;
      const book = db.select().from(books).where(sql`id = ${bookId} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');
      if (book.format !== 'epub') throw new AppError(400, '仅支持重新解析 EPUB 格式图书');

      const bookDir = path.join(booksDir, bookId);
      const sourcePath = path.join(bookDir, path.basename(book.filePath!));

      if (!fs.existsSync(sourcePath)) {
        throw new AppError(404, '原始文件不存在，无法重新解析');
      }

      // 重新解析
      const parseResult = await import('../parser/index.js').then(m => m.parseBook(sourcePath, book.format!, bookDir));

      // 删除旧章节
      db.delete(bookChapters).where(sql`book_id = ${bookId}`).run();

      // 插入新章节
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

      // 更新书籍元数据
      const updateData: any = {
        title: parseResult.title,
        author: parseResult.author || book.author,
        status: 'ready',
        updatedAt: new Date().toISOString(),
      };
      if (parseResult.coverPath) {
        const coverSrc = path.join(bookDir, 'extracted', parseResult.coverPath);
        const coverExt = path.extname(coverSrc) || '.jpg';
        const coverDest = path.join(bookDir, `cover${coverExt}`);
        if (fs.existsSync(coverSrc)) {
          fs.copyFileSync(coverSrc, coverDest);
          updateData.coverPath = coverDest;
        }
      }
      db.update(books).set(updateData).where(sql`id = ${bookId}`).run();

      // 获取新章节返回
      const chapters = db.select().from(bookChapters).where(sql`book_id = ${bookId}`).orderBy(sql`"order" ASC`).all();

      res.json({ success: true, data: { chapters, total: chapters.length, message: `重新解析完成，共 ${chapters.length} 章` } });
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

      // 获取当前 TTS 设置（ttsSettings 已通过顶部静态导入）
      const settings = db.select().from(ttsSettings).where(sql`user_id = ${userId}`).get();

      // 如果 TTS 功能被关闭，则返回
      if (settings && !settings.enabled) {
        res.json({ success: false, error: 'TTS 语音功能已关闭，请在设置中开启' });
        return;
      }

      const ttsVoice = voice || settings?.voiceId || 'zh-CN-XiaoxiaoNeural';
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

      // 语音生成率（后台 TTS 预生成任务）
      const totalChapters = db.select({ count: sql<number>`count(*)` }).from(bookChapters)
        .where(sql`book_id = ${bookId}`)
        .get()?.count ?? 0;

      // 优先使用已完成的 TTS 任务（代表实际合成完成的状态）
      // 避免新创建的 pending 任务覆盖已完成进度（显示为 0）
      const completedJob = db.select().from(ttsGenerationJobs)
        .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status = 'completed'`)
        .orderBy(sql`created_at DESC`)
        .get() as any;

      let latestJob: any;
      if (completedJob) {
        // 有已完成任务 → 使用已完成的统计数据（真实合成状态）
        latestJob = completedJob;
      } else {
        // 无已完成任务 → 使用最新任务（展示进行中进度）
        latestJob = db.select().from(ttsGenerationJobs)
          .where(sql`book_id = ${bookId} AND user_id = ${userId}`)
          .orderBy(sql`created_at DESC`)
          .get() as any;
      }

      const completedChunks = latestJob?.completedChunks || 0;
      const totalChunks = latestJob?.totalChunks || 0;
      const jobStatus = latestJob?.status || 'pending';
      const jobProgress = Math.min(100, latestJob?.progress || 0);

      // 统计各状态任务数（用于状态展示）
      const pendingJobs = db.select({ count: sql<number>`count(*)` }).from(ttsGenerationJobs)
        .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status IN ('pending', 'processing')`)
        .get()?.count ?? 0;

      const failedJobs = db.select({ count: sql<number>`count(*)` }).from(ttsGenerationJobs)
        .where(sql`book_id = ${bookId} AND user_id = ${userId} AND status = 'failed'`)
        .get()?.count ?? 0;

      // 按需播放产生的缓存（按 bookId 精确统计）
      const cachedChunks = db.select({ count: sql<number>`count(*)` }).from(ttsCache)
        .where(sql`user_id = ${userId} AND book_id = ${bookId}`)
        .get()?.count ?? 0;

      // 进度 = 已完成分片 / 总分片
      const voiceGenerationRate = totalChunks > 0 ? Math.min(1, completedChunks / totalChunks) : 0;

      // 内容缓存统计（已通过顶部静态导入 getBookCacheStats）
      const cacheStats = getBookCacheStats(db, bookId, userId);

      res.json({
        success: true,
        data: {
          readingPercentage,
          voiceGenerationRate,
          totalChapters,
          completedVoiceChapters: completedChunks,
          totalVoiceChunks: totalChunks,
          pendingVoiceChapters: pendingJobs,
          failedVoiceChapters: failedJobs,
          totalVoiceJobs: (jobStatus === 'completed' ? 1 : 0) + pendingJobs + failedJobs,
          jobStatus,
          jobProgress,
          ttsCacheCount: cachedChunks,
          cachedChapters: cacheStats.cachedChapters,
          cacheType: cacheStats.cacheType,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/books/:id/files/* - 获取 EPUB 提取的静态资源（图片/CSS/字体等） ──
  router.get('/:id/files/*', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');
      if (book.format !== 'epub') throw new AppError(400, '仅 EPUB 格式支持此操作');

      const fileRelPath = req.params[0];
      if (!fileRelPath) throw new AppError(400, '文件路径不能为空');

      // Security: prevent path traversal
      const normalizedPath = path.normalize(fileRelPath);
      if (normalizedPath.startsWith('..') || normalizedPath.includes('..')) {
        throw new AppError(403, '禁止访问上级目录');
      }

      const extractedDir = path.join(path.dirname(book.filePath), 'extracted');
      const filePath = path.join(extractedDir, normalizedPath);

      if (!fs.existsSync(filePath)) {
        throw new AppError(404, '文件不存在');
      }

      // Security: ensure resolved path stays within extracted directory
      const resolvedPath = path.resolve(filePath);
      const resolvedExtractedDir = path.resolve(extractedDir);
      if (!resolvedPath.startsWith(resolvedExtractedDir)) {
        throw new AppError(403, '禁止越权访问');
      }

      res.sendFile(filePath);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/books/dedup - 对书架上已存在的书籍进行去重 ──
  router.post('/dedup', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const userBooks = db.select().from(books).where(sql`user_id = ${userId}`).all() as any[];
      let removed = 0;
      let kept = 0;

      // 先为没有 file_hash 的书籍计算哈希
      const toHash = userBooks.filter((b: any) => !b.fileHash);
      for (const b of toHash) {
        if (fs.existsSync(b.filePath)) {
          try {
            b.fileHash = await computeFileHash(b.filePath);
            db.update(books).set({ fileHash: b.fileHash, updatedAt: new Date().toISOString() })
              .where(sql`id = ${b.id}`).run();
          } catch {
            // 无法读取文件，跳过
            continue;
          }
        }
      }

      // 重新读取包含 hash 的完整列表
      const allBooks = db.select().from(books).where(sql`user_id = ${userId}`).all() as any[];

      // 按 hash 分组
      const groups = new Map<string, any[]>();
      for (const b of allBooks) {
        if (!b.fileHash) continue; // 无 hash 的书籍跳过
        if (!groups.has(b.fileHash)) groups.set(b.fileHash, []);
        groups.get(b.fileHash)!.push(b);
      }

      // 对每组重复书籍：保留最早创建的，删除其他
      for (const [, group] of groups) {
        if (group.length <= 1) continue;
        // 按创建时间排序，保留最早创建的
        group.sort((a: any, b: any) => a.createdAt.localeCompare(b.createdAt));
        const keep = group[0];
        const duplicates = group.slice(1);

        for (const dup of duplicates) {
          // 删除关联数据
          db.delete(readingProgress).where(sql`book_id = ${dup.id}`).run();
          db.delete(bookChapters).where(sql`book_id = ${dup.id}`).run();
          db.delete(ttsGenerationJobs).where(sql`book_id = ${dup.id}`).run();
          db.delete(books).where(sql`id = ${dup.id}`).run();
          // 删除物理文件
          const dupDir = path.join(booksDir, dup.id);
          if (fs.existsSync(dupDir)) {
            fs.rmSync(dupDir, { recursive: true, force: true });
          }
          removed++;
        }
        kept++;
      }

      res.json({
        success: true,
        data: { removed, kept, totalBefore: allBooks.length, totalAfter: allBooks.length - removed },
        message: removed > 0
          ? `去重完成：删除了 ${removed} 本重复书籍，保留了 ${kept} 本唯一书籍`
          : '📚 书架已是去重状态，未发现重复书籍',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
  return router;
  return router;
  return router;
}
