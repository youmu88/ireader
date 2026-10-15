import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { contentSegments } from '../db/schema.js';

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

export function splitSpeechText(text: string, maxLength = 200): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!normalized) return [];
  const sentences = normalized.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [normalized];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > maxLength) {
      const boundary = rest.slice(0, maxLength + 1).search(/[，；,;、 ](?=[^，；,;、 ]+$)/);
      const cut = boundary > Math.floor(maxLength * 0.6) ? boundary + 1 : maxLength;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (!rest) continue;
    if (current && current.length + rest.length > maxLength) {
      chunks.push(current.trim());
      current = rest;
    } else {
      current += rest;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function ensureChapterSegments(
  db: any,
  bookId: string,
  chapter: any,
  chunkSize = 200,
): ContentSegment[] {
  const existing = db.select().from(contentSegments)
    .where(sql`chapter_id = ${chapter.id}`)
    .orderBy(contentSegments.segmentIndex)
    .all() as ContentSegment[];
  const text = String(chapter.normalizedText || '').trim();
  // D15：分片大小由设置接线（normalChunkMaxSize），不再硬编码 200
  const chunks = splitSpeechText(text, chunkSize);
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
  opts?: { firstChunkMaxSize?: number; normalChunkMaxSize?: number },
): ContentSegment[] {
  // D15：接线设置旋钮——首个分片用 firstChunkMaxSize（快速出声），其余用 normalChunkMaxSize
  const first = opts?.firstChunkMaxSize ?? 200;
  const normal = opts?.normalChunkMaxSize ?? 200;
  return chapters.map((chapter, i) =>
    ensureChapterSegments(db, bookId, chapter, i === 0 ? first : normal),
  ).flat();
}
