import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import path from 'path';
import fs from 'fs';

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
  
  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
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
      value TEXT NOT NULL
    );

        CREATE TABLE IF NOT EXISTS tts_cache (
      id TEXT PRIMARY KEY,
      text_hash TEXT NOT NULL,
      voice TEXT NOT NULL,
      speed REAL NOT NULL,
      audio_path TEXT NOT NULL,
      created_at TEXT NOT NULL
    );


CREATE TABLE IF NOT EXISTS tts_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'kokoro',
      voice_id TEXT NOT NULL DEFAULT 'zf_xiaobei',
      speed REAL NOT NULL DEFAULT 1.0,
      pre_generate_concurrency INTEGER NOT NULL DEFAULT 3,
      first_chunk_max_size INTEGER NOT NULL DEFAULT 32,
      normal_chunk_max_size INTEGER NOT NULL DEFAULT 128,
      updated_at TEXT NOT NULL
    );
  `);

  // Insert default settings if not exists
  const defaultTtsSettings = sqlite.prepare('SELECT id FROM tts_settings WHERE id = 1').get();
  if (!defaultTtsSettings) {
    sqlite.prepare(`
      INSERT INTO tts_settings (id, enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
      VALUES (1, 1, 'kokoro', 'zf_xiaobei', 1.0, 3, 32, 128, ?)
    `).run(new Date().toISOString());
  }

  // Insert default category if not exists
  const defaultCat = sqlite.prepare("SELECT id FROM categories WHERE name = '未分类'").get();
  if (!defaultCat) {
    sqlite.prepare("INSERT INTO categories (id, name, sort) VALUES (?, '未分类', 0)").run('default-uncategorized');
  }

  return db;
}
