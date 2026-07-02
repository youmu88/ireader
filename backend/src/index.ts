import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase } from './db/init.js';
import { errorHandler } from './middleware/errorHandler.js';
import healthRouter from './routes/health.js';
import { tryProcessQueue } from './services/ttsGenerationService.js';

// ESM-compatible current directory
const __filename = fileURLToPath(import.meta.url);
const _curDir = path.dirname(__filename);
import { createAuthRouter } from './routes/auth.js';
import { createBooksRouter } from './routes/books.js';
import { createCategoriesRouter } from './routes/categories.js';
import { createProgressRouter } from './routes/progress.js';
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
// Use process.cwd() as project root for both tsx/dev and compiled/prod modes
const staticDir = path.join(process.cwd(), 'frontend', 'dist');
app.use(express.static(staticDir));

// API routes
app.use('/api', healthRouter);
app.use('/api/auth', createAuthRouter(db));
app.use('/api/books', createBooksRouter(db, DATA_DIR));
app.use('/api/categories', createCategoriesRouter(db));
app.use('/api', createProgressRouter(db));
app.use('/api/tts', createTtsRouter(db, DATA_DIR));

// SPA fallback (for client-side routing)
app.get('*', (_req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

// Error handler
app.use(errorHandler);

// 启动时扫描并处理未完成的 TTS 生成任务
tryProcessQueue(db, DATA_DIR);
setInterval(() => tryProcessQueue(db, DATA_DIR), 30000);

app.listen(PORT, () => {
  console.log(`📚 iReader server running at http://localhost:${PORT}`);
  console.log(`📁 Data directory: ${DATA_DIR}`);
  console.log('🤖 TTS generation queue started (polling every 30s)');
});

export { app, db };
