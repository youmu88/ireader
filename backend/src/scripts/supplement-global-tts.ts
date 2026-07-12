/**
 * 补录游离 TTS 音频到全局资源 v2
 * 
 * 目标：补录 youmu88 百妖谱已完成但未入库的 TTS 音频。
 * 
 * 背景：youmu88 百妖谱的 TTS job（ed47f109）在 v2.0.1 全局资源架构部署
 * 之前完成（7/6），合成代码当时没有全局资源写入逻辑。
 * 磁盘上 7/3~7/6 期间的文件由这个 job 产生。
 * 
 * 策略：
 * 1. 只处理 7/3~7/6 期间创建的、未被 tts_global_resources 记录的文件
 * 2. 补录到 youmu88 百妖谱的全局 resource（voice=zh-CN-XiaoxiaoNeural, speed=1.0）
 * 3. 创建 tts_refs 引用（youmu88 → 全局资源）
 * 
 * 运行方式: cd /home/ubuntu/code/ireader && npx tsx backend/src/scripts/supplement-global-tts.ts
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { initDatabase } from '../db/init.js';
import { v4 as uuidv4 } from 'uuid';
import { sql } from 'drizzle-orm';
import {
  ttsCache,
  ttsGlobalResources,
  ttsRefs,
} from '../db/schema.js';

const DB_PATH = process.env.DB_PATH || path.join(process.env.HOME || '/home/ubuntu', '.ireader/data/ireader.sqlite');
const DATA_DIR = path.dirname(DB_PATH);
const db = initDatabase(DB_PATH);

const TTS_CACHE_DIR = process.env.TTS_CACHE_DIR || path.join(DATA_DIR, 'tts-cache');

// youmu88 百妖谱的已知信息
const YOUMU88_ID = '217a5172-a73e-4e9e-b58d-6e186464b118';
const YOUMU88_LOCAL_BOOK_ID = 'de7ffc7b-31d5-474a-b4e2-781e52f941d0';
const YOUMU88_GLOBAL_BOOK_ID = '7ba1fba9-207f-4f01-943e-e9660d7c2946';
const VOICE = 'zh-CN-XiaoxiaoNeural';
const SPEED = 1.0;

// 时间范围：youmu88 百妖谱 job 活跃期（7/3 ~ 7/6）
// job 7/6 00:40 创建，7/6 11:24 完成，但文件从 7/3 开始产生
const JOB_START_MS = new Date('2026-07-03T00:00:00Z').getTime();
const JOB_END_MS = new Date('2026-07-06T23:59:59Z').getTime();

async function supplementGlobalTts() {
  console.log('🔄 补录游离 TTS 音频到全局资源...\n');

  // ===== Step 1: 收集已记录的 text_hash =====
  console.log('📋 Step 1: 收集已记录的 text_hash...');
  const recordedHashes = new Set<string>();
  for (const r of db.select({ textHash: ttsGlobalResources.textHash }).from(ttsGlobalResources).all()) {
    recordedHashes.add(r.textHash);
  }
  for (const c of db.select({ textHash: ttsCache.textHash }).from(ttsCache).all()) {
    recordedHashes.add(c.textHash);
  }
  console.log(`   ✅ ${recordedHashes.size} 个 text_hash 已有记录`);

  // ===== Step 2: 扫描磁盘文件 =====
  console.log('\n📋 Step 2: 扫描磁盘文件...');
  if (!fs.existsSync(TTS_CACHE_DIR)) {
    console.log('   ❌ tts-cache 目录不存在');
    return;
  }

  const allFiles = fs.readdirSync(TTS_CACHE_DIR).filter(f => f.endsWith('.wav'));
  console.log(`   📊 磁盘上共有 ${allFiles.length} 个 wav 文件`);

  // ===== Step 3: 筛选游离文件（未被记录 + 在 7/3~7/6 时间段） =====
  console.log('\n📋 Step 3: 筛选游离文件...');
  const unrecordedFiles: { name: string; hash: string; path: string; mtime: number; size: number }[] = [];

  for (const file of allFiles) {
    const textHash = file.replace(/\.wav$/, '');
    if (recordedHashes.has(textHash)) continue;

    const filePath = path.join(TTS_CACHE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const mtime = stat.mtimeMs;

      // 只处理 7/3~7/6 的 youmu88 百妖谱文件
      if (mtime >= JOB_START_MS && mtime <= JOB_END_MS) {
        unrecordedFiles.push({
          name: file,
          hash: textHash,
          path: filePath,
          mtime,
          size: stat.size,
        });
      }
    } catch {
      // 文件可能已被删除
    }
  }

  // ===== Step 4: 补录到全局资源 =====
  console.log('\n📋 Step 4: 补录到全局资源...');
  if (unrecordedFiles.length === 0) {
    console.log('   ✅ 没有需要补录的文件');
    return;
  }

  console.log(`   📊 需要补录 ${unrecordedFiles.length} 个文件`);

  // 统计时间分布
  const dateCounts: Record<string, number> = {};
  for (const f of unrecordedFiles) {
    const date = new Date(f.mtime).toISOString().split('T')[0];
    dateCounts[date] = (dateCounts[date] || 0) + 1;
  }
  console.log('   按日期分布:');
  for (const [date, count] of Object.entries(dateCounts).sort()) {
    console.log(`     ${date}: ${count}个`);
  }

  let supplemented = 0;
  let errors = 0;
  const now = new Date().toISOString();

  // 批量写入（每 500 条事务）
  for (let i = 0; i < unrecordedFiles.length; i += BATCH_SIZE) {
    const batch = unrecordedFiles.slice(i, i + BATCH_SIZE);
    
    try {
      db.run(sql`BEGIN TRANSACTION`);

      for (const file of batch) {
        const resourceId = uuidv4();
        try {
          db.insert(ttsGlobalResources).values({
            id: resourceId,
            bookId: YOUMU88_GLOBAL_BOOK_ID,
            chapterId: null,
            textHash: file.hash,
            voice: VOICE,
            speed: SPEED,
            audioPath: file.path,
            fileSize: file.size,
            createdAt: now,
            deletedAt: null,
          }).run();

          db.insert(ttsRefs).values({
            id: uuidv4(),
            userId: YOUMU88_ID,
            globalResourceId: resourceId,
            localCacheId: null,
            bookId: YOUMU88_LOCAL_BOOK_ID,
            refCount: 1,
            deletedAt: null,
            createdAt: now,
          }).run();

          supplemented++;
        } catch (err) {
          errors++;
        }
      }

      db.run(sql`COMMIT`);
      console.log(`   ✅ 已补录 ${supplemented} / ${unrecordedFiles.length} 条...`);
    } catch (err) {
      try { db.run(sql`ROLLBACK`); } catch {}
      console.error(`   ❌ 批量写入出错:`, err);
      errors += batch.length;
    }
  }

  // ===== 结果统计 =====
  console.log('\n📊 补录统计:');
  console.log(`   - 总游离文件: ${unrecordedFiles.length}`);
  console.log(`   - 已补录: ${supplemented}`);
  console.log(`   - 错误: ${errors}`);

  // 确认写入
  const totalGlobal = db.select({ count: sql`COUNT(*)` }).from(ttsGlobalResources)
    .where(sql`book_id = ${YOUMU88_GLOBAL_BOOK_ID}`).get() as any;
  console.log(`   - 补录后全局资源数: ${totalGlobal?.count || 0}`);

  console.log('\n✅ 补录完成！');
}

// 批处理大小
const BATCH_SIZE = 500;

supplementGlobalTts().catch(err => {
  console.error('\n❌ 补录失败:', err);
  process.exit(1);
});
