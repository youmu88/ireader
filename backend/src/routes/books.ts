import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { sql } from 'drizzle-orm';
import { books, bookChapters, readingProgress, ttsGenerationJobs, ttsSettings, ttsCache, userBookRefs, globalBooks } from '../db/schema.js';
import { AppError } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { parseBook, getChapterContent, parseTxt } from '../parser/index.js';
import { getBookCacheStats } from '../services/contentCacheService.js';
import { computeFileHash, findGlobalBookByHash, createGlobalBook, createUserBookRef, findUserActiveBookRef, removeUserBookRef } from '../services/globalResourceService.js';
import crypto from 'crypto';

// computeFileHash 已迁移到 globalResourceService.js

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
   * 全局书库目录（统一存放全局唯一书籍的物理文件）
   */
  const globalBooksDir = path.join(dataDir, 'global-books');
  if (!fs.existsSync(globalBooksDir)) {
    fs.mkdirSync(globalBooksDir, { recursive: true });
  }

  /**
   * 读取并返回书籍章节内容（用于复用全局书籍时直接复制章节）
   */
  async function extractAndSaveChapters(sourcePath: string, format: 'epub' | 'txt', bookDir: string): Promise<{
    title: string;
    author: string | null;
    coverPath: string | null;
    chapters: import('../parser/index.js').ChapterManifest[];
  }> {
    const parseResult = await parseBook(sourcePath, format, bookDir);
    // 尝试提取封面
    let coverPath: string | null = null;
    if (parseResult.coverPath) {
      const coverSrc = path.join(bookDir, 'extracted', parseResult.coverPath);
      const coverExt = path.extname(coverSrc) || '.jpg';
      const coverDest = path.join(bookDir, `cover${coverExt}`);
      if (fs.existsSync(coverSrc)) {
        fs.copyFileSync(coverSrc, coverDest);
        coverPath = coverDest;
      }
    }
    return {
      title: parseResult.title,
      author: parseResult.author || null,
      coverPath,
      chapters: parseResult.chapters,
    };
  }

  /**
   * 处理单文件上传：全局引用逻辑
   * - 先计算 fileHash
   * - 若 global_books 已有相同 hash → 复用物理文件 + 引用+1，不重新存储/解压
   * - 若没有 → 存储到全局目录，解析后存入全局书库
   */
  const processUpload = async (file: Express.Multer.File, now: string, userId: string): Promise<any> => {
    const { format, ext: detectedExt } = detectBookFormat(file.originalname);
    const storageExt = buildStorageExt(detectedExt);
    const bookId = uuidv4();
    const localBookDir = path.join(booksDir, bookId);

    // 先计算文件哈希（同步阻塞，因为上传响应需要知道是否复用）
    const fileHash = await computeFileHash(file.path);

    // 查询全局书库
    const existingGlobal = findGlobalBookByHash(db, fileHash);

    if (existingGlobal) {
      // ── 已有相同书籍，复用 ──
      // 创建用户的 local book 记录（指向全局文件）
      const targetPath = existingGlobal.filePath;

      fs.mkdirSync(localBookDir, { recursive: true });

      const bookRecord = {
        id: bookId,
        userId,
        title: extractTitle(file.originalname),
        author: existingGlobal.author,
        format,
        categoryId: null,
        filePath: targetPath,
        coverPath: existingGlobal.coverPath,
        fileHash,
        size: existingGlobal.size,
        status: 'ready' as const,
        parseError: null,
        createdAt: now,
        updatedAt: now,
        pinned: 0,
      };
      db.insert(books).values(bookRecord).run();

      // 复制全局书籍的章节信息到当前用户的 book_chapters
      const globalBookChapters = db.select().from(bookChapters)
        .where(sql`book_id = (SELECT local_book_id FROM user_book_refs WHERE global_book_id = ${existingGlobal.id} LIMIT 1)`)
        .all() as any[];
      
      if (globalBookChapters.length > 0) {
        for (const ch of globalBookChapters) {
          db.insert(bookChapters).values({
            id: uuidv4(),
            bookId,
            title: ch.title,
            href: ch.href,
            fragment: (ch as any).fragment ?? null,
            spineIndex: (ch as any).spineIndex ?? null,
            normalizedText: (ch as any).normalizedText ?? null,
            contentHash: (ch as any).contentHash ?? null,
            startOffset: ch.startOffset,
            endOffset: ch.endOffset,
            order: ch.order,
            level: ch.level,
          }).run();
        }
      } else {
        // 没有任何引用时，需要重新解析（首次创建时已解析，不会走到这里）
        // 但兜底：尝试本地解析
        try {
          const parseInfo = await extractAndSaveChapters(targetPath, format!, localBookDir);
          for (const ch of parseInfo.chapters) {
            db.insert(bookChapters).values({
              id: uuidv4(),
              bookId,
              title: ch.title,
              href: (ch as any).href || null,
              fragment: (ch as any).fragment ?? null,
              spineIndex: (ch as any).spineIndex ?? null,
              normalizedText: (ch as any).normalizedText ?? null,
              contentHash: (ch as any).contentHash ?? null,
              startOffset: ch.startOffset ?? null,
              endOffset: ch.endOffset ?? null,
              order: ch.order,
              level: ch.level,
            }).run();
          }
        } catch { /* 静默 */ }
      }

      // 创建用户引用
      createUserBookRef(db, userId, existingGlobal.id, bookId);

      // 清理临时上传文件
      try { if (fs.existsSync(file.path)) fs.unlinkSync(file.path); } catch { /* ignore */ }

      return db.select().from(books).where(sql`id = ${bookId}`).get();
    }

    // ── 全新书籍：存储到全局目录并解析 ──
    const gBookId = uuidv4();
    const gBookDir = path.join(globalBooksDir, gBookId);
    fs.mkdirSync(gBookDir, { recursive: true });
    const globalTargetPath = path.join(gBookDir, `original${storageExt}`);

    // 移动文件到全局目录
    fs.renameSync(file.path, globalTargetPath);

    // 创建全局书籍记录
    const gBook = createGlobalBook(db, fileHash, extractTitle(file.originalname), null, format!, globalTargetPath, null, file.size);

    // 解析书籍（提取章节、封面、元数据）
    try {
      const parseInfo = await extractAndSaveChapters(globalTargetPath, format!, gBookDir);

      // 更新全局书籍元数据
      db.update(globalBooks).set({
        title: parseInfo.title,
        author: parseInfo.author || gBook.author,
        coverPath: parseInfo.coverPath,
      } as any).where(sql`id = ${gBook.id}`).run();

      // 创建用户的 local book 记录
      fs.mkdirSync(localBookDir, { recursive: true });
      const bookRecord = {
        id: bookId,
        userId,
        title: parseInfo.title,
        author: parseInfo.author,
        format,
        categoryId: null,
        filePath: globalTargetPath,
        coverPath: parseInfo.coverPath,
        fileHash,
        size: file.size,
        status: 'ready' as const,
        parseError: null,
        createdAt: now,
        updatedAt: now,
        pinned: 0,
      };
      db.insert(books).values(bookRecord).run();

      // 写入章节（ChapterManifest 全字段持久化）
      for (const ch of parseInfo.chapters) {
        db.insert(bookChapters).values({
          id: uuidv4(),
          bookId,
          title: ch.title,
          href: ch.href,
          fragment: ch.fragment,
          spineIndex: ch.spineIndex,
          normalizedText: ch.normalizedText,
          contentHash: ch.contentHash,
          startOffset: ch.startOffset,
          endOffset: ch.endOffset,
          order: ch.order,
          level: ch.level,
        }).run();
      }

      // 创建用户引用
      createUserBookRef(db, userId, gBook.id, bookId);

      return db.select().from(books).where(sql`id = ${bookId}`).get();
    } catch (parseErr: any) {
      // 解析失败时标记，保留文件但不创建引用
      const bookRecord = {
        id: bookId,
        userId,
        title: extractTitle(file.originalname),
        author: null,
        format,
        categoryId: null,
        filePath: globalTargetPath,
        coverPath: null,
        fileHash,
        size: file.size,
        status: 'failed' as const,
        parseError: parseErr.message || '解析失败',
        createdAt: now,
        updatedAt: now,
        pinned: 0,
      };
      fs.mkdirSync(localBookDir, { recursive: true });
      db.insert(books).values(bookRecord).run();
      return db.select().from(books).where(sql`id = ${bookId}`).get();
    }
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

  // ── GET /api/books/:id/resources - 获取 EPUB 离线资源清单 ──
  router.get('/:id/resources', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');
      if (book.format !== 'epub') throw new AppError(400, '仅 EPUB 格式支持资源清单');

      const root = path.resolve(path.dirname(book.filePath), 'extracted');
      if (!fs.existsSync(root)) throw new AppError(404, 'EPUB 资源尚未解压');
      const resources: Array<{ path: string; size: number; contentType: string; hash: string }> = [];
      const getContentType = (filePath: string) => {
        const ext = path.extname(filePath).toLowerCase();
        return ({ '.xhtml': 'application/xhtml+xml', '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.xml': 'application/xml' } as Record<string, string>)[ext] || 'application/octet-stream';
      };
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else {
            const relative = path.relative(root, absolute).split(path.sep).join('/');
            const data = fs.readFileSync(absolute);
            resources.push({ path: relative, size: data.byteLength, contentType: getContentType(absolute), hash: crypto.createHash('sha256').update(data).digest('hex') });
          }
        }
      };
      walk(root);
      res.json({ success: true, data: { bookId: book.id, versionHash: book.fileHash, resources } });
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

  // ── GET /api/books/:id/file/* - 获取 EPUB 内部资源（epub.js 流式按需读取） ──
  // epub.js 通过 ePub("/api/books/:id/file/") 加载整书后，对 zip 内部条目
  // （META-INF/container.xml、OEBPS/*.xhtml、图片/CSS/字体等）按需发起 HTTP 请求，
  // 请求形如 /api/books/:id/file/META-INF/container.xml。
  // 后端已把 EPUB 解压到 extracted/，此处从该目录按相对路径安全读取返回，
  // 使 epub.js 能从服务端按需获取条目，而非一次性下载整个 zip（根治「加载中」卡死）。
  // epub.js 通过 requestHeaders 携带 Bearer Token，内部资源请求同样必须校验用户归属。
  // 资源只能从当前用户拥有的书籍及其 extracted/ 根目录中读取。
  router.get('/:id/file/*', requireAuth, (req: Request, res: Response, next: NextFunction) => {
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
      const isInsideExtractedDir = resolvedPath === resolvedExtractedDir
        || resolvedPath.startsWith(`${resolvedExtractedDir}${path.sep}`);
      if (!isInsideExtractedDir) {
        throw new AppError(403, '禁止越权访问');
      }

      res.sendFile(resolvedPath);
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
        // P1-2: 优先使用 DB 持久化的 normalizedText，遗留数据兜底从文件读取
        let content = (chapter as any).normalizedText || '';
        if (!content) {
          if (chapter.startOffset == null) {
            throw new AppError(400, '该章节没有偏移量信息');
          }
          const parseResult = parseTxt(book.filePath);
          content = getChapterContent(parseResult.content, chapter.startOffset, chapter.endOffset || parseResult.content.length);
        }
        res.json({ success: true, data: { content, normalizedText: content, contentHash: chapter.contentHash, chapter } });
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

          res.json({
            success: true,
            data: {
              content: chapterContent,
              normalizedText: chapter.normalizedText || null,
              contentHash: chapter.contentHash || null,
              chapter,
            },
          });
        } else {
          res.json({ success: true, data: { content: null, chapter, note: 'EPUB 章节内容需由前端通过 epubjs 加载' } });
        }
      }
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/books/:id - 删除图书（引用计数减1，物理文件延迟清理） ──
  router.delete('/:id', requireAuth, (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user!.userId;
      const book = db.select().from(books).where(sql`id = ${req.params.id} AND user_id = ${userId}`).get();
      if (!book) throw new AppError(404, '图书不存在');

      // 删除阅读进度（始终是用户独立的）
      db.delete(readingProgress).where(sql`book_id = ${req.params.id}`).run();

      // 减少引用计数（标记删除，不删物理文件）
      const removed = removeUserBookRef(db, userId, req.params.id);

      // 删除 local book 记录
      db.delete(books).where(sql`id = ${req.params.id}`).run();

      // 注意：不删除物理文件，由定时清理任务处理
      // 不删除 chapters（其他用户还在引用），只删阅读进度

      res.json({ success: true, message: removed ? '图书已移除' : '图书已删除' });
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
            fragment: (chapter as any).fragment ?? null,
            spineIndex: (chapter as any).spineIndex ?? null,
            normalizedText: (chapter as any).normalizedText ?? null,
            contentHash: (chapter as any).contentHash ?? null,
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
      const isInsideExtractedDir = resolvedPath === resolvedExtractedDir
        || resolvedPath.startsWith(`${resolvedExtractedDir}${path.sep}`);
      if (!isInsideExtractedDir) {
        throw new AppError(403, '禁止越权访问');
      }

      res.sendFile(resolvedPath);
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
}
