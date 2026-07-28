import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

// ── 用户表 ──
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  email: text('email'),
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
  fileHash: text('file_hash'),
  size: integer('size').notNull(),
  status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull().default('processing'),
  parseError: text('parse_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  pinned: integer('pinned').notNull().default(0),
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
  fragment: text('fragment'),
  spineIndex: integer('spine_index'),
  normalizedText: text('normalized_text'),
  contentHash: text('content_hash'),
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
  /** 单调递增版本号，每次写入 +1，用于多设备冲突合并 */
  progressVersion: integer('progress_version').notNull().default(1),
  /** 写入来源设备标识（前端生成并持久化） */
  deviceId: text('device_id'),
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
  bookId: text('book_id').references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  segmentIndex: integer('segment_index'),
  source: text('source').notNull().default('edgetts'),
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

export const contentSegments = sqliteTable('content_segments', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id').notNull().references(() => bookChapters.id, { onDelete: 'cascade' }),
  segmentIndex: integer('segment_index').notNull(),
  text: text('text').notNull(),
  textHash: text('text_hash').notNull(),
  startOffset: integer('start_offset').notNull(),
  endOffset: integer('end_offset').notNull(),
  createdAt: text('created_at').notNull(),
});

// ── TTS 后台生成任务表 ──
export const ttsGenerationJobs = sqliteTable('tts_generation_jobs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  chapterCount: integer('chapter_count'),
  chapterIds: text('chapter_ids'),
  voice: text('voice').notNull(),
  speed: real('speed').notNull(),
  source: text('source'),
  engineConfigHash: text('engine_config_hash'),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  progress: integer('progress').notNull().default(0),
  totalChunks: integer('total_chunks').notNull().default(0),
  completedChunks: integer('completed_chunks').notNull().default(0),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const ttsGenerationSegments = sqliteTable('tts_generation_segments', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => ttsGenerationJobs.id, { onDelete: 'cascade' }),
  segmentId: text('segment_id').notNull().references(() => contentSegments.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  audioResourceId: text('audio_resource_id'),
  error: text('error'),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
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
  source: text('source').notNull().default('openai'),
  model: text('model'),
  voiceId: text('voice_id').notNull().default('alloy'),
  speed: real('speed').notNull().default(1.0),
  apiUrl: text('api_url'),
  apiKey: text('api_key'),
  preGenerateConcurrency: integer('pre_generate_concurrency').notNull().default(3),
  autoPreSynthesize: integer('auto_pre_synthesize', { mode: 'boolean' }).notNull().default(false),
  firstChunkMaxSize: integer('first_chunk_max_size').notNull().default(32),
  normalChunkMaxSize: integer('normal_chunk_max_size').notNull().default(128),
  updatedAt: text('updated_at').notNull(),
});

// ── 全局书籍表（按 fileHash 去重，物理文件全局唯一） ──
export const globalBooks = sqliteTable('global_books', {
  id: text('id').primaryKey(),
  fileHash: text('file_hash').notNull().unique(),
  title: text('title').notNull(),
  author: text('author'),
  format: text('format', { enum: ['epub', 'txt'] }).notNull(),
  filePath: text('file_path').notNull(),
  coverPath: text('cover_path'),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'), // 引用归零时记录，30天后清理
});

// ── 用户书籍引用表（记录用户与全局书籍的引用关系） ──
export const userBookRefs = sqliteTable('user_book_refs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  globalBookId: text('global_book_id').notNull().references(() => globalBooks.id, { onDelete: 'cascade' }),
  localBookId: text('local_book_id').notNull().references(() => books.id, { onDelete: 'cascade' }),
  refCount: integer('ref_count').notNull().default(1),
  deletedAt: text('deleted_at'), // 用户删除时记录，不再显示在书架上
  createdAt: text('created_at').notNull(),
});

// ── 全局 TTS 资源表（按 textHash+voice+speed+bookId 去重，音频文件全局唯一） ──
export const ttsGlobalResources = sqliteTable('tts_global_resources', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => globalBooks.id, { onDelete: 'cascade' }),
  chapterId: text('chapter_id'),
  segmentIndex: integer('segment_index'),
  source: text('source').notNull().default('edgetts'),
  textHash: text('text_hash').notNull(),
  voice: text('voice').notNull(),
  speed: real('speed').notNull(),
  audioPath: text('audio_path').notNull(),
  fileSize: integer('file_size'),
  createdAt: text('created_at').notNull(),
  deletedAt: text('deleted_at'), // 引用归零时记录，30天后清理
});

// ── TTS 引用表（记录用户与全局 TTS 资源的引用关系） ──
export const ttsRefs = sqliteTable('tts_refs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  globalResourceId: text('global_resource_id').notNull().references(() => ttsGlobalResources.id, { onDelete: 'cascade' }),
  localCacheId: text('local_cache_id'), // 可选：关联用户自己的 tts_cache 记录
  refCount: integer('ref_count').notNull().default(1),
  deletedAt: text('deleted_at'),
  createdAt: text('created_at').notNull(),
});

// ===== 类型导出 =====

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Book = typeof books.$inferSelect;
export type NewBook = typeof books.$inferInsert;

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type BookChapter = typeof bookChapters.$inferSelect;
export type NewBookChapter = typeof bookChapters.$inferInsert;

export type ReadingProgress = typeof readingProgress.$inferSelect;
export type NewReadingProgress = typeof readingProgress.$inferInsert;

export type TtsCache = typeof ttsCache.$inferSelect;
export type NewTtsCache = typeof ttsCache.$inferInsert;

export type TtsGenerationJob = typeof ttsGenerationJobs.$inferSelect;
export type NewTtsGenerationJob = typeof ttsGenerationJobs.$inferInsert;

export type TtsSettings = typeof ttsSettings.$inferSelect;
export type NewTtsSettings = typeof ttsSettings.$inferInsert;

export type GlobalBook = typeof globalBooks.$inferSelect;
export type NewGlobalBook = typeof globalBooks.$inferInsert;

export type UserBookRef = typeof userBookRefs.$inferSelect;
export type NewUserBookRef = typeof userBookRefs.$inferInsert;

export type TtsGlobalResource = typeof ttsGlobalResources.$inferSelect;
export type NewTtsGlobalResource = typeof ttsGlobalResources.$inferInsert;

export type TtsRef = typeof ttsRefs.$inferSelect;
export type NewTtsRef = typeof ttsRefs.$inferInsert;