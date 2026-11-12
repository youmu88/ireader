/**
 * contentSegmentService 单测（ai-agent 移植）：
 * splitSpeechText：小数保护 / 句末切分 / 次级标点降级 / 硬切兜底 / 首段小档
 * ensureSentenceLineBreaks：句末换行防截断（omlx/Kokoro 对无换行长文本 ~130 字静默截断的绕过）
 * ensureChapterSegments / ensureBookSegments：每章首段小档 / 幂等 / 文本变化重建
 * 分片档位迁移：旧默认 32/128 → DEFAULT_FIRST_CHUNK_MAX/DEFAULT_NORMAL_CHUNK_MAX（用户自定义值不动）
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { initDatabase } from '../db/init.js';
import { users, books, bookChapters, ttsSettings } from '../db/schema.js';
import {
  splitSpeechText,
  ensureSentenceLineBreaks,
  ensureChapterSegments,
  ensureBookSegments,
} from './contentSegmentService.js';
import { DEFAULT_FIRST_CHUNK_MAX, DEFAULT_NORMAL_CHUNK_MAX } from './ttsConstants.js';

const tmpDbs: string[] = [];
const newDb = () => {
  const dbPath = path.join('/tmp', `ireader-seg-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  tmpDbs.push(dbPath);
  const db = initDatabase(dbPath);
  db.insert(users).values({
    id: 'u1', username: `seg-tester-${tmpDbs.length}`, email: 'seg@test.local',
    passwordHash: 'salt:hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  db.insert(books).values({
    id: 'b1', userId: 'u1', title: '测试书', format: 'txt', filePath: '/tmp/book.txt', size: 100,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
  return db;
};

afterEach(() => {
  for (const p of tmpDbs.splice(0)) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

describe('splitSpeechText', () => {
  it('小数保护：0.047 的点不当句末，句号正常切段', () => {
    const out = splitSpeechText('延迟只有 0.047 秒。合成正常。');
    expect(out).toEqual(['延迟只有 0.047 秒。', '合成正常。']);
  });

  it.each(['。', '！', '？', '；', '…', '!', '?', '.'])('句末标点 %s 成段界（超装配阈值时独立成段）', mark => {
    const text = '甲'.repeat(45) + mark + '乙'.repeat(45) + mark;
    const out = splitSpeechText(text, { firstChunkMaxSize: 1000, normalChunkMaxSize: 50 });
    // 46字/句 > 装配阈值一半：两句各自成段（不被合并），证明该标点被识别为段界
    expect(out).toEqual(['甲'.repeat(45) + mark, '乙'.repeat(45) + mark]);
  });

  it('短句装配合并：段0/段1 独立（三档），段2+ 拼接 ≤normalMax 减少碎片', () => {
    const out = splitSpeechText('一句。二句！三句？四句；五句…六句!七句?八句.完');
    expect(out[0]).toBe('一句。');
    expect(out[1]).toBe('二句！');
    expect(out.length).toBe(3); // 段0 + 段1（二档） + 剩余短句合并
    expect(out.join('')).toBe('一句。二句！三句？四句；五句…六句!七句?八句.完');
  });

  it('无句号长段在次级标点（逗号）降级切分，不丢字', () => {
    const text = 'A'.repeat(40) + '，' + 'B'.repeat(40) + '，' + 'C'.repeat(40);
    const out = splitSpeechText(text, { firstChunkMaxSize: 1000, normalChunkMaxSize: 50 });
    expect(out.length).toBe(3);
    for (const seg of out) expect(seg.length).toBeLessThanOrEqual(50);
    expect(out.join('')).toBe(text);
  });

  it('极端长段无标点才硬切兜底（120 字 / 50 → 50+50+20）', () => {
    const text = '字'.repeat(120);
    const out = splitSpeechText(text, { firstChunkMaxSize: 1000, normalChunkMaxSize: 50 });
    expect(out.map(s => s.length)).toEqual([50, 50, 20]);
    expect(out.join('')).toBe(text);
  });

  it('首段小档：默认 64/400，首段 ≤64、其余 ≤400（点开 ≤1s 快速出声）', () => {
    const text = '这是用于验证分片档位的句子。'.repeat(40);
    const out = splitSpeechText(text);
    expect(out[0].length).toBeLessThanOrEqual(DEFAULT_FIRST_CHUNK_MAX);
    for (const seg of out.slice(1)) {
      expect(seg.length).toBeLessThanOrEqual(DEFAULT_NORMAL_CHUNK_MAX);
    }
    expect(out.join('')).toBe(text);
  });

  it('空文本返回空数组', () => {
    expect(splitSpeechText('')).toEqual([]);
    expect(splitSpeechText('   ')).toEqual([]);
  });

  it('三档切分：段0=章名行、段1≤64（二档）、段2+≤400（听书空档优化）', () => {
    const title = '第一章 灰狐（1）';
    const body = '这是章首的内容句，用于验证三档切分的长度约束。'.repeat(30); // ~1380 字
    const out = splitSpeechText(`${title}\n${body}`);
    expect(out[0]).toBe(title); // \n 分隔，章名独立成段
    expect(out[1].length).toBeLessThanOrEqual(DEFAULT_FIRST_CHUNK_MAX); // 段1 ≤64
    for (const seg of out.slice(2)) {
      expect(seg.length).toBeLessThanOrEqual(DEFAULT_NORMAL_CHUNK_MAX); // 段2+ ≤400
    }
    expect(out.join('')).toBe(`${title}${body}`); // 无丢字
  });
});

describe('ensureSentenceLineBreaks（句末换行防截断）', () => {
  it('句末标点后统一插换行、吃掉标点后空白', () => {
    expect(ensureSentenceLineBreaks('你好。世界！ end? 尾；了'))
      .toBe('你好。\n世界！\nend?\n尾；\n了');
  });

  it('小数点的点不插换行', () => {
    expect(ensureSentenceLineBreaks('延迟 0.047 秒。下一步'))
      .toBe('延迟 0.047 秒。\n下一步');
  });

  it('连续换行折叠为单换行', () => {
    expect(ensureSentenceLineBreaks('一。\n\n\n二。')).toBe('一。\n二。');
  });
});

describe('ensureChapterSegments / ensureBookSegments', () => {
  it('每章首段都用小档：任意章进入听书都 ≤1s 快速出声', () => {
    const db = newDb();
    const long = '这一章的内容比较长，用于验证分片档位。'.repeat(40);
    const chapters = [
      { id: 'c1', bookId: 'b1', title: '一章', order: 0, normalizedText: long },
      { id: 'c2', bookId: 'b1', title: '二章', order: 1, normalizedText: long },
    ];
    for (const c of chapters) db.insert(bookChapters).values(c).run();
    const segs = ensureBookSegments(db, 'b1', chapters);
    const firstOf = (cid: string) => segs.find(s => s.chapterId === cid && s.segmentIndex === 0)!;
    expect(firstOf('c1').text.length).toBeLessThanOrEqual(DEFAULT_FIRST_CHUNK_MAX);
    expect(firstOf('c2').text.length).toBeLessThanOrEqual(DEFAULT_FIRST_CHUNK_MAX);
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(DEFAULT_NORMAL_CHUNK_MAX);
  });

  it('幂等：同文本重复调用复用已有段', () => {
    const db = newDb();
    const chapter = { id: 'c1', bookId: 'b1', title: '一章', order: 0, normalizedText: '甲句。乙句。丙句。' };
    db.insert(bookChapters).values(chapter).run();
    const first = ensureChapterSegments(db, 'b1', chapter);
    const second = ensureChapterSegments(db, 'b1', chapter);
    // 复用而非重建：段 id 不变（重建会重新 randomUUID）
    expect(second.map(s => s.id)).toEqual(first.map(s => s.id));
    expect(second.map(s => s.text)).toEqual(['甲句。', '乙句。', '丙句。']); // 三档：段0/段1 独立，段2 起合并
  });

  it('文本变化时重建分段', () => {
    const db = newDb();
    const base = { id: 'c1', bookId: 'b1', title: '一章', order: 0, normalizedText: '甲句。乙句。' };
    db.insert(bookChapters).values(base).run();
    ensureChapterSegments(db, 'b1', base);
    const changed = { ...base, normalizedText: '甲句。乙句。新增的句子。' };
    const rebuilt = ensureChapterSegments(db, 'b1', changed);
    // 三档：段0=甲句。段1=乙句。段2+=新增句
    expect(rebuilt.map(s => s.text)).toEqual(['甲句。', '乙句。', '新增的句子。']);
  });
});

describe('分片档位迁移（旧默认 32/128 → 新默认，用户自定义值不动）', () => {
  it('旧库 32/128 行在重跑 initDatabase 时升级', () => {
    const dbPath = path.join('/tmp', `ireader-seg-mig-${Date.now()}.sqlite`);
    tmpDbs.push(dbPath);
    const db = initDatabase(dbPath);
    db.insert(users).values({
      id: 'u1', username: 'mig-old-default', email: 'mig1@test.local',
      passwordHash: 'salt:hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    db.insert(ttsSettings).values({ userId: 'u1', firstChunkMaxSize: 32, normalChunkMaxSize: 128, updatedAt: new Date().toISOString() }).run();
    db.insert(users).values({
      id: 'u2', username: 'mig-custom', email: 'mig2@test.local',
      passwordHash: 'salt:hash', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    db.insert(ttsSettings).values({ userId: 'u2', firstChunkMaxSize: 50, normalChunkMaxSize: 300, updatedAt: new Date().toISOString() }).run();

    const db2 = initDatabase(dbPath); // 重入触发迁移
    const s1 = db2.select().from(ttsSettings).where(sql`user_id = 'u1'`).get() as any;
    const s2 = db2.select().from(ttsSettings).where(sql`user_id = 'u2'`).get() as any;
    expect(s1.firstChunkMaxSize).toBe(DEFAULT_FIRST_CHUNK_MAX); // 32 → 64
    expect(s1.normalChunkMaxSize).toBe(DEFAULT_NORMAL_CHUNK_MAX); // 128 → 400
    expect(s2.firstChunkMaxSize).toBe(50); // 用户自定义值不动
    expect(s2.normalChunkMaxSize).toBe(300);
  });
});
