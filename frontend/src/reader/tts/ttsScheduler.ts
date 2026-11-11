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
  /** 章起始在全书文本中的占比 0~1（后端 start_offset/全书总长）；缺省 undefined = 无偏移元数据 */
  startRatio?: number;
}

/**
 * 构造章节推进表。
 * - TXT：后端表顺序即内存 EPUB spine 顺序（ReaderPage feedInputs 按 chapters 顺序构建），
 *   displayHref 按 buildTxtEpub 的 `txt-{i}.xhtml` 规则生成。
 * - EPUB：displayHref 直接用后端 href（与 relocated 的包内路径同源）。
 */
export function buildChapterList(
  chapters: Array<{ id: string; title: string; href: string | null; start_offset?: number | null; end_offset?: number | null }>,
  format: 'epub' | 'txt',
): TtsChapterEntry[] {
  // 全书长度基准：各章 end_offset 最大值（兼容只回 start_offset 的旧数据）
  const offsets = chapters.map(c => Number(c.end_offset ?? c.start_offset ?? NaN));
  const totalLen = offsets.every(n => Number.isFinite(n)) ? Math.max(...offsets) : NaN;
  return chapters.map((c, i) => {
    const so = Number(c.start_offset ?? NaN);
    return {
      chapterId: c.id,
      title: c.title || `第 ${i + 1} 章`,
      displayHref: format === 'txt' ? `txt-${i}.xhtml` : (c.href || ''),
      // 章占比就绪且全书长度 >0 才提供（同源解析出的偏移才能直接比占比）
      startRatio: Number.isFinite(so) && Number.isFinite(totalLen) && totalLen > 0
        ? Math.min(1, Math.max(0, so / totalLen))
        : undefined,
    };
  });
}

/** 归一化 href 参与匹配：去 fragment、去首尾空白、统一开头斜杠 */
function normalizeHref(href: string): string {
  return href.split('#')[0].trim().replace(/^\/+/, '');
}

/**
 * 定位起始章。
 * 优先「全书占比」定位：章节带 startRatio 且调用方提供当前阅读全书百分比时，
 * 取「章占比 ≤ 阅读百分比」的最后一章——合辑 EPUB（多章共写同一文件、目录靠 fragment 区分）
 * 的 relocated 事件只给文件级 href（无 fragment），href 匹配永远命中该文件第一条目录（书名页等），
 * 表现为「点听书永远跳回书的开头」；占比定位与 href 形式无关，对独立文件章同样正确。
 * 否则退回 href 匹配：优先精确匹配 displayHref；EPUB 退化用 basename 匹配
 * （后端 href 可能带目录前缀，relocated href 为 spine 相对路径）。
 * 都找不到返回 0（从第一章播，不阻塞听书）。
 */
export function findStartChapterIndex(
  chapterList: TtsChapterEntry[],
  currentHref: string | null,
  bookPercentage?: number | null,
): number {
  const pct = typeof bookPercentage === 'number' && Number.isFinite(bookPercentage) ? bookPercentage : null;
  if (pct !== null && chapterList.some(c => typeof c.startRatio === 'number')) {
    // eps 容差：阅读百分比略小于章占比（章首附近）时仍算落在该章；占比缺失的章跳过
    const EPS = 0.005;
    let last = -1;
    for (let i = 0; i < chapterList.length; i++) {
      const r = chapterList[i].startRatio;
      if (typeof r !== 'number') continue;
      if (r <= pct + EPS) last = i;
    }
    if (last >= 0) return last;
  }
  if (!currentHref) return 0;
  const cur = normalizeHref(currentHref);
  const exact = chapterList.findIndex(c => normalizeHref(c.displayHref) === cur);
  if (exact >= 0) return exact;
  const curBase = cur.split('/').pop() || cur;
  const byBase = chapterList.findIndex(c => (normalizeHref(c.displayHref).split('/').pop() || '') === curBase);
  return byBase >= 0 ? byBase : 0;
}
