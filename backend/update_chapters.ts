import { parseBook } from './src/parser/index.js';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = '/home/ubuntu/.ireader/data/ireader.sqlite';
const booksDir = '/home/ubuntu/.ireader/data/books';
const bookId = '9d159acc-9074-496d-b881-34c6f94104ed';
const db = new Database(dbPath);

const bookDir = path.join(booksDir, bookId);
const sourceFile = path.join(bookDir, 'original.epub');

// 重新解析
console.log('🔍 正在解析 EPUB...');
const result = await parseBook(sourceFile, 'epub', bookDir);
console.log(`📖 ${result.title} - ${result.chapters.length} 章`);

// 删除旧章节
const deleted = db.prepare('DELETE FROM book_chapters WHERE book_id = ?').run(bookId);
console.log(`🗑️ 删除 ${deleted.changes} 条旧章节`);

// 插入新章节
const insert = db.prepare(
  'INSERT INTO book_chapters (id, book_id, title, href, start_offset, end_offset, "order", level) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const insertMany = db.transaction((chapters: any[]) => {
  for (const ch of chapters) {
    insert.run(uuidv4(), bookId, ch.title, ch.href || null, ch.startOffset ?? null, ch.endOffset ?? null, ch.order, ch.level);
  }
});
insertMany(result.chapters);

// 更新书籍状态
db.prepare('UPDATE books SET title = ?, author = ?, status = ?, updated_at = ? WHERE id = ?').run(
  result.title, result.author || '娑罗双树', 'ready', new Date().toISOString(), bookId
);

const count = db.prepare('SELECT COUNT(*) as cnt FROM book_chapters WHERE book_id = ?').get(bookId) as any;
console.log(`✅ 数据库更新完成！现共 ${count.cnt} 章`);
db.close();
