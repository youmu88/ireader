import { describe, it, expect, afterEach } from 'vitest';
import { initDatabase } from './init.js';
import { books, categories, ttsSettings, users } from './schema.js';
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

  it('should NOT seed any user on empty database (D7: no backdoor)', () => {
    const db = initDatabase(testDbPath);
    const userList = db.select().from(users).all();
    expect(userList.length).toBe(0);
  });

  it('should create initial user + default category + default tts settings via options (D7 CLI path)', () => {
    const db = initDatabase(testDbPath, {
      initialUser: { username: 'admin', email: 'admin@example.com', passwordHash: 'testsalt:testhash' },
    });
    const adminUser = db.select().from(users).where(sql`username = 'admin'`).get() as any;
    expect(adminUser).toBeDefined();
    expect(adminUser.id).toBe('default-user');

    const result = db.select().from(ttsSettings).where(sql`user_id = ${adminUser.id}`).all();
    expect(result.length).toBe(1);
    expect((result[0] as any).source).toBe('edgetts');

    const cats = db.select().from(categories).where(sql`name = '未分类' AND user_id = ${adminUser.id}`).all();
    expect(cats.length).toBe(1);
    expect(cats[0].name).toBe('未分类');
  });
});
