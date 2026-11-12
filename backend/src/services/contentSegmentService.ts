import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { contentSegments } from '../db/schema.js';
import { DEFAULT_FIRST_CHUNK_MAX, DEFAULT_SECOND_CHUNK_MAX, DEFAULT_NORMAL_CHUNK_MAX } from './ttsConstants.js';

export interface ContentSegment {
  id: string;
  bookId: string;
  chapterId: string;
  segmentIndex: number;
  text: string;
  textHash: string;
  startOffset: number;
  endOffset: number;
  createdAt: string;
}

/** 小数占位符：切分/换行处理期间保护 3.14 的点不被当句末切断（处理后还原） */
const DECIMAL_PLACEHOLDER = '\u0001';

function guardDecimals(text: string): string {
  return text.replace(/(\d)\.(\d)/g, `$1${DECIMAL_PLACEHOLDER}$2`);
}

function restoreDecimals(text: string): string {
  return text.split(DECIMAL_PLACEHOLDER).join('.');
}

/** 次级标点降级切分：句内超长时在逗号/顿号/冒号/分号处断开；无标点极端长段才硬切兜底 */
function splitLongSentence(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const boundary = rest.slice(0, max + 1).search(/[，、：；,;:](?=[^，、：；,;:]*$)/);
    const cut = boundary > Math.floor(max * 0.6) ? boundary + 1 : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter(Boolean);
}

/** 切分档位：段0=章名小档（快速出声）、段1=二档小段（章名播完后紧接秒出）、段2+=大段（减少碎片） */
export interface ChunkSizeOptions {
  firstChunkMaxSize?: number;
  secondChunkMaxSize?: number;
  normalChunkMaxSize?: number;
}

/**
 * 按句末标点切分朗读文本（ai-agent 移植版，三档）
 * - 段0：≤firstMax（章名/首句快速出声）
 * - 段1：≤secondMax（章名播完后紧接的第二段也快速出声，给大段争取合成时间）
 * - 段2+：≤normalMax（减少碎片）
 * - 小数保护：3.14 的点不当句末（占位符绕过，切后还原）
 * - 句末集：。！？；…!?.（含英文句号与分号）
 * - 超长句降级：次级标点（，、：；）处断开，无标点才硬切
 */
export function splitSpeechText(text: string, opts?: ChunkSizeOptions): string[] {
  const firstMax = Math.max(1, opts?.firstChunkMaxSize ?? DEFAULT_FIRST_CHUNK_MAX);
  const secondMax = Math.max(1, opts?.secondChunkMaxSize ?? DEFAULT_SECOND_CHUNK_MAX);
  const normalMax = Math.max(1, opts?.normalChunkMaxSize ?? DEFAULT_NORMAL_CHUNK_MAX);

  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [];
  const guarded = guardDecimals(normalized);

  // 1) 句子片：句末标点切句 → 超长句降级切，每片 ≤ normalMax
  const sentences = guarded.match(/[^。！？；…!?.\n]+[。！？；…!?.]?/g) || [guarded];
  const pieces: string[] = [];
  for (const sentence of sentences) {
    const seg = sentence.trim();
    if (seg) pieces.push(...splitLongSentence(seg, normalMax));
  }
  if (pieces.length === 0) return [];

  const chunks: string[] = [];
  const queue = pieces.slice();
  // 2) 段0 装配（≤firstMax）：首片超限在次级标点处截头（避免切词）
  const p0 = queue[0];
  if (p0.length > firstMax) {
    const head = p0.slice(0, firstMax);
    const rest = p0.slice(firstMax);
    const bm = /[，、：；,;:](?=[^，、：；,;:]*$)/.exec(head);
    if (bm && bm.index >= Math.floor(firstMax * 0.6)) {
      chunks.push(restoreDecimals(head.slice(0, bm.index + 1).trim()));
      queue.splice(1, 0, head.slice(bm.index + 1) + rest);
    } else {
      chunks.push(restoreDecimals(head.trim()));
      queue.splice(1, 0, rest);
    }
  } else {
    chunks.push(restoreDecimals(p0.trim()));
  }

  // 3) 段1 装配（≤secondMax）：章名后的第二段也小档，同段0 算法
  if (queue.length > 1) {
    const p1 = queue[1];
    if (p1.length > secondMax) {
      const head = p1.slice(0, secondMax);
      const rest = p1.slice(secondMax);
      const bm = /[，、：；,;:](?=[^，、：；,;:]*$)/.exec(head);
      if (bm && bm.index >= Math.floor(secondMax * 0.6)) {
        chunks.push(restoreDecimals(head.slice(0, bm.index + 1).trim()));
        queue.splice(2, 0, head.slice(bm.index + 1) + rest);
      } else {
        chunks.push(restoreDecimals(head.trim()));
        queue.splice(2, 0, rest);
      }
    } else {
      chunks.push(restoreDecimals(p1.trim()));
    }
  }

  // 4) 段2+ 常规装配：句拼接不超 normalMax
  let current = '';
  for (const piece of queue.slice(2)) {
    if (current && current.length + piece.length > normalMax) {
      chunks.push(restoreDecimals(current.trim()));
      current = '';
    }
    current += piece;
  }
  if (current.trim()) chunks.push(restoreDecimals(current.trim()));
  return chunks;
}

/**
 * 句末补换行（ai-agent 移植，防截断）：本地引擎（Kokoro/omlx）对无换行长文本
 * 存在 ~130 字静默截断；句末标点后统一插 \n 让引擎按句分段合成。
 * 仅作用于发送给引擎的文本，不改存储的分段文本（高亮/缓存键不受影响）。
 */
export function ensureSentenceLineBreaks(text: string): string {
  const guarded = guardDecimals(text);
  const out = guarded
    .replace(/([。！？；…!?;.])[ \t]*\n?/g, '$1\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return restoreDecimals(out);
}

export function ensureChapterSegments(
  db: any,
  bookId: string,
  chapter: any,
  opts?: ChunkSizeOptions,
): ContentSegment[] {
  const existing = db.select().from(contentSegments)
    .where(sql`chapter_id = ${chapter.id}`)
    .orderBy(contentSegments.segmentIndex)
    .all() as ContentSegment[];
  const text = String(chapter.normalizedText || '').trim();
  // 分片档位：首段 firstChunkMaxSize（快速出声），其余 normalChunkMaxSize（ai-agent 移植）
  const chunks = splitSpeechText(text, opts);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  if (existing.length > 0 && existing.length === chunks.length && existing.every((s, i) => s.text === chunks[i])) return existing;

  db.delete(contentSegments).where(sql`chapter_id = ${chapter.id}`).run();
  const now = new Date().toISOString();
  let offset = 0;
  const result: ContentSegment[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const startOffset = text.indexOf(chunk, offset);
    const start = startOffset >= 0 ? startOffset : offset;
    const end = start + chunk.length;
    const segment: ContentSegment = {
      id: crypto.randomUUID(), bookId, chapterId: chapter.id, segmentIndex: index,
      text: chunk, textHash: crypto.createHash('sha256').update(`${hash}:${index}:${chunk}`).digest('hex'),
      startOffset: start, endOffset: end, createdAt: now,
    };
    db.insert(contentSegments).values(segment).run();
    result.push(segment);
    offset = end;
  }
  return result;
}

export function ensureBookSegments(
  db: any,
  bookId: string,
  chapters: any[],
  opts?: ChunkSizeOptions,
): ContentSegment[] {
  // 每章首段都用小档：用户可从任意章进入听书（findStartChapterIndex 按阅读位置），
  // 起始章首段小 → 任意章启动都 ≤1s 快速出声
  return chapters.map(chapter =>
    ensureChapterSegments(db, bookId, chapter, opts),
  ).flat();
}
