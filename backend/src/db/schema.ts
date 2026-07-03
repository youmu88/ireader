import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ── 用户表 ──
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const books = sqliteTable('books', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  author: text('author'),
  format: text('format', { enum: ['epub', 'txt'] }).notNull(),
  categoryId: text('category_id'),
  filePath: text('file_path').notNull(),
  coverPath: text('cover_path'),
  size: integer('size').notNull(),
  status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull().default('processing'),
  parseError: text('parse_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  sort: integer('sort').notNull().default(0),
});

export const bookChapters = sqliteTable('book_chapters', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  href: text('href'),
  startOffset: integer('start_offset'),
  endOffset: integer('end_offset'),
  order: integer('order').notNull(),
  level: integer('level').notNull().default(1),
});

export const readingProgress = sqliteTable('reading_progress', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  cfi: text('cfi'),
  textOffset: integer('text_offset'),
  percentage: real('percentage'),
  pageIndex: integer('page_index'),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  value: text('value').notNull(),
});

export const ttsCache = sqliteTable('tts_cache', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  textHash: text('text_hash').notNull(),
  voice: text('voice').notNull(),
  speed: real('speed').notNull(),
  audioPath: text('audio_path').notNull(),
  createdAt: text('created_at').notNull(),
});

// ── 书籍内容缓存表 ──
export const bookContentCache = sqliteTable('book_content_cache', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  content: text('content').notNull(),
  cacheType: text('cache_type', { enum: ['full_book', 'chapter', 'partial'] }).notNull().default('chapter'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── TTS 后台生成任务表 ──
export const ttsGenerationJobs = sqliteTable('tts_generation_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  voice: text('voice').notNull(),
  speed: real('speed').notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  totalChunks: integer('total_chunks').notNull().default(0),
  completedChunks: integer('completed_chunks').notNull().default(0),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ── 音色 LRU 缓存表（每本书保留最近 N 个音色） ──
export const voiceCache = sqliteTable('voice_cache', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  voice: text('voice').notNull(),
  speed: real('speed').notNull(),
  lastUsedAt: text('last_used_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const ttsSettings = sqliteTable('tts_settings', {
  userId: text('user_id').primaryKey().notNull().references(() => users.id, { onDelete: 'cascade' }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  source: text('source').notNull().default('edgetts'),
  voiceId: text('voice_id').notNull().default('zh-CN-XiaoxiaoNeural'),
  speed: real('speed').notNull().default(1.0),
  apiUrl: text('api_url'),
  apiKey: text('api_key'),
  preGenerateConcurrency: integer('pre_generate_concurrency').notNull().default(3),
  autoPreSynthesize: integer('auto_pre_synthesize', { mode: 'boolean' }).notNull().default(false),
  firstChunkMaxSize: integer('first_chunk_max_size').notNull().default(32),
  normalChunkMaxSize: integer('normal_chunk_max_size').notNull().default(128),
  updatedAt: text('updated_at').notNull(),
});
