/**
 * TtsScheduler — 段音频调度（Phase 2 播放层数据面）
 *
 * 职责：给定一段朗读分段，按「batch-cache 命中 → 实时合成兜底」取音频；
 * 单段失败自动重试 1 次，仍失败返回 null（由会话层跳过并计数，不中断整章）。
 * 另含章节映射工具（阅读器 href ↔ 后端 chapterId）。
 */
import {
  fetchAudioBlob,
  synthesizeSegment,
  type TtsSegmentInfo,
} from './ttsApi';

export interface ResolveAudioOptions {
  cacheMap: Map<string, string>;
  voice: string;
  speed: number;
  bookId: string;
  chapterId: string;
  noCache: boolean;
  /** 失败重试次数（默认 1：共最多 2 次尝试） */
  maxRetries?: number;
}

/**
 * 取一段音频：缓存命中直接下载；miss 实时合成；失败重试后返回 null。
 */
export async function resolveSegmentAudio(
  seg: TtsSegmentInfo,
  opts: ResolveAudioOptions,
): Promise<Blob | null> {
  const maxRetries = opts.maxRetries ?? 1;
  // 1) 预生成缓存命中
  const cachedUrl = opts.cacheMap.get(seg.textHash);
  if (cachedUrl) {
    try {
      return await fetchAudioBlob(cachedUrl);
    } catch {
      /* 缓存文件失效 → 落实时合成 */
    }
  }
  // 2) 实时合成（失败自动重试 maxRetries 次）
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await synthesizeSegment({
        input: seg.text,
        voice: opts.voice,
        speed: opts.speed,
        bookId: opts.bookId,
        chapterId: opts.chapterId,
        noCache: opts.noCache,
      });
    } catch {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
  }
  return null;
}

/** 统一后端章节表 → 播放推进用章节列表 */
export interface TtsChapterEntry {
  chapterId: string;
  title: string;
  /** 阅读器跳转目标（TXT: txt-{i}.xhtml；EPUB: 包内 href） */
  displayHref: string;
}

/**
 * 构造章节推进表。
 * - TXT：后端表顺序即 feed 顺序（ReaderPage feedInputs 按 chapters 顺序构建），
 *   displayHref 按 buildTxtFeed 的 `txt-{i}.xhtml` 规则生成。
 * - EPUB：displayHref 直接用后端 href（与 relocated 的包内路径同源）。
 */
export function buildChapterList(
  chapters: Array<{ id: string; title: string; href: string | null }>,
  format: 'epub' | 'txt',
): TtsChapterEntry[] {
  return chapters.map((c, i) => ({
    chapterId: c.id,
    title: c.title || `第 ${i + 1} 章`,
    displayHref: format === 'txt' ? `txt-${i}.xhtml` : (c.href || ''),
  }));
}

/** 归一化 href 参与匹配：去 fragment、去首尾空白、统一开头斜杠 */
function normalizeHref(href: string): string {
  return href.split('#')[0].trim().replace(/^\/+/, '');
}

/**
 * 定位起始章：优先精确匹配 displayHref；EPUB 退化用 basename 匹配
 * （后端 href 可能带目录前缀，relocated href 为 spine 相对路径）。
 * 找不到返回 0（从第一章播，不阻塞听书）。
 */
export function findStartChapterIndex(
  chapterList: TtsChapterEntry[],
  currentHref: string | null,
): number {
  if (!currentHref) return 0;
  const cur = normalizeHref(currentHref);
  const exact = chapterList.findIndex(c => normalizeHref(c.displayHref) === cur);
  if (exact >= 0) return exact;
  const curBase = cur.split('/').pop() || cur;
  const byBase = chapterList.findIndex(c => (normalizeHref(c.displayHref).split('/').pop() || '') === curBase);
  return byBase >= 0 ? byBase : 0;
}
