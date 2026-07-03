import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export function initDatabase(dbPath?: string): ReturnType<typeof drizzle> {
  const resolvedPath = dbPath || path.join(process.env.DATA_DIR || process.cwd(), 'ireader.sqlite');
  
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const sqlite = new Database(resolvedPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  
  // Create tables (new version with user_id support)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      author TEXT,
      format TEXT NOT NULL CHECK(format IN ('epub', 'txt')),
      category_id TEXT,
      file_path TEXT NOT NULL,
      cover_path TEXT,
      size INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'ready', 'failed')),
      parse_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      parent_id TEXT,
      sort INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS book_chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      href TEXT,
      start_offset INTEGER,
      end_offset INTEGER,
      "order" INTEGER NOT NULL,
      level INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT,
      cfi TEXT,
      text_offset INTEGER,
      percentage REAL,
      page_index INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tts_cache (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text_hash TEXT NOT NULL,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      audio_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS book_content_cache (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT,
      content TEXT NOT NULL,
      cache_type TEXT NOT NULL DEFAULT 'chapter' CHECK(cache_type IN ('full_book', 'chapter', 'partial')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tts_generation_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      chapter_id TEXT,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      progress INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      completed_chunks INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS voice_cache (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      last_used_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tts_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'edgetts',
      voice_id TEXT NOT NULL DEFAULT 'zh-CN-XiaoxiaoNeural',
      speed REAL NOT NULL DEFAULT 1.0,
      api_url TEXT,
      api_key TEXT,
      pre_generate_concurrency INTEGER NOT NULL DEFAULT 3,
      first_chunk_max_size INTEGER NOT NULL DEFAULT 32,
      normal_chunk_max_size INTEGER NOT NULL DEFAULT 128,
      updated_at TEXT NOT NULL
    );
  `);

  // ── 旧表迁移：检测并自动添加 user_id 列 ──
  // 注意：必须在 CREATE TABLE IF NOT EXISTS 之后运行，确保 users 表已存在
  migrateOldTables(sqlite);
migrateOldTables(sqlite);

  // ── 单独检查 tts_settings 的 api_url/api_key 列（旧版 migrateOldTables 可能跳过此步骤） ──
  try {
    const ttsCols = sqlite.prepare("PRAGMA table_info('tts_settings')").all() as { name: string }[];
    const hasApiUrl = ttsCols.some(c => c.name === 'api_url');
    if (!hasApiUrl) {
      console.log('[迁移] tts_settings 缺少 api_url/api_key 列，正在补充...');
      sqlite.exec(`
        ALTER TABLE tts_settings ADD COLUMN api_url TEXT;
        ALTER TABLE tts_settings ADD COLUMN api_key TEXT;
      `);
      console.log('[迁移] tts_settings 列补充完成 ✅');
    }

    const hasAutoPreSynth = ttsCols.some(c => c.name === 'auto_pre_synthesize');
    if (!hasAutoPreSynth) {
      console.log('[迁移] tts_settings 缺少 auto_pre_synthesize 列，正在补充...');
      sqlite.exec(`ALTER TABLE tts_settings ADD COLUMN auto_pre_synthesize INTEGER NOT NULL DEFAULT 0;`);
      console.log('[迁移] tts_settings auto_pre_synthesize 列补充完成 ✅');
    }
  } catch (err) {
    console.error('[迁移] tts_settings 列补充失败:', (err as Error).message);
  }

  // ── 旧表迁移：检查是否需要从旧版升级 ──
  const userCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number };
  if (userCount.cnt === 0) {
    // 创建默认管理员用户（密码：admin123）
    const defaultUserId = 'default-user';
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.pbkdf2Sync('admin123', salt, 100000, 64, 'sha512').toString('hex');
    const fullHash = `${salt}:${passwordHash}`;
    const now = new Date().toISOString();

    sqlite.prepare(`
      INSERT INTO users (id, username, password_hash, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(defaultUserId, 'admin', fullHash, '管理员', now, now);

    // 检查旧表是否有数据需要迁移
    const oldBooksCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM books').get() as { cnt: number };

    if (oldBooksCount.cnt > 0) {
      // 检查 books 表是否有 user_id 列（旧表没有则已用新 DDL 重建，需要从临时表迁移）
      const columns = sqlite.prepare("PRAGMA table_info('books')").all() as { name: string }[];
      const hasUserId = columns.some(c => c.name === 'user_id');

      if (!hasUserId) {
        // 旧版表结构：数据在旧表中，新表是空的
        // 直接将旧数据复制到新表
        sqlite.exec(`
          INSERT OR IGNORE INTO categories (id, user_id, name, parent_id, sort)
          SELECT id, '${defaultUserId}', name, parent_id, sort FROM categories
          WHERE id NOT IN (SELECT id FROM categories WHERE user_id = '${defaultUserId}');

          INSERT OR IGNORE INTO reading_progress (id, user_id, book_id, chapter_id, cfi, text_offset, percentage, page_index, updated_at)
          SELECT id, '${defaultUserId}', book_id, chapter_id, cfi, text_offset, percentage, page_index, updated_at FROM reading_progress;

          INSERT OR IGNORE INTO settings (key, user_id, value)
          SELECT key, '${defaultUserId}', value FROM settings;

          INSERT OR IGNORE INTO tts_cache (id, user_id, text_hash, voice, speed, audio_path, created_at)
          SELECT id, '${defaultUserId}', text_hash, voice, speed, audio_path, created_at FROM tts_cache;

          INSERT OR IGNORE INTO tts_settings (user_id, enabled, source, voice_id, speed, api_url, api_key, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, auto_pre_synthesize, updated_at)
          SELECT '${defaultUserId}', enabled, source, voice_id, speed, api_url, api_key, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at FROM tts_settings;
        `);
      }
    }

    // 为新用户创建默认分类
    const defaultCat = sqlite.prepare("SELECT id FROM categories WHERE user_id = ? AND name = '未分类'").get(defaultUserId);
    if (!defaultCat) {
      sqlite.prepare("INSERT INTO categories (id, user_id, name, sort) VALUES (?, ?, '未分类', 0)")
        .run(crypto.randomUUID(), defaultUserId);
    }

    // 为新用户创建默认 TTS 设置
    const ttsExist = sqlite.prepare('SELECT user_id FROM tts_settings WHERE user_id = ?').get(defaultUserId);
    if (!ttsExist) {
      sqlite.prepare(`
        INSERT INTO tts_settings (user_id, enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
        VALUES (?, 1, 'edgetts', 'zh-CN-XiaoxiaoNeural', 1.0, 3, 32, 128, ?)
      `).run(defaultUserId, now);
    }
  }

  return db;
}

/**
 * 数据库迁移：检查旧表并自动添加 user_id 列（v0.1 → v0.2）
 * 此函数不依赖用户计数，始终运行——适用于已有用户的旧数据库升级。
 */
function migrateOldTables(sqlite: Database.Database) {
  try {
    // 以 categories 表为哨兵：检查是否已有 user_id 列
    const columns = sqlite.prepare("PRAGMA table_info('categories')").all() as { name: string }[];
    const hasUserId = columns.some(c => c.name === 'user_id');
    if (hasUserId) return; // 已迁移，跳过

    console.log('[迁移] 检测到旧版数据库，正在添加 user_id 列...');

    const defaultUserId = 'default-user';

    // 1-5: ALTER TABLE 添加列
    sqlite.exec(`
      ALTER TABLE categories ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      UPDATE categories SET user_id = '${defaultUserId}' WHERE user_id IS NULL;

      ALTER TABLE books ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      UPDATE books SET user_id = '${defaultUserId}' WHERE user_id IS NULL;

      ALTER TABLE reading_progress ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      UPDATE reading_progress SET user_id = '${defaultUserId}' WHERE user_id IS NULL;

      ALTER TABLE settings ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      UPDATE settings SET user_id = '${defaultUserId}' WHERE user_id IS NULL;

      ALTER TABLE tts_cache ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
      UPDATE tts_cache SET user_id = '${defaultUserId}' WHERE user_id IS NULL;
    `);

    // 6. tts_settings 表：主键完全变更，重建
    const ttsSettingsExist = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tts_settings'").get();
    if (ttsSettingsExist) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS tts_settings_new (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 1,
          source TEXT NOT NULL DEFAULT 'kokoro',
          voice_id TEXT NOT NULL DEFAULT 'zf_xiaobei',
          speed REAL NOT NULL DEFAULT 1.0,
          api_url TEXT,
          api_key TEXT,
          pre_generate_concurrency INTEGER NOT NULL DEFAULT 3,
          first_chunk_max_size INTEGER NOT NULL DEFAULT 32,
          normal_chunk_max_size INTEGER NOT NULL DEFAULT 128,
          updated_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO tts_settings_new (user_id, enabled, source, voice_id, speed, api_url, api_key, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
        SELECT '${defaultUserId}', enabled, source, voice_id, speed, api_url, api_key, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at FROM tts_settings;
        DROP TABLE IF EXISTS tts_settings;
        ALTER TABLE tts_settings_new RENAME TO tts_settings;
        INSERT OR IGNORE INTO tts_settings (user_id, enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
        VALUES ('${defaultUserId}', 1, 'edgetts', 'zh-CN-XiaoxiaoNeural', 1.0, 3, 32, 128, datetime('now'));
      `);
    }

    console.log('[迁移] 数据库升级完成 ✅');
  } catch (err) {
    console.error('[迁移] 数据库升级失败（可能是新表或已有列，忽略）:', (err as Error).message);
  }
}
