/**
 * 一次性迁移脚本：批量回填遗留书籍的 normalizedText / contentHash
 *
 * 背景：Phase 2（v2.24.0）之前上传的书籍，book_chapters 行的 normalized_text / content_hash
 * 为 NULL，导致每次 TTS 预合成 / 内容缓存都触发文件 IO 兜底路径（读 EPUB 解压目录或 TXT 原文）。
 * 本脚本一次性回填，消除运行时兜底开销。
 *
 * 运行方式: tsx src/scripts/backfill-normalized-text.ts [--dry-run]
 *
 * 逻辑：
 * 1. 查询所有 status='ready' 且存在 normalized_text IS NULL 章节的书籍
 * 2. 对每本书调用 parseBook 重新解析，产出 ChapterManifest[]
 * 3. 按 order 字段匹配已有章节行，UPDATE 写入 normalizedText + contentHash
 * 4. 输出统计报告
 *
 * 幂等性：已有 normalizedText 的章节不会被覆盖（WHERE normalized_text IS NULL）。
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { initDatabase } from '../db/init.js';
import { books, bookChapters } from '../db/schema.js';
import { parseBook } from '../parser/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 与 index.ts 保持一致：展开 ~ 为 $HOME，数据库文件名 ireader.sqlite
const RAW_DATA_DIR = process.env.DATA_DIR || path.join(process.env.HOME || process.cwd(), '.ireader', 'data');
const DATA_DIR = RAW_DATA_DIR.startsWith('~/') ? path.join(process.env.HOME || '', RAW_DATA_DIR.slice(2)) : RAW_DATA_DIR;
const DRY_RUN = process.argv.includes('--dry-run');

interface BookStats {
  bookId: string;
  title: string;
  format: string;
  totalChapters: number;
  nullChapters: number;
  updated: number;
  skipped: number;
  error?: string;
}

async function backfill() {
  if (DRY_RUN) console.log('🔍 [DRY RUN] 预览模式，不会写入数据库\n');
  console.log('📖 开始回填 normalizedText / contentHash...\n');

  const dbPath = process.env.DB_PATH || path.join(DATA_DIR, 'ireader.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`❌ 数据库文件不存在: ${dbPath}`);
    process.exit(1);
  }

  const db = initDatabase(dbPath);

  // ── Step 1: 找出所有含 NULL normalizedText 章节的书籍 ──
  const booksWithNull = db.select({
    id: books.id,
    title: books.title,
    format: books.format,
    filePath: books.filePath,
    nullCount: sql<number>`count(*)`.as('null_count'),
  })
    .from(books)
    .innerJoin(bookChapters, sql`${bookChapters.bookId} = ${books.id}`)
    .where(sql`${books.status} = 'ready' AND ${bookChapters.normalizedText} IS NULL`)
    .groupBy(books.id)
    .all() as any[];

  if (booksWithNull.length === 0) {
    console.log('✅ 所有书籍章节均已有 normalizedText，无需迁移。');
    return;
  }

  console.log(`📚 发现 ${booksWithNull.length} 本书籍含 NULL 章节，开始处理...\n`);

  const stats: BookStats[] = [];
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  // ── Step 2: 逐书处理 ──
  for (const book of booksWithNull) {
    const stat: BookStats = {
      bookId: book.id,
      title: book.title,
      format: book.format,
      totalChapters: 0,
      nullChapters: book.nullCount,
      updated: 0,
      skipped: 0,
    };

    // 检查源文件是否存在
    if (!book.filePath || !fs.existsSync(book.filePath)) {
      stat.error = `源文件不存在: ${book.filePath}`;
      totalErrors++;
      stats.push(stat);
      console.log(`   ❌ [${book.title}] ${stat.error}`);
      continue;
    }

    try {
      // 使用书籍文件所在目录作为 outputDir（EPUB 解压目录已存在）
      const outputDir = path.dirname(book.filePath);
      const manifest = await parseBook(book.filePath, book.format as 'epub' | 'txt', outputDir);

      // 获取该书所有 NULL 章节
      const nullChapters = db.select().from(bookChapters)
        .where(sql`book_id = ${book.id} AND normalized_text IS NULL`)
        .orderBy(bookChapters.order)
        .all() as any[];

      stat.totalChapters = nullChapters.length;

      // 按 order 建立索引
      const manifestByOrder = new Map<number, typeof manifest.chapters[number]>();
      for (const ch of manifest.chapters) {
        manifestByOrder.set(ch.order, ch);
      }

      for (const chapter of nullChapters) {
        const matched = manifestByOrder.get(chapter.order);

        if (!matched || !matched.normalizedText) {
          stat.skipped++;
          totalSkipped++;
          continue;
        }

        if (!DRY_RUN) {
          db.update(bookChapters)
            .set({
              normalizedText: matched.normalizedText,
              contentHash: matched.contentHash,
            } as any)
            .where(sql`id = ${chapter.id} AND normalized_text IS NULL`)
            .run();
        }

        stat.updated++;
        totalUpdated++;
      }

      const icon = stat.skipped > 0 ? '⚠️' : '✅';
      console.log(`   ${icon} [${book.title}] ${stat.updated}/${stat.nullChapters} 章节已回填${stat.skipped > 0 ? `，${stat.skipped} 章无法匹配` : ''}`);
    } catch (err) {
      stat.error = (err as Error).message;
      totalErrors++;
      console.log(`   ❌ [${book.title}] 解析失败: ${stat.error}`);
    }

    stats.push(stat);
  }

  // ── Step 3: 统计报告 ──
  console.log('\n' + '═'.repeat(50));
  console.log('📊 迁移统计报告');
  console.log('═'.repeat(50));
  console.log(`   书籍总数:     ${booksWithNull.length}`);
  console.log(`   章节已回填:   ${totalUpdated}`);
  console.log(`   章节跳过:     ${totalSkipped} (无法匹配或无文本)`);
  console.log(`   书籍失败:     ${totalErrors}`);
  if (DRY_RUN) {
    console.log('\n   ⚠️  DRY RUN 模式，未实际写入。去掉 --dry-run 参数执行正式迁移。');
  }
  console.log('═'.repeat(50));

  if (totalErrors > 0) {
    console.log('\n❌ 失败详情:');
    for (const s of stats.filter(s => s.error)) {
      console.log(`   - [${s.title}] (${s.bookId}): ${s.error}`);
    }
  }

  console.log('\n✅ 迁移完成！');
}

backfill().catch(err => {
  console.error('\n❌ 迁移脚本异常:', err);
  process.exit(1);
});
