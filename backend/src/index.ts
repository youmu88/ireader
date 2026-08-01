import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './db/init.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import { tryProcessQueue, createFullBookGenerationJob } from './services/ttsGenerationService.js';
import { startCleanupScheduler } from './services/globalResourceService.js';
import { books, ttsSettings, ttsGenerationJobs } from './db/schema.js';
import { sql } from 'drizzle-orm';

// ESM-compatible current directory
const __filename = fileURLToPath(import.meta.url);
const _curDir = path.dirname(__filename);
import { createAuthRouter } from './routes/auth.js';
import { createBooksRouter } from './routes/books.js';
import { createCategoriesRouter } from './routes/categories.js';
import { createProgressRouter } from './routes/progress.js';
import { createBookmarksRouter } from './routes/bookmarks.js';
import { createTtsRouter } from './routes/tts.js';
import { config } from 'dotenv';

config();

const PORT = parseInt(process.env.PORT || '10000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME || process.cwd(), '.ireader', 'data');

// Initialize database
const db = initDatabase(path.join(DATA_DIR, 'ireader.sqlite'));

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Static files (served in production)
// Resolve frontend/dist relative to the project root, NOT process.cwd(),
// so it also works when the backend is launched from a deployed directory
// (e.g. ~/.ireader/app/backend) where cwd != project root.
// _curDir here is <projectRoot>/backend/(src|dist); go up TWO levels to reach <projectRoot>
// (backend/dist -> backend -> projectRoot). FRONTEND_DIST env overrides for deployments.
const projectRoot = path.resolve(_curDir, '..', '..');
const staticDir =
  process.env.FRONTEND_DIST || path.join(projectRoot, 'frontend', 'dist');

// 静态资源强缓存策略：
//  - assets/ 下的 vender/app chunk（文件名含内容 hash）→ immutable 长缓存（命中强缓存，跳过网络）
//  - index.html（SPA 入口）→ no-cache（每次校验 ETag，避免新部署被旧缓存卡住）
// 目标：react-vendor / router-vendor 等带 hash 的 chunk 在浏览器强缓存命中，无需重新下载。
app.use('/assets', express.static(path.join(staticDir, 'assets'), {
  maxAge: '1y',
  immutable: true,
  etag: true,
}));
app.use(express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// API routes
app.use('/api', healthRouter);
app.use('/api/auth', createAuthRouter(db));
app.use('/api/books', createBooksRouter(db, DATA_DIR));
app.use('/api/categories', createCategoriesRouter(db));
app.use('/api', createProgressRouter(db));
app.use('/api', createBookmarksRouter(db));
app.use('/api/tts', createTtsRouter(db, DATA_DIR));

// SPA fallback (for client-side routing)
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Error handler
app.use(errorHandler);

// 启动全局引用清理调度器（每小时扫描 ref_count=0 超过30天的资源）
startCleanupScheduler(db, DATA_DIR);

// 启动时扫描并处理未完成的 TTS 生成任务
tryProcessQueue(db, DATA_DIR);
setInterval(() => tryProcessQueue(db, DATA_DIR), 30000);

// 自动为尚无 TTS 任务的书籍创建生成任务
setTimeout(async () => {
  try {
    const allBooks = db.select({ id: books.id, userId: books.userId }).from(books).all() as any[];
    let created = 0;
    for (const b of allBooks) {
      // 检查用户是否开启了后台预合成
      const settings = db.select()
        .from(ttsSettings)
        .where(sql`user_id = ${b.userId}`)
        .get() as any;
      if (!settings || !settings.autoPreSynthesize) continue;

      const existing = db.select({ id: ttsGenerationJobs.id })
        .from(ttsGenerationJobs)
        .where(sql`book_id = ${b.id}`)
        .get() as any;
      if (existing) continue;
      
      const voice = settings?.voice_id || 'zh-CN-XiaoxiaoNeural';
      const speed = settings?.speed || 1.0;
      createFullBookGenerationJob(db, b.id, b.userId, voice, speed, DATA_DIR);
      created++;
    }
    if (created > 0) {
      console.log(`[TTS] 自动创建了 ${created} 本书的语音生成任务`);
    }
  } catch (err) {
    console.error('[TTS] 自动创建任务失败:', (err as Error).message);
  }
}, 1000);

app.listen(PORT, () => {
  console.log(`📚 iReader server running at http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log('🤖 TTS generation queue started (polling every 30s)');
});

export { app, db };
