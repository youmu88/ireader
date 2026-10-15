/**
 * TTS 播放层 API 封装（Phase 2 D2 重建）
 *
 * 数据源三层：
 *  - GET /api/tts/book/:bookId/segments?chapterId=   章节朗读分段（后端幂等生成）
 *  - GET /api/tts/batch-cache/:bookId                已预合成音频（textHash → audioUrl）
 *  - POST /api/tts                                   实时合成兜底（miss 时）
 *
 * 约定：source 统一 'openai'（跨链路口径统一，防缓存二分）；no_cache 读取设置页
 * 开关（localStorage: ireader_tts_noCache，与 SettingsPage NO_CACHE_KEY 对齐）。
 */
import { getToken } from '../../services/authService';

export const TTS_SOURCE = 'openai';

export interface TtsSegmentInfo {
  segmentIndex: number;
  text: string;
  textHash: string;
}

export interface CachedSegmentEntry {
  chapterId: string;
  segmentIndex: number;
  textHash: string;
  audioUrl: string;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 设置页「实时合成（不缓存）」开关（与 SettingsPage NO_CACHE_KEY 同源） */
export function getNoCachePref(): boolean {
  try {
    return localStorage.getItem('ireader_tts_noCache') === '1';
  } catch {
    return false;
  }
}

/** 拉取某章朗读分段（后端归属校验，非本人书籍 404） */
export async function fetchChapterSegments(bookId: string, chapterId: string): Promise<TtsSegmentInfo[]> {
  const res = await fetch(
    `/api/tts/book/${encodeURIComponent(bookId)}/segments?chapterId=${encodeURIComponent(chapterId)}`,
    { headers: authHeaders() },
  );
  if (!res.ok) throw new Error(`分段查询失败(${res.status})`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '分段查询失败');
  return (json.data || []) as TtsSegmentInfo[];
}

/** 批量拉取已预合成音频索引：textHash → audioUrl（全局资源 + 本地缓存合并产物） */
export async function fetchBatchCache(
  bookId: string,
  voice: string,
  speed: number,
): Promise<Map<string, string>> {
  const url = `/api/tts/batch-cache/${encodeURIComponent(bookId)}?voice=${encodeURIComponent(voice)}&speed=${speed}&source=${TTS_SOURCE}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`缓存索引查询失败(${res.status})`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '缓存索引查询失败');
  const map = new Map<string, string>();
  for (const seg of (json.data || []) as CachedSegmentEntry[]) {
    if (seg.textHash && seg.audioUrl) map.set(seg.textHash, seg.audioUrl);
  }
  return map;
}

/** 下载缓存音频（cache-file 需鉴权头） */
export async function fetchAudioBlob(audioUrl: string): Promise<Blob> {
  const res = await fetch(audioUrl, { headers: authHeaders() });
  if (!res.ok) throw new Error(`缓存音频下载失败(${res.status})`);
  return res.blob();
}

/** 实时合成兜底（段级）。noCache 时后端跳过缓存读写。 */
export async function synthesizeSegment(opts: {
  input: string;
  voice: string;
  speed: number;
  bookId?: string;
  chapterId?: string;
  noCache?: boolean;
}): Promise<Blob> {
  const res = await fetch('/api/tts/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({
      input: opts.input,
      voice: opts.voice,
      speed: opts.speed,
      source: TTS_SOURCE,
      book_id: opts.bookId,
      chapter_id: opts.chapterId,
      no_cache: opts.noCache || undefined,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text.slice(0, 120) || `合成失败(${res.status})`);
  }
  return res.blob();
}

/** 拉取后端章节表（归属校验后返回全部章节元数据） */
export interface BackendChapter {
  id: string;
  title: string;
  href: string | null;
}

export async function fetchBookChapters(bookId: string): Promise<BackendChapter[]> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/chapters`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`章节清单获取失败(${res.status})`);
  const json = await res.json();
  return (json.data || []) as BackendChapter[];
}

/** 拉取 TTS 设置（音色/语速，播放参数真源） */
export interface TtsPlaybackSettings {
  voiceId: string;
  speed: number;
}

export async function fetchPlaybackSettings(): Promise<TtsPlaybackSettings> {
  const res = await fetch('/api/tts/settings', { headers: authHeaders() });
  if (!res.ok) throw new Error(`TTS 设置获取失败(${res.status})`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'TTS 设置获取失败');
  return { voiceId: json.data?.voiceId || 'alloy', speed: Number(json.data?.speed) || 1.0 };
}
