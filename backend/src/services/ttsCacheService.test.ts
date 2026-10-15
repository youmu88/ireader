/**
 * TTS 缓存服务回归测试（Phase 2 / D3 + D14）
 *
 * D3 根因：drizzle-orm 0.29.5 链式 `.where()` 是赋值覆盖而非 AND 组合
 * （select.js:416 `this.config.where = where`），修复前带 userId 查询时
 * 文本/音色条件全部失效 → 任意文本命中该用户任意缓存音频（错音播放）、
 * batch-cache 跨书返回、clearAllCache 误删。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { initDatabase } from '../db/init.js';
import { ttsCache, users, books } from '../db/schema.js';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import {
  findCache,
  saveToCache,
  findCachedSegmentsByBook,
  clearAllCache,
  evictLegacyCacheKeys,
  generateCacheKey,
  computeApiUrlHash,
} from './ttsCacheService.js';

const DB_PATH = path.join('/tmp', `tts-cache-d3-test-${Date.now()}.sqlite`);
const DATA_DIR = path.join('/tmp', `tts-cache-d3-data-${Date.now()}`);
const db = initDatabase(DB_PATH);

// tts_cache.user_id/book_id 带外键约束：先建真实用户与书籍
const now = new Date().toISOString();
db.insert(users).values({
  id: 'user-1', username: 'cache-user-1', email: 'cache1@test.local',
  passwordHash: 'salt:hash', displayName: null, createdAt: now, updatedAt: now,
}).run();
db.insert(users).values({
  id: 'user-2', username: 'cache-user-2', email: 'cache2@test.local',
  passwordHash: 'salt:hash', displayName: null, createdAt: now, updatedAt: now,
}).run();
db.insert(users).values({
  id: 'user-legacy', username: 'cache-user-legacy', email: 'cache3@test.local',
  passwordHash: 'salt:hash', displayName: null, createdAt: now, updatedAt: now,
}).run();
for (const bid of ['book-1', 'book-2']) {
  db.insert(books).values({
    id: bid, userId: 'user-1', title: `测试书-${bid}`, author: null, format: 'txt',
    categoryId: null, filePath: `/tmp/${bid}.txt`, coverPath: null, fileHash: null,
    size: 1, status: 'ready', parseError: null, createdAt: now, updatedAt: now, pinned: 0,
  }).run();
}

describe('ttsCacheService（D3 缓存条件覆盖回归）', () => {
  it('D3：不同文本不得命中同一缓存音频（核心错音场景）', () => {
    saveToCache(db, DATA_DIR, '今天天气很好', 'alloy', 1.0, Buffer.from('audio-a'), 'wav', 'user-1', 'book-1', 'ch-1', 0);

    // 同参数命中
    const hit = findCache(db, '今天天气很好', 'alloy', 1.0, 'user-1');
    expect(hit).not.toBeNull();

    // 修复前：userId 条件覆盖文本条件 → 任意文本命中任意缓存（错音）
    const miss = findCache(db, '完全不同的另一段文本', 'alloy', 1.0, 'user-1');
    expect(miss).toBeNull();
  });

  it('D3：findCachedSegmentsByBook 不跨书返回', () => {
    const own = findCachedSegmentsByBook(db, 'book-1', 'alloy', 1.0, 'user-1');
    expect(own.length).toBe(1);
    expect(own[0].bookId).toBe('book-1');

    // 修复前：book 条件被 user 条件覆盖 → 返回该用户全部缓存
    const other = findCachedSegmentsByBook(db, 'book-other', 'alloy', 1.0, 'user-1');
    expect(other.length).toBe(0);
  });

  it('D3：用户隔离不破坏文本条件（条件完整 AND 组合）', () => {
    // 其他用户同文本同音色 → 不命中（用户隔离生效且不牺牲文本条件）
    const otherUser = findCache(db, '今天天气很好', 'alloy', 1.0, 'user-2');
    expect(otherUser).toBeNull();
    // 原用户仍命中
    expect(findCache(db, '今天天气很好', 'alloy', 1.0, 'user-1')).not.toBeNull();
  });

  it('D3：clearAllCache(userId) 只删该用户的缓存', () => {
    saveToCache(db, DATA_DIR, '第二本书的文本', 'alloy', 1.0, Buffer.from('audio-b'), 'wav', 'user-2', 'book-2', 'ch-2', 0);
    const deleted = clearAllCache(db, DATA_DIR, 'user-1');
    expect(deleted).toBe(1);
    // user-2 记录完好
    expect(findCache(db, '第二本书的文本', 'alloy', 1.0, 'user-2')).not.toBeNull();
    // user-1 已清空
    expect(findCache(db, '今天天气很好', 'alloy', 1.0, 'user-1')).toBeNull();
  });
});

describe('ttsCacheService（D14 缓存键身份维度）', () => {
  it('D14：不同 model 不得互相命中', () => {
    saveToCache(db, DATA_DIR, '模型对比文本', 'alloy', 1.0, Buffer.from('audio-m1'), 'wav', 'user-1', 'book-1', 'ch-1', 0, 'openai', 'tts-1');
    expect(findCache(db, '模型对比文本', 'alloy', 1.0, 'user-1', 'openai', 'tts-1')).not.toBeNull();
    // 换模型 → 不命中（修复前：键不含 model → 播放旧引擎音频）
    expect(findCache(db, '模型对比文本', 'alloy', 1.0, 'user-1', 'openai', 'tts-2')).toBeNull();
  });

  it('D14：不同 apiUrl 不得互相命中', () => {
    saveToCache(db, DATA_DIR, '地址对比文本', 'alloy', 1.0, Buffer.from('audio-u1'), 'wav', 'user-1', 'book-1', 'ch-1', 0, 'openai', 'tts-1', 'http://127.0.0.1:8883');
    expect(findCache(db, '地址对比文本', 'alloy', 1.0, 'user-1', 'openai', 'tts-1', 'http://127.0.0.1:8883')).not.toBeNull();
    expect(findCache(db, '地址对比文本', 'alloy', 1.0, 'user-1', 'openai', 'tts-1', 'http://192.168.1.5:8880')).toBeNull();
  });

  it('D14：generateCacheKey 带 v2_ 前缀且 apiUrlHash 参与键', () => {
    const k1 = generateCacheKey('x', 'alloy', 1.0, 'openai', 'm', computeApiUrlHash('http://a'));
    const k2 = generateCacheKey('x', 'alloy', 1.0, 'openai', 'm', computeApiUrlHash('http://b'));
    const k3 = generateCacheKey('x', 'alloy', 1.0, 'openai', 'm', '');
    expect(k1.startsWith('v2_')).toBe(true);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(computeApiUrlHash(undefined)).toBe('');
    expect(computeApiUrlHash(null)).toBe('');
  });

  it('D14：evictLegacyCacheKeys 清理旧键记录且保留 v2_ 新键', () => {
    // 手工插入旧格式记录（无 v2_ 前缀的纯 hash，模拟升级前数据）
    const legacyId = uuidv4();
    db.insert(ttsCache).values({
      id: legacyId,
      userId: 'user-legacy',
      bookId: null,
      chapterId: null,
      segmentIndex: null,
      source: 'openai',
      textHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
      voice: 'alloy',
      speed: 1.0,
      audioPath: path.join(DATA_DIR, 'deadbeef.wav'),
      createdAt: new Date().toISOString(),
    }).run();

    // 再插入一条新格式记录
    saveToCache(db, DATA_DIR, '新键文本', 'alloy', 1.0, Buffer.from('audio-new'), 'wav', 'user-legacy');

    const deleted = evictLegacyCacheKeys(db);
    expect(deleted).toBeGreaterThanOrEqual(1);
    // 旧键记录已删除
    const legacyGone = db.select().from(ttsCache).where(sql`id = ${legacyId}`).get();
    expect(legacyGone).toBeUndefined();
    // 新键记录保留
    expect(findCache(db, '新键文本', 'alloy', 1.0, 'user-legacy')).not.toBeNull();
  });
});
