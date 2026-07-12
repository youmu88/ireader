/**
 * 全局引用系统 — 存量数据迁移脚本
 * 
 * 作用：将现有 books 表中的所有书籍去重合并到 global_books 表，
 * 创建 user_book_refs 和 tts_refs 引用记录。
 * 
 * 运行方式: tsx src/scripts/migrate-global-refs.ts
 * 
 * 迁移逻辑：
 * 1. 遍历所有 books 记录，按 fileHash（已存在）或重新计算
 * 2. 相同 fileHash 的合并为一条 global_books 记录
 * 3. 为每个用户创建 user_book_refs 引用
 * 4. 已有的 tts_cache 记录按 textHash+voice+speed+bookId 合并到 tts_global_resources
 * 5. 创建 tts_refs 引用记录
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase } from '../db/init.js';
import { computeFileHash } from '../services/globalResourceService.js';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import {
  books,
  globalBooks,
  userBookRefs,
  ttsCache,
  ttsGlobalResources,
  ttsRefs,
} from '../db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

async function migrate() {
  console.log('📦 开始全局引用系统迁移...\n');

  const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'ireader.db');
  const db = initDatabase(dbPath);

  // ── Step 1: 迁移书籍 ──
  console.log('📚 Step 1: 书籍去重合并...');
  
  const allBooks = db.select().from(books).all() as any[];
  console.log(`   共发现 ${allBooks.length} 本书籍记录`);

  // 按 fileHash 分组
  const hashGroups = new Map<string, any[]>();
  
  for (const book of allBooks) {
    let hash = book.fileHash;
    if (!hash && book.filePath && fs.existsSync(book.filePath)) {
      try {
        hash = await computeFileHash(book.filePath);
        db.update(books).set({ fileHash: hash } as any).where(sql`id = ${book.id}`).run();
        console.log(`   ✅ 为书籍 "${book.title}" (${book.id}) 计算了 fileHash`);
      } catch (err) {
        console.error(`   ❌ 无法计算书籍 "${book.title}" (${book.id}) 的 fileHash:`, (err as Error).message);
        continue;
      }
    }
    if (!hash) {
      console.warn(`   ⚠️ 书籍 "${book.title}" (${book.id}) 无 fileHash，跳过`);
      continue;
    }

    if (!hashGroups.has(hash)) {
      hashGroups.set(hash, []);
    }
    hashGroups.get(hash)!.push(book);
  }

  let globalCreated = 0;
  let refsCreated = 0;
  let duplicatesFound = 0;

  for (const [hash, booksWithHash] of hashGroups) {
    if (booksWithHash.length === 0) continue;

    // 以第一本书为模板创建全局书籍记录
    const first = booksWithHash[0];
    
    const existingGlobal = db.select().from(globalBooks).where(sql`file_hash = ${hash}`).get();
    let globalId: string;

    if (existingGlobal) {
      globalId = (existingGlobal as any).id;
      console.log(`   🔄 全局书库已有 fileHash=${hash.substring(0, 12)}...，复用`);
      duplicatesFound++;
    } else {
      globalId = uuidv4();
      const now = new Date().toISOString();
      
      db.insert(globalBooks).values({
        id: globalId,
        fileHash: hash,
        title: first.title,
        author: first.author,
        format: first.format,
        filePath: first.filePath,
        coverPath: first.coverPath,
        size: first.size,
        createdAt: now,
        deletedAt: null,
      }).run();
      globalCreated++;
    }

    // 为每个用户创建引用
    for (const book of booksWithHash) {
      const ref = db.select().from(userBookRefs).where(
        sql`user_id = ${book.userId} AND local_book_id = ${book.id}`
      ).get();
      if (!ref) {
        const now = new Date().toISOString();
        db.insert(userBookRefs).values({
          id: uuidv4(),
          userId: book.userId,
          globalBookId: globalId,
          localBookId: book.id,
          refCount: 1,
          deletedAt: null,
          createdAt: now,
        }).run();
        refsCreated++;
      }
    }
  }

  console.log(`   ✅ 创建 ${globalCreated} 条全局书籍记录，${refsCreated} 条引用记录，${duplicatesFound} 处重复去重`);

  // ── Step 2: 迁移 TTS 缓存 ──
  console.log('\n🎵 Step 2: TTS 缓存去重合并...');

  const allTtsCache = db.select().from(ttsCache).all() as any[];
  console.log(`   共发现 ${allTtsCache.length} 条 TTS 缓存记录`);

  const ttsKeyMap = new Map<string, { group: any[]; globalId: string | null }>();
  let ttsGlobalCreated = 0;
  let ttsRefsCreated = 0;

  for (const entry of allTtsCache) {
    // 需要 bookId 才能关联到全局书籍
    if (!entry.bookId) continue;

    // 找到该 bookId 对应的全局书籍 ID
    const localBook = db.select().from(books).where(sql`id = ${entry.bookId}`).get() as any;
    if (!localBook) continue;

    const userRef = db.select().from(userBookRefs).where(
      sql`local_book_id = ${entry.bookId}`
    ).get() as any;
    if (!userRef) continue;

    const globalBookId = userRef.globalBookId;
    const ttsKey = `${entry.textHash}|${entry.voice}|${entry.speed}|${globalBookId}`;

    if (!ttsKeyMap.has(ttsKey)) {
      ttsKeyMap.set(ttsKey, { group: [], globalId: null });
    }
    ttsKeyMap.get(ttsKey)!.group.push(entry);
  }

  for (const [key, { group, globalId: _existingGlobalId }] of ttsKeyMap) {
    if (group.length === 0) continue;
    const first = group[0];
    
    // 找到 globalBookId
    const userRefFirst = db.select().from(userBookRefs).where(
      sql`local_book_id = ${first.bookId}`
    ).get() as any;
    if (!userRefFirst) continue;

    // 检查全局资源是否已存在
    const existingGlobalRes = db.select().from(ttsGlobalResources).where(
      sql`text_hash = ${first.textHash} AND voice = ${first.voice} AND speed = ${first.speed} AND book_id = ${userRefFirst.globalBookId} AND deleted_at IS NULL`
    ).get();

    let globalResId: string;

    if (existingGlobalRes) {
      globalResId = (existingGlobalRes as any).id;
    } else {
      globalResId = uuidv4();
      const now = new Date().toISOString();
      
      db.insert(ttsGlobalResources).values({
        id: globalResId,
        bookId: userRefFirst.globalBookId,
        chapterId: first.chapterId,
        textHash: first.textHash,
        voice: first.voice,
        speed: first.speed,
        audioPath: first.audioPath,
        fileSize: fs.existsSync(first.audioPath) ? fs.statSync(first.audioPath).size : null,
        createdAt: now,
        deletedAt: null,
      }).run();
      ttsGlobalCreated++;
    }

    // 为每个用户创建引用
    for (const entry of group) {
      const user = db.select().from(books).where(sql`id = ${entry.bookId}`).get() as any;
      if (!user) continue;

      const refExists = db.select().from(ttsRefs).where(
        sql`user_id = ${user.userId} AND global_resource_id = ${globalResId} AND deleted_at IS NULL`
      ).get();

      if (!refExists) {
        const now = new Date().toISOString();
        db.insert(ttsRefs).values({
          id: uuidv4(),
          userId: user.userId,
          globalResourceId: globalResId,
          localCacheId: entry.id,
          refCount: 1,
          deletedAt: null,
          createdAt: now,
        }).run();
        ttsRefsCreated++;
      }
    }
  }

  console.log(`   ✅ 创建 ${ttsGlobalCreated} 条全局 TTS 资源记录，${ttsRefsCreated} 条 TTS 引用记录`);

  console.log('\n📊 迁移统计:');
  console.log(`   - 全局书籍: ${globalCreated} (复用 ${duplicatesFound})`);
  console.log(`   - 用户引用: ${refsCreated}`);
  console.log(`   - 全局 TTS: ${ttsGlobalCreated}`);
  console.log(`   - TTS 引用: ${ttsRefsCreated}`);
  console.log('\n✅ 迁移完成！');
}

migrate().catch(err => {
  console.error('\n❌ 迁移失败:', err);
  process.exit(1);
});
