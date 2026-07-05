/**
 * 离线缓存服务 — IndexedDB 客户端缓存
 *
 * 将书籍章节内容和 TTS 音频缓存到浏览器本地 IndexedDB，
 * 支持离线阅读和收听（例如在飞机上）。
 *
 * 数据库：ireader_cache (v1)
 * Object stores:
 *   - bookChapters: 书籍章节内容（key: bookId:chapterId）
 *   - ttsAudio:     TTS 音频数据（key: bookId:chapterId:segmentIndex）
 *   - cacheMeta:    缓存元信息（key: bookId）
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'ireader_cache';
const DB_VERSION = 1;

interface BookChapterCache {
  key: string;       // "bookId:chapterId"
  bookId: string;
  chapterId: string;
  chapterTitle: string;
  chapterOrder: number;
  content: string;
  cachedAt: number;
}

interface TTSAudioCache {
  key: string;       // "bookId:chapterId:segmentIndex"
  bookId: string;
  chapterId: string;
  segmentIndex: number;
  audioData: ArrayBuffer;
  duration: number;  // 估计时长（秒）
  cachedAt: number;
}

interface CacheMeta {
  bookId: string;
  bookTitle: string;
  totalChapters: number;
  cachedChapters: number;
  totalAudioSegments: number;
  cachedAudioSegments: number;
  lastCachedAt: number;
}

/**
 * 书架缓存元数据 — 用于离线时显示书架
 * 存储在 cacheMeta store 中，与 CacheMeta 共用 bookId key
 * 字段前缀 shelf_ 以避免与 CacheMeta 字段冲突
 */
export interface ShelfCacheMeta {
  bookId: string;
  bookTitle: string;
  author: string;
  coverUrl: string;
  format: 'epub' | 'txt';
  hasCover: boolean;
  cachedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

/**
 * 打开/初始化 IndexedDB 数据库
 */
function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('bookChapters')) {
          const store = db.createObjectStore('bookChapters', { keyPath: 'key' });
          store.createIndex('bookId', 'bookId', { unique: false });
          store.createIndex('chapterId', 'chapterId', { unique: false });
        }
        if (!db.objectStoreNames.contains('ttsAudio')) {
          const store = db.createObjectStore('ttsAudio', { keyPath: 'key' });
          store.createIndex('bookId', 'bookId', { unique: false });
          store.createIndex('chapterId', 'chapterId', { unique: false });
        }
        if (!db.objectStoreNames.contains('cacheMeta')) {
          db.createObjectStore('cacheMeta', { keyPath: 'bookId' });
        }
      },
    });
  }
  return dbPromise;
}

// ==========================
// 书籍章节缓存
// ==========================

export interface ChapterCacheInput {
  chapterId: string;
  title: string;
  order: number;
  content: string;
}

/**
 * 缓存一本书的多个章节内容
 */
export async function cacheBookChapters(
  bookId: string,
  bookTitle: string,
  chapters: ChapterCacheInput[],
): Promise<{ cached: number; total: number }> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'cacheMeta'], 'readwrite');
  const chapterStore = tx.objectStore('bookChapters');
  const metaStore = tx.objectStore('cacheMeta');
  const now = Date.now();

  let cached = 0;
  for (const ch of chapters) {
    const key = `${bookId}:${ch.chapterId}`;
    await chapterStore.put({
      key,
      bookId,
      chapterId: ch.chapterId,
      chapterTitle: ch.title,
      chapterOrder: ch.order,
      content: ch.content,
      cachedAt: now,
    } as BookChapterCache);
    cached++;
  }

  // 更新元数据 - 重新计算实际缓存章节数（避免重复点击累加）
  const allBookChapters = await chapterStore.index('bookId').getAll(bookId) as BookChapterCache[];
  const actualCachedCount = allBookChapters.length;
  const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  const newMeta: CacheMeta = {
    bookId,
    bookTitle,
    totalChapters: Math.max(existingMeta?.totalChapters ?? 0, chapters.length),
    cachedChapters: actualCachedCount,
    totalAudioSegments: existingMeta?.totalAudioSegments ?? 0,
    cachedAudioSegments: existingMeta?.cachedAudioSegments ?? 0,
    lastCachedAt: now,
  };
  await metaStore.put(newMeta);

  await tx.done;
  return { cached, total: chapters.length };
}

/**
 * 缓存单个章节内容
 */
export async function cacheSingleChapter(
  bookId: string,
  bookTitle: string,
  chapter: ChapterCacheInput,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'cacheMeta'], 'readwrite');
  const chapterStore = tx.objectStore('bookChapters');
  const metaStore = tx.objectStore('cacheMeta');
  const now = Date.now();

  const key = `${bookId}:${chapter.chapterId}`;
  await chapterStore.put({
    key,
    bookId,
    chapterId: chapter.chapterId,
    chapterTitle: chapter.title,
    chapterOrder: chapter.order,
    content: chapter.content,
    cachedAt: now,
  } as BookChapterCache);

  // 更新元数据
  const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  const existingChapters = await chapterStore.index('bookId').getAll(bookId);
  const newMeta: CacheMeta = {
    bookId,
    bookTitle,
    totalChapters: existingMeta?.totalChapters ?? 1,
    cachedChapters: existingChapters.length,
    totalAudioSegments: existingMeta?.totalAudioSegments ?? 0,
    cachedAudioSegments: existingMeta?.cachedAudioSegments ?? 0,
    lastCachedAt: now,
  };
  await metaStore.put(newMeta);

  await tx.done;
}

/**
 * 获取缓存的章节内容
 */
export async function getCachedChapterContent(
  bookId: string,
  chapterId: string,
): Promise<string | null> {
  try {
    const db = await getDB();
    const key = `${bookId}:${chapterId}`;
    const entry = await db.get('bookChapters', key) as BookChapterCache | undefined;
    return entry?.content ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取一本书所有缓存的章节
 */
export async function getCachedChapters(bookId: string): Promise<{ chapterId: string; title: string; order: number }[]> {
  try {
    const db = await getDB();
    const entries = await db.getAllFromIndex('bookChapters', 'bookId', bookId) as BookChapterCache[];
    return entries
      .sort((a, b) => a.chapterOrder - b.chapterOrder)
      .map(e => ({ chapterId: e.chapterId, title: e.chapterTitle, order: e.chapterOrder }));
  } catch {
    return [];
  }
}

// ==========================
// TTS 音频缓存
// ==========================

export interface TTSAudioCacheInput {
  chapterId: string;
  segmentIndex: number;
  audioData: ArrayBuffer;
  duration?: number;
}

/**
 * 缓存 TTS 音频数据
 */
export async function cacheTTSAudio(
  bookId: string,
  chapterId: string,
  segmentIndex: number,
  audioData: ArrayBuffer,
  duration?: number,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['ttsAudio', 'cacheMeta'], 'readwrite');
  const audioStore = tx.objectStore('ttsAudio');
  const metaStore = tx.objectStore('cacheMeta');

  const key = `${bookId}:${chapterId}:${segmentIndex}`;
  await audioStore.put({
    key,
    bookId,
    chapterId,
    segmentIndex,
    audioData,
    duration: duration ?? 0,
    cachedAt: Date.now(),
  } as TTSAudioCache);

  // 更新元数据（不存在则创建）
  let existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  if (!existingMeta) {
    existingMeta = {
      bookId,
      bookTitle: '',
      totalChapters: 0,
      cachedChapters: 0,
      totalAudioSegments: 0,
      cachedAudioSegments: 0,
      lastCachedAt: Date.now(),
    };
  }
  const allAudio = await audioStore.index('bookId').getAll(bookId) as TTSAudioCache[];
  existingMeta.cachedAudioSegments = allAudio.length;
  existingMeta.lastCachedAt = Date.now();
  await metaStore.put(existingMeta);

  await tx.done;
}

/**
 * 批量缓存 TTS 音频
 */
export async function cacheTTSAudioBatch(
  bookId: string,
  items: TTSAudioCacheInput[],
): Promise<number> {
  if (items.length === 0) return 0;
  const db = await getDB();
  const tx = db.transaction(['ttsAudio', 'cacheMeta'], 'readwrite');
  const audioStore = tx.objectStore('ttsAudio');
  const metaStore = tx.objectStore('cacheMeta');
  const now = Date.now();

  for (const item of items) {
    const key = `${bookId}:${item.chapterId}:${item.segmentIndex}`;
    await audioStore.put({
      key,
      bookId,
      chapterId: item.chapterId,
      segmentIndex: item.segmentIndex,
      audioData: item.audioData,
      duration: item.duration ?? 0,
      cachedAt: now,
    } as TTSAudioCache);
  }

  // 更新元数据（不存在则创建）
  let existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  if (!existingMeta) {
    existingMeta = {
      bookId,
      bookTitle: '',
      totalChapters: 0,
      cachedChapters: 0,
      totalAudioSegments: 0,
      cachedAudioSegments: 0,
      lastCachedAt: now,
    };
  }
  const allAudio = await audioStore.index('bookId').getAll(bookId) as TTSAudioCache[];
  existingMeta.cachedAudioSegments = allAudio.length;
  existingMeta.lastCachedAt = now;
  await metaStore.put(existingMeta);

  await tx.done;
  return items.length;
}

/**
 * 批量获取某章节所有缓存的 TTS 音频（用于预热）
 * 返回按 segmentIndex 排序的音频数据列表
 */
export async function getAllCachedTTSAudioForChapter(
  bookId: string,
  chapterId: string,
): Promise<{ segmentIndex: number; audioData: ArrayBuffer }[]> {
  try {
    const db = await getDB();
    const entries = await db.getAllFromIndex('ttsAudio', 'chapterId', chapterId) as TTSAudioCache[];
    return entries
      .filter(e => e.bookId === bookId)
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map(e => ({ segmentIndex: e.segmentIndex, audioData: e.audioData }));
  } catch {
    return [];
  }
}

/**
 * 获取缓存的 TTS 音频
 */
export async function getCachedTTSAudio(
  bookId: string,
  chapterId: string,
  segmentIndex: number,
): Promise<ArrayBuffer | null> {
  try {
    const db = await getDB();
    const key = `${bookId}:${chapterId}:${segmentIndex}`;
    const entry = await db.get('ttsAudio', key) as TTSAudioCache | undefined;
    if (!entry?.audioData) return null;
    // fake-indexeddb 可能将 ArrayBuffer 存储为 Blob，统一转为 ArrayBuffer
    if (entry.audioData instanceof Blob) {
      return await entry.audioData.arrayBuffer();
    }
    if (entry.audioData instanceof ArrayBuffer) {
      return entry.audioData;
    }
    // 兜底：尝试当作 ArrayBufferView（用 as any 避免 TS 类型收缩问题）
    const buf = entry.audioData as unknown as ArrayBufferView;
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

// ==========================
// 缓存查询与统计
// ==========================

export interface BookCacheStatus {
  bookId: string;
  bookTitle: string;
  totalChapters: number;
  cachedChapters: number;
  totalAudioSegments: number;
  cachedAudioSegments: number;
  lastCachedAt: number | null;
  /** 缓存是否完整（全部章节已缓存） */
  isFullyCached: boolean;
  /** 缓存完成百分比（0-1） */
  chapterCacheProgress: number;
  audioCacheProgress: number;
}

/**
 * 获取一本书的缓存状态
 */
export async function getBookCacheStatus(bookId: string): Promise<BookCacheStatus | null> {
  try {
    const db = await getDB();
    const meta = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    if (!meta) return null;

    return {
      bookId: meta.bookId,
      bookTitle: meta.bookTitle,
      totalChapters: meta.totalChapters,
      cachedChapters: meta.cachedChapters,
      totalAudioSegments: meta.totalAudioSegments,
      cachedAudioSegments: meta.cachedAudioSegments,
      lastCachedAt: meta.lastCachedAt,
      isFullyCached: meta.cachedChapters >= meta.totalChapters,
      chapterCacheProgress: meta.totalChapters > 0 ? meta.cachedChapters / meta.totalChapters : 0,
      audioCacheProgress: meta.totalAudioSegments > 0 ? meta.cachedAudioSegments / meta.totalAudioSegments : 0,
    };
  } catch {
    return null;
  }
}

/**
 * 获取所有已缓存的书籍 ID 列表
 */
export async function getAllCachedBookIds(): Promise<string[]> {
  try {
    const db = await getDB();
    const metas = await db.getAll('cacheMeta') as CacheMeta[];
    return metas.map(m => m.bookId);
  } catch {
    return [];
  }
}

/**
 * 获取所有已缓存书籍的缓存状态
 */
export async function getAllCachedBookStatuses(): Promise<BookCacheStatus[]> {
  try {
    const db = await getDB();
    const metas = await db.getAll('cacheMeta') as CacheMeta[];
    return metas.map(meta => ({
      bookId: meta.bookId,
      bookTitle: meta.bookTitle,
      totalChapters: meta.totalChapters,
      cachedChapters: meta.cachedChapters,
      totalAudioSegments: meta.totalAudioSegments,
      cachedAudioSegments: meta.cachedAudioSegments,
      lastCachedAt: meta.lastCachedAt,
      isFullyCached: meta.cachedChapters >= meta.totalChapters,
      chapterCacheProgress: meta.totalChapters > 0 ? meta.cachedChapters / meta.totalChapters : 0,
      audioCacheProgress: meta.totalAudioSegments > 0 ? meta.cachedAudioSegments / meta.totalAudioSegments : 0,
    }));
  } catch {
    return [];
  }
}

// ==========================
// 缓存清理
// ==========================

/**
 * 清除一本书的文字章节缓存（保留音频缓存）
 */
export async function clearBookChapterCache(bookId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'cacheMeta'], 'readwrite');
  const chapterStore = tx.objectStore('bookChapters');
  const metaStore = tx.objectStore('cacheMeta');

  const chapterKeys = await chapterStore.index('bookId').getAllKeys(bookId);
  for (const key of chapterKeys) {
    await chapterStore.delete(key);
  }

  // 更新元数据：重置章节缓存数
  const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  if (existingMeta) {
    existingMeta.cachedChapters = 0;
    existingMeta.lastCachedAt = Date.now();
    await metaStore.put(existingMeta);
  }

  await tx.done;
}

/**
 * 清除一本书的 TTS 音频缓存（保留文字缓存）
 */
export async function clearBookTTSAudioCache(bookId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['ttsAudio', 'cacheMeta'], 'readwrite');
  const audioStore = tx.objectStore('ttsAudio');
  const metaStore = tx.objectStore('cacheMeta');

  const audioKeys = await audioStore.index('bookId').getAllKeys(bookId);
  for (const key of audioKeys) {
    await audioStore.delete(key);
  }

  // 更新元数据：重置音频缓存数
  const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
  if (existingMeta) {
    existingMeta.cachedAudioSegments = 0;
    existingMeta.lastCachedAt = Date.now();
    await metaStore.put(existingMeta);
  }

  await tx.done;
}

export interface BookCacheDetailedStats {
  bookId: string;
  bookTitle: string;
  /** 文字缓存 */
  chapterCount: number;
  totalChapters: number;
  chapterBytes: number;
  /** 语音缓存 */
  audioSegmentCount: number;
  /** 语音缓存覆盖的章节数（而非音频段数） */
  audioChapterCount: number;
  audioBytes: number;
  /** 汇总 */
  totalBytes: number;
  lastCachedAt: number | null;
}

/**
 * 获取一本书的详细缓存统计（含占用空间）
 */
export async function getBookCacheDetailedStats(bookId: string): Promise<BookCacheDetailedStats | null> {
  try {
    const db = await getDB();
    const meta = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    if (!meta) return null;

    const chapters = await db.getAll('bookChapters') as BookChapterCache[];
    const audios = await db.getAll('ttsAudio') as TTSAudioCache[];
    const bookChaptersList = chapters.filter(c => c.bookId === bookId);
    const bookAudiosList = audios.filter(a => a.bookId === bookId);

    const chapterBytes = bookChaptersList.reduce((sum, c) => sum + new Blob([c.content]).size, 0);
    // ⭐ 修复：audioData 在 IndexedDB 中可能存为 Blob，需统一转为 ArrayBuffer 再取 byteLength
    let audioBytes = 0;
    const audioChapterSet = new Set<string>();
    for (const a of bookAudiosList) {
      audioChapterSet.add(a.chapterId);
      try {
        if (a.audioData instanceof Blob) {
          audioBytes += a.audioData.size;
        } else if (a.audioData instanceof ArrayBuffer) {
          audioBytes += a.audioData.byteLength;
        } else {
          // ArrayBufferView 兜底
          const buf = a.audioData as unknown as ArrayBufferView;
          audioBytes += buf.byteLength;
        }
      } catch {
        // 单条计算失败不阻塞整体
      }
    }

    return {
      bookId: meta.bookId,
      bookTitle: meta.bookTitle,
      chapterCount: meta.cachedChapters,
      totalChapters: meta.totalChapters,
      chapterBytes,
      audioSegmentCount: meta.cachedAudioSegments,
      audioChapterCount: audioChapterSet.size,
      audioBytes,
      totalBytes: chapterBytes + audioBytes,
      lastCachedAt: meta.lastCachedAt,
    };
  } catch {
    return null;
  }
}

/**
/**
 * 清除一本书的所有缓存（章节内容 + TTS 音频 + 元数据）
 */
export async function clearBookCache(bookId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'ttsAudio', 'cacheMeta'], 'readwrite');
  const chapterStore = tx.objectStore('bookChapters');
  const audioStore = tx.objectStore('ttsAudio');
  const metaStore = tx.objectStore('cacheMeta');

  // 删除所有该书的章节缓存
  const chapterKeys = await chapterStore.index('bookId').getAllKeys(bookId);
  for (const key of chapterKeys) {
    await chapterStore.delete(key);
  }

  // 删除所有该书的音频缓存
  const audioKeys = await audioStore.index('bookId').getAllKeys(bookId);
  for (const key of audioKeys) {
    await audioStore.delete(key);
  }

  // 删除元数据
  await metaStore.delete(bookId);

  await tx.done;
}

/**
 * 清除所有缓存
 */
export async function clearAllCache(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'ttsAudio', 'cacheMeta'], 'readwrite');
  await tx.objectStore('bookChapters').clear();
  await tx.objectStore('ttsAudio').clear();
  await tx.objectStore('cacheMeta').clear();
  await tx.done;
}

/**
 * 获取缓存数据库的估计大小（字节）
 */
export async function estimateCacheSize(): Promise<{ chapterBytes: number; audioBytes: number; totalBytes: number }> {
  try {
    const db = await getDB();
    const chapters = await db.getAll('bookChapters') as BookChapterCache[];
    const audios = await db.getAll('ttsAudio') as TTSAudioCache[];

    const chapterBytes = chapters.reduce((sum, c) => sum + new Blob([c.content]).size, 0);
    const audioBytes = audios.reduce((sum, a) => sum + a.audioData.byteLength, 0);

    return {
      chapterBytes,
      audioBytes,
      totalBytes: chapterBytes + audioBytes,
    };
  } catch {
    return { chapterBytes: 0, audioBytes: 0, totalBytes: 0 };
  }
}


// ==========================
// 书架离线缓存
// ==========================

/**
 * 缓存一本书的书架元数据（书名、作者、封面等）
 * 用于离线时书架页面仍然能显示书籍信息
 */
export async function cacheShelfBookMeta(
  bookId: string,
  title: string,
  author: string,
  coverUrl: string,
  format: 'epub' | 'txt',
  hasCover: boolean,
): Promise<void> {
  try {
    const db = await getDB();
    const existingMeta = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    const shelfMeta: ShelfCacheMeta = {
      bookId,
      bookTitle: title,
      author,
      coverUrl,
      format,
      hasCover,
      cachedAt: Date.now(),
    };
    if (existingMeta) {
      await db.put('cacheMeta', { ...existingMeta, ...shelfMeta });
    } else {
      await db.put('cacheMeta', shelfMeta);
    }
  } catch {
    // 静默失败
  }
}

/**
 * 批量缓存书架上的所有书籍元数据
 */
export async function cacheShelfBooksMeta(
  books: Array<{
    id: string;
    title: string;
    author: string | null;
    coverPath: string | null;
    format: 'epub' | 'txt';
  }>,
): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction('cacheMeta', 'readwrite');
    const store = tx.objectStore('cacheMeta');
    const now = Date.now();

    for (const book of books) {
      const coverUrl = book.coverPath ? `/api/books/${book.id}/cover` : '';
      const existingMeta = await store.get(book.id) as CacheMeta | undefined;
      const shelfMeta: ShelfCacheMeta = {
        bookId: book.id,
        bookTitle: book.title,
        author: book.author || '',
        coverUrl,
        format: book.format,
        hasCover: !!book.coverPath,
        cachedAt: now,
      };
      if (existingMeta) {
        await store.put({ ...existingMeta, ...shelfMeta });
      } else {
        await store.put(shelfMeta);
      }
    }
    await tx.done;
  } catch {
    // 静默失败
  }
}

/**
 * 获取离线书架书籍列表（从 IndexedDB 读取）
 */
export async function getOfflineShelfBooks(): Promise<ShelfCacheMeta[]> {
  try {
    const db = await getDB();
    const allMetas = await db.getAll('cacheMeta') as Array<CacheMeta | ShelfCacheMeta>;
    return allMetas
      .filter((m: any) => m && m.bookTitle)
      .map((m: any) => ({
        bookId: m.bookId,
        bookTitle: m.bookTitle,
        author: m.author || '',
        coverUrl: m.coverUrl || '',
        format: m.format || 'epub',
        hasCover: m.hasCover || false,
        cachedAt: m.cachedAt || 0,
      } as ShelfCacheMeta))
      .sort((a, b) => b.cachedAt - a.cachedAt);
  } catch {
    return [];
  }
}

/**
 * 检查是否处于在线状态
 */
export function isOnline(): boolean {
  return navigator.onLine;
}

/**
 * 监听网络状态变化
 */
export function onNetworkChange(callback: (online: boolean) => void): () => void {
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
