import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from './init.js';
import { books, bookChapters, categories, readingProgress, settings, ttsSettings } from './schema.js';
import { sql } from 'drizzle-orm';
import fs from 'fs';
import path from 'path';

describe('Database Init', () => {
  const testDbPath = path.join('/tmp', `ireader-test-${Date.now()}.sqlite`);

  afterEach(() => {
    try {
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch { /* ignore cleanup errors */ }
  });

  it('should create database and tables', () => {
    const db = initDatabase(testDbPath);
    expect(db).toBeDefined();
    expect(fs.existsSync(testDbPath)).toBe(true);

    // Verify tables exist by selecting schema objects
    const allBooks = db.select().from(books).all();
    expect(allBooks).toEqual([]);
  });

  it('should insert default tts_settings', () => {
    const db = initDatabase(testDbPath);
    const result = db.select().from(ttsSettings).where(sql`id = 1`).all();
    expect(result.length).toBe(1);
    expect(result[0].source).toBe('kokoro');
  });

  it('should insert default uncategorized category', () => {
    const db = initDatabase(testDbPath);
    const result = db.select().from(categories).where(sql`name = '未分类'`).all();
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('未分类');
  });
});
