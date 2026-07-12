/**
 * TTS 全局资源补录 + 语音合成进度刷新脚本
 * 
 * 使用 better-sqlite3 原生 API，完全避免 drizzle ORM 的 sql 模板标签问题
 * 
 * 运行方式: DATA_DIR=/home/ubuntu/.ireader/data DB_PATH=/home/ubuntu/.ireader/data/ireader.sqlite npx tsx src/scripts/refresh-tts-progress.ts
 */

import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), '../../data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'ireader.sqlite');

console.log(`📦 数据库: ${DB_PATH}`);
console.log(`📁 数据目录: ${DATA_DIR}`);

// 直接使用 better-sqlite3 原生 API
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ===== Step 1: 补录 tts_cache 中的存量资源到全局 =====
console.log('\n📀 Step 1: 补录存量 TTS 缓存到全局资源...');

const allTtsCache = db.prepare('SELECT * FROM tts_cache').all() as any[];
console.log(`   共发现 ${allTtsCache.length} 条 TTS 缓存记录`);

let createdGlobal = 0;
let createdRef = 0;
let skipped = 0;

for (const cache of allTtsCache) {
  const textHash = cache.textHash || crypto.createHash('md5').update(`${cache.voice}|${cache.speed}|${cache.input || ''}`).digest('hex');
  const voice = cache.voice || 'zh-CN-XiaoxiaoNeural';
  const speed = cache.speed || 1.0;

  // localBookId → globalBookId 映射
  let globalBookId: string | null = cache.bookId;
  if (cache.bookId) {
    const refRows = db.prepare(
      'SELECT global_book_id FROM user_book_refs WHERE local_book_id = ? AND deleted_at IS NULL LIMIT 1'
    ).all(cache.bookId) as any[];
    if (refRows.length > 0 && refRows[0].global_book_id) {
      globalBookId = refRows[0].global_book_id;
    }
  }

  if (!globalBookId) {
    console.log(`   ⚠️ 无法确定 globalBookId for cache ${cache.id.substring(0, 8)}，跳过`);
    skipped++;
    continue;
  }

  // 检查全局是否已有
  const existingRows = db.prepare(
    'SELECT id FROM tts_global_resources WHERE text_hash = ? AND voice = ? AND speed = ? AND book_id = ? AND deleted_at IS NULL LIMIT 1'
  ).all(textHash, voice, speed, globalBookId) as any[];

  if (existingRows.length > 0) {
    skipped++;
    const existingId = existingRows[0].id;
    // 确保用户有引用
    const refRows = db.prepare(
      'SELECT id FROM tts_refs WHERE user_id = ? AND global_resource_id = ? LIMIT 1'
    ).all(cache.userId, existingId) as any[];
    if (refRows.length === 0) {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO tts_refs (id, user_id, global_resource_id, local_cache_id, book_id, ref_count, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)'
      ).run(crypto.randomUUID(), cache.userId, existingId, cache.id, cache.bookId, now);
      createdRef++;
      console.log(`   📎 为用户 ${cache.userId.substring(0, 8)} 创建 TTS 引用（全局资源已存在）`);
    }
    continue;
  }

  // 创建全局资源
  const globalAudioDir = path.join(DATA_DIR, 'tts-global');
  if (!fs.existsSync(globalAudioDir)) fs.mkdirSync(globalAudioDir, { recursive: true });
  const globalAudioPath = path.join(globalAudioDir, `${textHash}.wav`);

  // 如果全局音频文件不存在，从缓存目录复制
  if (!fs.existsSync(globalAudioPath) && cache.audioPath && fs.existsSync(cache.audioPath)) {
    fs.copyFileSync(cache.audioPath, globalAudioPath);
    console.log(`   📋 复制音频: ${path.basename(cache.audioPath)} → tts-global/`);
  }

  const fileSize = fs.existsSync(globalAudioPath) ? fs.statSync(globalAudioPath).size : null;
  const newResId = crypto.randomUUID();
  const now = new Date().toISOString();
  const chapterId = cache.chapterId || null;

  db.prepare(
    'INSERT INTO tts_global_resources (id, book_id, chapter_id, text_hash, voice, speed, audio_path, file_size, ref_count, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)'
  ).run(newResId, globalBookId, chapterId, textHash, voice, speed, globalAudioPath, fileSize, now);

  // 创建引用
  db.prepare(
    'INSERT INTO tts_refs (id, user_id, global_resource_id, local_cache_id, book_id, ref_count, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)'
  ).run(crypto.randomUUID(), cache.userId, newResId, cache.id, cache.bookId, now);

  createdGlobal++;
  createdRef++;
  console.log(`   ✅ 新增全局资源: ${textHash.substring(0, 12)} (voice=${voice}, book=${globalBookId.substring(0, 8)})`);
}

console.log(`\n   ✅ 补录完成：新增 ${createdGlobal} 全局资源，${createdRef} 引用，${skipped} 条已跳过`);

// ===== Step 2: 刷新所有书籍的语音合成进度 =====
console.log('\n📊 Step 2: 刷新书籍语音合成进度...');

const allBooks = db.prepare('SELECT id, user_id, title FROM books').all() as any[];
console.log(`   共 ${allBooks.length} 本书`);

let updatedJobs = 0;
let createdJobs = 0;
let cleanedJobs = 0;

for (const book of allBooks) {
  // 通过 user_book_refs 映射该书的 global_book_id
  const refRows = db.prepare(
    'SELECT global_book_id FROM user_book_refs WHERE local_book_id = ? AND deleted_at IS NULL LIMIT 1'
  ).all(book.id) as any[];
  const globalBookId2 = refRows.length > 0 ? refRows[0].global_book_id : null;

  // 这本书在全局 TTS 资源中的段数
  let globalCount = 0;
  if (globalBookId2) {
    const rows = db.prepare(
      'SELECT COUNT(*) as cnt FROM tts_global_resources WHERE book_id = ? AND deleted_at IS NULL'
    ).all(globalBookId2) as any[];
    globalCount = rows.length > 0 ? rows[0].cnt : 0;
  }

  // 这本书在本地 tts_cache 中的段数
  const localRows = db.prepare(
    'SELECT COUNT(*) as cnt FROM tts_cache WHERE book_id = ? AND user_id = ?'
  ).all(book.id, book.userId) as any[];
  const localCount = localRows.length > 0 ? localRows[0].cnt : 0;

  // 总章节数
  const chRows = db.prepare(
    'SELECT COUNT(*) as cnt FROM book_chapters WHERE book_id = ?'
  ).all(book.id) as any[];
  const chapterCount = chRows.length > 0 ? chRows[0].cnt : 0;

  // 实际已合成的段数
  const totalCompleted = Math.max(globalCount, localCount);
  const estimatedTotalChunks = Math.max(1, chapterCount, totalCompleted);

  // 查找这本书已有生成任务
  const jobs = db.prepare(
    'SELECT id, status, progress, total_chunks, completed_chunks, voice, speed FROM tts_generation_jobs WHERE book_id = ? ORDER BY created_at DESC'
  ).all(book.id) as any[];

  if (jobs.length > 0) {
    const runningJobs = jobs.filter((j: any) => j.status === 'running' || j.status === 'pending');
    const completedJobs = jobs.filter((j: any) => j.status === 'completed');

    // 更新运行中的任务
    for (const job of runningJobs) {
      const newTotalChunks = Math.max(job.total_chunks || estimatedTotalChunks, totalCompleted);
      const newProgress = newTotalChunks > 0 ? Math.min(100, Math.round((totalCompleted / newTotalChunks) * 100)) : 0;
      const newStatus = totalCompleted > 0 && totalCompleted >= newTotalChunks ? 'completed' : 'running';

      db.prepare(
        'UPDATE tts_generation_jobs SET status = ?, progress = ?, completed_chunks = ?, total_chunks = ?, updated_at = ? WHERE id = ?'
      ).run(newStatus, newProgress, totalCompleted, newTotalChunks, new Date().toISOString(), job.id);
      updatedJobs++;
      console.log(`   📈 [${book.title.substring(0, 20)}] 更新进度: ${newProgress}% (${totalCompleted}/${newTotalChunks}) → ${newStatus}`);
    }

    // 清理分裂的任务
    if (completedJobs.length > 1) {
      const sorted = completedJobs.sort((a: any, b: any) => (b.completed_chunks || 0) - (a.completed_chunks || 0));
      const best = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        db.prepare(
          'UPDATE tts_generation_jobs SET status = \'cancelled\', updated_at = ? WHERE id = ?'
        ).run(new Date().toISOString(), sorted[i].id);
        cleanedJobs++;
        console.log(`   🗑️ [${book.title.substring(0, 20)}] 合并分裂: 保留 ${best.id.substring(0, 8)}，取消 ${sorted[i].id.substring(0, 8)}`);
      }
    }
  } else if (totalCompleted > 0) {
    // 有 TTS 资产但无生成任务 → 创建 completed 任务
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO tts_generation_jobs (id, book_id, user_id, status, progress, total_chunks, completed_chunks, voice, speed, created_at, updated_at) VALUES (?, ?, ?, \'completed\', 100, ?, ?, \'zh-CN-XiaoxiaoNeural\', 1.0, ?, ?)'
    ).run(crypto.randomUUID(), book.id, book.userId, estimatedTotalChunks, totalCompleted, now, now);
    createdJobs++;
    console.log(`   ➕ [${book.title.substring(0, 20)}] 新建完成状态任务 (${totalCompleted}/${estimatedTotalChunks})`);
  }
}

console.log(`\n   ✅ 进度刷新完成：更新 ${updatedJobs} 个任务，新建 ${createdJobs} 个任务，清理 ${cleanedJobs} 个重复任务`);

// ===== Step 3: 统计摘要 =====
console.log('\n📋 Step 3: 统计摘要');

function count(table: string, where?: string): number {
  const sql = where
    ? `SELECT COUNT(*) as cnt FROM ${table} WHERE ${where}`
    : `SELECT COUNT(*) as cnt FROM ${table}`;
  const rows = db.prepare(sql).all() as any[];
  return rows.length > 0 ? rows[0].cnt : 0;
}

console.log(`   📀 全局 TTS 资源: ${count('tts_global_resources')}`);
console.log(`   📎 TTS 引用记录: ${count('tts_refs')}`);
console.log(`   💾 TTS 缓存记录: ${count('tts_cache')}`);
console.log(`   🔄 运行中任务: ${count('tts_generation_jobs', "status IN ('running', 'pending')")}`);
console.log(`   ✅ 已完成任务: ${count('tts_generation_jobs', "status = 'completed'")}`);
console.log(`   🗑️ 已取消任务: ${count('tts_generation_jobs', "status = 'cancelled'")}`);
console.log('\n✅ 全部操作完成！');

db.close();
