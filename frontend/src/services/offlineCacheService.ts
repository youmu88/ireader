/**
 * 离线缓存服务 — IndexedDB 客户端缓存
 *
 * 将书籍章节内容和 TTS 音频缓存到浏览器本地 IndexedDB，
 * 支持离线阅读和收听（例如在飞机上）。
 *
 * 数据库：ireader_cache (v6)
 * Object stores:
 *   - bookChapters:     书籍章节内容（key: bookId:chapterId）
 *   - ttsAudio:         TTS 音频数据（key: bookId:chapterId:segmentIndex）
 *   - cacheMeta:        缓存元信息（key: bookId）
 *   - epubResources:    EPUB 内部资源（key: bookId:path）
 *   - epubArchives:     EPUB 原始 zip（key: bookId）
 *   - downloadSessions: 下载会话/续传（key: sessionId）
 *   - offlinePackages:  完整离线包元数据（key: bookId）
 */
import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'ireader_cache';
const DB_VERSION = 6;

export type OfflinePackageStatus = 'downloading' | 'ready' | 'failed' | 'stale';

// ── 完整离线包类型（P0-5） ──

/** 资源清单条目 */
export interface OfflineResourceEntry {
  path: string;
  contentType: string;
  size: number;
  hash: string;
  cached: boolean;
}

/** TOC 节点 */
export interface OfflineTocNode {
  id: string;
  title: string;
  href: string;
  fragment: string | null;
  spineIndex: number;
  level: number;
  children: OfflineTocNode[];
}

/** 完整离线包（替代旧 OfflineBookPackageMeta 的完整版本） */
export interface OfflineBookPackage {
  packageId: string;
  bookId: string;
  bookVersionHash: string | null;
  manifestVersion: number;

  metadata: {
    title: string;
    author: string;
    format: 'epub' | 'txt';
    coverPath: string | null;
  };

  chapters: { total: number; cached: number };

  epubResources: {
    total: number;
    cached: number;
    totalBytes: number;
    cachedBytes: number;
    manifest: OfflineResourceEntry[];
  };

  toc: OfflineTocNode[];

  progress: { cfi: string | null; chapterId: string | null; updatedAt: number };

  status: OfflinePackageStatus;
  totalBytes: number;
  createdAt: number;
  updatedAt: number;
}

/** EPUB 离线包下载会话（续传） */
export interface EpubDownloadSession {
  sessionId: string;
  bookId: string;
  sessionType: 'epub-package';
  status: 'active' | 'completed' | 'failed';
  totalItems: number;
  completedItems: string[];
  failedItems: string[];
  createdAt: number;
  updatedAt: number;
}

/** 包校验结果 */
export interface PackageValidationResult {
  valid: boolean;
  missingResources: string[];
  corruptResources: string[];
  archivePresent: boolean;
  chaptersPresent: boolean;
}

/**
 * 旧版离线包元数据（向后兼容）
 * @deprecated 使用 OfflineBookPackage 代替
 */
export interface OfflineBookPackageMeta {
  bookId: string;
  versionHash: string | null;
  status: OfflinePackageStatus;
  totalResources: number;
  cachedResources: number;
  updatedAt: number;
}

interface EpubResourceCache {
  key: string;
  bookId: string;
  path: string;
  contentType: string;
  hash: string;
  data: ArrayBuffer;
  cachedAt: number;
}

interface EpubArchiveCache {
  bookId: string;
  versionHash: string | null;
  data: ArrayBuffer;
  cachedAt: number;
}

export interface TTSAudioIdentity {
  voice: string;
  /** 合成语速（影响缓存身份，不同于本地播放倍速 playbackRate） */
  synthesisRate: number;
  source: string;
  text: string;
}

function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getTTSAudioKey(bookId: string, chapterId: string, segmentIndex: number, identity?: TTSAudioIdentity): string {
  if (!identity) return `${bookId}:${chapterId}:${segmentIndex}`;
  return `${bookId}:${chapterId}:${segmentIndex}:${encodeURIComponent(identity.source)}:${encodeURIComponent(identity.voice)}:${identity.synthesisRate}:${fingerprintText(identity.text)}`;
}

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
  key: string;
  bookId: string;
  chapterId: string;
  segmentIndex: number;
  audioData: ArrayBuffer;
  duration: number;
  cachedAt: number;
  voice?: string;
  synthesisRate?: number;
  source?: string;
  textFingerprint?: string;
}

interface CacheMeta {
  bookId: string;
  bookTitle: string;
  totalChapters: number;
  cachedChapters: number;
  totalAudioSegments: number;
  cachedAudioSegments: number;
  lastCachedAt: number;
  offlinePackage?: OfflineBookPackageMeta;
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
        if (!db.objectStoreNames.contains('epubResources')) {
          const store = db.createObjectStore('epubResources', { keyPath: 'key' });
          store.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('epubArchives')) {
          db.createObjectStore('epubArchives', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('downloadSessions')) {
          const store = db.createObjectStore('downloadSessions', { keyPath: 'sessionId' });
          store.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('offlinePackages')) {
          const store = db.createObjectStore('offlinePackages', { keyPath: 'bookId' });
          store.createIndex('status', 'status', { unique: false });
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

/**
 * 获取一本书的离线书籍信息（从 cacheMeta 读取）
 * 仅返回离线阅读器需要的基本信息
 */
export async function getOfflineBookInfo(bookId: string): Promise<{
  id: string;
  title: string;
  author: string;
  format: 'epub' | 'txt';
  status: string;
} | null> {
  try {
    const db = await getDB();
    const meta = await db.get('cacheMeta', bookId) as any;
    if (!meta || !meta.bookTitle) return null;
    return {
      id: bookId,
      title: meta.bookTitle,
      author: meta.author || '',
      format: meta.format || 'epub',
      status: 'ready',
    };
  } catch {
    return null;
  }
}

// ==========================
// EPUB 离线资源包
// ==========================

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('ireader_auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function verifySha256(data: ArrayBuffer, expected: string): Promise<boolean> {
  if (!expected || typeof crypto === 'undefined' || !crypto.subtle) return true;
  const digest = await crypto.subtle.digest('SHA-256', data);
  const actual = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return actual === expected;
}

export async function getOfflinePackageMeta(bookId: string): Promise<OfflineBookPackageMeta | null> {
  try {
    const db = await getDB();
    const meta = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    return meta?.offlinePackage || null;
  } catch {
    return null;
  }
}

export async function getCachedEpubResource(bookId: string, resourcePath: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  try {
    const db = await getDB();
    const resource = await db.get('epubResources', `${bookId}:${resourcePath}`) as EpubResourceCache | undefined;
    return resource ? { data: resource.data, contentType: resource.contentType } : null;
  } catch {
    return null;
  }
}

export async function getCachedEpubArchive(bookId: string): Promise<{ data: ArrayBuffer; versionHash: string | null } | null> {
  try {
    const db = await getDB();
    const archive = await db.get('epubArchives', bookId) as EpubArchiveCache | undefined;
    return archive ? { data: archive.data, versionHash: archive.versionHash } : null;
  } catch {
    return null;
  }
}

/** 获取完整离线包（新版） */
export async function getOfflinePackage(bookId: string): Promise<OfflineBookPackage | null> {
  try {
    const db = await getDB();
    return await db.get('offlinePackages', bookId) as OfflineBookPackage | undefined ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取所有已缓存离线包的 bookId 列表
 * 用于书架页 mount 时批量执行 checkPackageStaleness
 */
export async function getAllOfflinePackageBookIds(): Promise<string[]> {
  try {
    const db = await getDB();
    return await db.getAllKeys('offlinePackages') as string[];
  } catch {
    return [];
  }
}

/** 保存完整离线包 */
async function saveOfflinePackage(pkg: OfflineBookPackage): Promise<void> {
  const db = await getDB();
  await db.put('offlinePackages', pkg);
  // 同步旧版 offlinePackage 字段到 cacheMeta（向后兼容 EpubViewer）
  const existing = await db.get('cacheMeta', pkg.bookId) as CacheMeta | undefined;
  if (existing) {
    existing.offlinePackage = {
      bookId: pkg.bookId,
      versionHash: pkg.bookVersionHash,
      status: pkg.status,
      totalResources: pkg.epubResources.total,
      cachedResources: pkg.epubResources.cached,
      updatedAt: pkg.updatedAt,
    };
    existing.lastCachedAt = pkg.updatedAt;
    await db.put('cacheMeta', existing);
  }
}

/** 创建或恢复 EPUB 包下载会话 */
async function getOrCreateEpubDownloadSession(bookId: string, totalItems: number): Promise<EpubDownloadSession> {
  const db = await getDB();
  const existing = await db.getAllFromIndex('downloadSessions', 'bookId', bookId) as EpubDownloadSession[];
  const active = existing.find(s => s.sessionType === 'epub-package' && s.status === 'active');
  if (active) return active;
  const session: EpubDownloadSession = {
    sessionId: `${bookId}:epub:${Date.now()}`,
    bookId,
    sessionType: 'epub-package',
    status: 'active',
    totalItems,
    completedItems: [],
    failedItems: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.put('downloadSessions', session);
  return session;
}

async function updateEpubDownloadSession(session: EpubDownloadSession): Promise<void> {
  const db = await getDB();
  session.updatedAt = Date.now();
  await db.put('downloadSessions', session);
}

/**
 * 下载完整 EPUB 离线包（含资源清单、封面、TOC、续传）
 */
export async function downloadOfflineEpubPackage(
  bookId: string,
  bookTitle: string,
  chapters: ChapterCacheInput[],
  onProgress?: (completed: number, total: number) => void,
  options?: { author?: string; toc?: OfflineTocNode[]; coverPath?: string | null },
): Promise<OfflineBookPackageMeta> {
  const db = await getDB();

  try {
    // 1. 获取资源清单
    const manifestResponse = await fetch(`/api/books/${encodeURIComponent(bookId)}/resources`, { headers: authHeaders() });
    if (!manifestResponse.ok) throw new Error('无法获取 EPUB 资源清单');
    const manifestJson = await manifestResponse.json();
    const manifest = manifestJson?.data;
    if (!manifest?.resources?.length) throw new Error('EPUB 资源清单为空');

    const versionHash: string | null = manifest.versionHash || null;
    const resources = manifest.resources as Array<{ path: string; size: number; contentType: string; hash: string }>;
    const totalBytes = resources.reduce((sum, r) => sum + r.size, 0);
    const total = chapters.length + resources.length + 1; // +1 for archive

    // 2. 创建/恢复下载会话
    const session = await getOrCreateEpubDownloadSession(bookId, total);
    const completedSet = new Set(session.completedItems);

    // 3. 构建完整包结构
    const now = Date.now();
    const pkg: OfflineBookPackage = {
      packageId: `${bookId}:${versionHash || 'unknown'}`,
      bookId,
      bookVersionHash: versionHash,
      manifestVersion: 1,
      metadata: {
        title: bookTitle,
        author: options?.author || '',
        format: 'epub',
        coverPath: options?.coverPath ?? null,
      },
      chapters: { total: chapters.length, cached: 0 },
      epubResources: {
        total: resources.length,
        cached: 0,
        totalBytes,
        cachedBytes: 0,
        manifest: resources.map(r => ({ path: r.path, contentType: r.contentType, size: r.size, hash: r.hash, cached: completedSet.has(`res:${r.path}`) })),
      },
      toc: options?.toc || [],
      progress: { cfi: null, chapterId: null, updatedAt: now },
      status: 'downloading',
      totalBytes,
      createdAt: now,
      updatedAt: now,
    };
    await saveOfflinePackage(pkg);

    let completed = completedSet.size;
    onProgress?.(completed, total);

    // 4. 缓存章节（跳过已完成）
    if (!completedSet.has('chapters')) {
      await cacheBookChapters(bookId, bookTitle, chapters);
      session.completedItems.push('chapters');
      completedSet.add('chapters');
      completed++;
      await updateEpubDownloadSession(session);
      onProgress?.(completed, total);
    }
    pkg.chapters.cached = chapters.length;

    // 5. 下载原始 EPUB 归档（跳过已完成）
    if (!completedSet.has('archive')) {
      const archiveResponse = await fetch(`/api/books/${encodeURIComponent(bookId)}/file/`, { headers: authHeaders() });
      if (!archiveResponse.ok) throw new Error('EPUB 原始文件下载失败');
      const archiveData = await archiveResponse.arrayBuffer();
      const archiveTx = db.transaction('epubArchives', 'readwrite');
      await archiveTx.objectStore('epubArchives').put({ bookId, versionHash, data: archiveData, cachedAt: Date.now() } as EpubArchiveCache);
      await archiveTx.done;
      session.completedItems.push('archive');
      completedSet.add('archive');
      completed++;
      await updateEpubDownloadSession(session);
      onProgress?.(completed, total);
    }

    // 6. 逐个下载资源（跳过已完成，支持续传）
    for (const resource of resources) {
      const itemKey = `res:${resource.path}`;
      if (completedSet.has(itemKey)) {
        pkg.epubResources.cached++;
        pkg.epubResources.cachedBytes += resource.size;
        continue;
      }
      const urlPath = resource.path.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/file/${urlPath}`, { headers: authHeaders() });
      if (!response.ok) throw new Error(`资源下载失败：${resource.path}`);
      const data = await response.arrayBuffer();
      if (!(await verifySha256(data, resource.hash))) throw new Error(`资源校验失败：${resource.path}`);
      const resourceTx = db.transaction('epubResources', 'readwrite');
      await resourceTx.objectStore('epubResources').put({
        key: `${bookId}:${resource.path}`,
        bookId,
        path: resource.path,
        contentType: resource.contentType,
        hash: resource.hash,
        data,
        cachedAt: Date.now(),
      } as EpubResourceCache);
      await resourceTx.done;

      // 更新清单中该资源的 cached 状态
      const entry = pkg.epubResources.manifest.find(e => e.path === resource.path);
      if (entry) entry.cached = true;
      pkg.epubResources.cached++;
      pkg.epubResources.cachedBytes += resource.size;

      session.completedItems.push(itemKey);
      completedSet.add(itemKey);
      completed++;
      await updateEpubDownloadSession(session);
      pkg.updatedAt = Date.now();
      await saveOfflinePackage(pkg);
      onProgress?.(completed, total);
    }

    // 7. 标记完成
    pkg.status = 'ready';
    pkg.updatedAt = Date.now();
    await saveOfflinePackage(pkg);
    session.status = 'completed';
    await updateEpubDownloadSession(session);

    // 返回旧版兼容结构
    return {
      bookId,
      versionHash,
      status: 'ready',
      totalResources: resources.length,
      cachedResources: resources.length,
      updatedAt: pkg.updatedAt,
    };
  } catch (error) {
    // 标记失败
    const failedPkg = await getOfflinePackage(bookId);
    if (failedPkg) {
      failedPkg.status = 'failed';
      failedPkg.updatedAt = Date.now();
      await saveOfflinePackage(failedPkg);
    }
    // 旧版兼容
    const existing = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    if (existing) {
      existing.offlinePackage = { bookId, versionHash: null, status: 'failed', totalResources: 0, cachedResources: 0, updatedAt: Date.now() };
      await db.put('cacheMeta', existing);
    }
    throw error;
  }
}

/**
 * 校验离线包完整性
 */
export async function validateOfflinePackage(bookId: string): Promise<PackageValidationResult> {
  const db = await getDB();
  const pkg = await db.get('offlinePackages', bookId) as OfflineBookPackage | undefined;
  if (!pkg) {
    return { valid: false, missingResources: [], corruptResources: [], archivePresent: false, chaptersPresent: false };
  }

  const missingResources: string[] = [];
  const corruptResources: string[] = [];

  // 检查归档
  const archive = await db.get('epubArchives', bookId) as EpubArchiveCache | undefined;
  const archivePresent = !!archive;

  // 检查章节
  const cachedChapters = await db.getAllFromIndex('bookChapters', 'bookId', bookId) as BookChapterCache[];
  const chaptersPresent = cachedChapters.length >= pkg.chapters.total;

  // 检查资源
  for (const entry of pkg.epubResources.manifest) {
    const cached = await db.get('epubResources', `${bookId}:${entry.path}`) as EpubResourceCache | undefined;
    if (!cached) {
      missingResources.push(entry.path);
    } else if (cached.hash !== entry.hash) {
      corruptResources.push(entry.path);
    }
  }

  return {
    valid: archivePresent && chaptersPresent && missingResources.length === 0 && corruptResources.length === 0,
    missingResources,
    corruptResources,
    archivePresent,
    chaptersPresent,
  };
}

/**
 * 失效检测：比对本地包 versionHash 与服务端最新 fileHash
 * 返回 true 表示包已过期（书籍被重新上传）
 */
export async function checkPackageStaleness(bookId: string): Promise<boolean> {
  try {
    const pkg = await getOfflinePackage(bookId);
    if (!pkg || pkg.status !== 'ready') return false;

    const res = await fetch(`/api/books/${encodeURIComponent(bookId)}`, { headers: authHeaders() });
    if (!res.ok) return false;
    const json = await res.json();
    const serverHash = json?.data?.fileHash;
    if (!serverHash) return false;

    if (pkg.bookVersionHash !== serverHash) {
      pkg.status = 'stale';
      pkg.updatedAt = Date.now();
      await saveOfflinePackage(pkg);
      return true;
    }
    return false;
  } catch {
    return false;
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
  identity?: TTSAudioIdentity;
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
  identity?: TTSAudioIdentity,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['ttsAudio', 'cacheMeta'], 'readwrite');
  const audioStore = tx.objectStore('ttsAudio');
  const metaStore = tx.objectStore('cacheMeta');

  const key = getTTSAudioKey(bookId, chapterId, segmentIndex, identity);
  await audioStore.put({
    key,
    bookId,
    chapterId,
    segmentIndex,
    audioData,
    duration: duration ?? 0,
    cachedAt: Date.now(),
    voice: identity?.voice,
    synthesisRate: identity?.synthesisRate,
    source: identity?.source,
    textFingerprint: identity ? fingerprintText(identity.text) : undefined,
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
    const key = getTTSAudioKey(bookId, item.chapterId, item.segmentIndex, item.identity);
    await audioStore.put({
      key,
      bookId,
      chapterId: item.chapterId,
      segmentIndex: item.segmentIndex,
      audioData: item.audioData,
      duration: item.duration ?? 0,
      cachedAt: now,
      voice: item.identity?.voice,
      synthesisRate: item.identity?.synthesisRate,
      source: item.identity?.source,
      textFingerprint: item.identity ? fingerprintText(item.identity.text) : undefined,
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
  identities?: TTSAudioIdentity[],
): Promise<{ segmentIndex: number; audioData: ArrayBuffer }[]> {
  try {
    const db = await getDB();
    const entries = await db.getAllFromIndex('ttsAudio', 'chapterId', chapterId) as TTSAudioCache[];
    return entries
      .filter(e => e.bookId === bookId)
      .filter(e => !identities || Boolean(identities[e.segmentIndex]) && e.key === getTTSAudioKey(bookId, chapterId, e.segmentIndex, identities[e.segmentIndex]))
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
  identity?: TTSAudioIdentity,
): Promise<ArrayBuffer | null> {
  try {
    const db = await getDB();
    const key = getTTSAudioKey(bookId, chapterId, segmentIndex, identity);
    const entry = await db.get('ttsAudio', key) as TTSAudioCache | undefined;
    if (!entry?.audioData) return null;
    // IndexedDB 返回值可能来自不同 Realm，不能只依赖 instanceof ArrayBuffer。
    if (typeof Blob !== 'undefined' && entry.audioData instanceof Blob) {
      return await entry.audioData.arrayBuffer();
    }
    if (ArrayBuffer.isView(entry.audioData as unknown as ArrayBufferView)) {
      const view = entry.audioData as unknown as ArrayBufferView;
      return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
    }
    if (Object.prototype.toString.call(entry.audioData) === '[object ArrayBuffer]') {
      return new Uint8Array(entry.audioData as ArrayBufferLike).slice().buffer;
    }
    return null;
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
  /** P1-7：当前 profile 下的音频覆盖率（0-1），未传 profile 时等于 audioCacheProgress */
  currentProfileCoverage: number;
}

/** P1-7：TTS profile 过滤参数 */
export interface TTSProfileFilter {
  voice: string;
  /** 合成语速（缓存身份组成部分） */
  synthesisRate: number;
  source: string;
}

/**
 * 获取一本书的缓存状态
 * P1-7：传入 profile 时按当前 voice/synthesisRate/source 统计音频覆盖率
 */
export async function getBookCacheStatus(bookId: string, profile?: TTSProfileFilter): Promise<BookCacheStatus | null> {
  try {
    const db = await getDB();
    const meta = await db.get('cacheMeta', bookId) as CacheMeta | undefined;
    if (!meta) return null;

    let currentProfileCoverage = meta.totalAudioSegments > 0 ? meta.cachedAudioSegments / meta.totalAudioSegments : 0;

    // 按当前 profile 精确统计
    if (profile) {
      const tx = db.transaction('ttsAudio', 'readonly');
      const audioStore = tx.objectStore('ttsAudio');
      const allAudio = await audioStore.index('bookId').getAll(bookId) as TTSAudioCache[];
      const profileKey = `${profile.voice}:${profile.synthesisRate}:${profile.source}`;
      const matched = allAudio.filter(a => a.key.includes(profileKey));
      currentProfileCoverage = meta.totalAudioSegments > 0 ? matched.length / meta.totalAudioSegments : 0;
    }

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
      currentProfileCoverage,
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
      currentProfileCoverage: meta.totalAudioSegments > 0 ? meta.cachedAudioSegments / meta.totalAudioSegments : 0,
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
  // ⓵ 用游标批量删除 bookChapters，避免大量逐条 delete
  {
    const tx = db.transaction('bookChapters', 'readwrite');
    const store = tx.objectStore('bookChapters');
    const index = store.index('bookId');
    let cursor = await index.openCursor(bookId);
    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  // ⓶ 单独事务更新元数据
  {
    const tx = db.transaction('cacheMeta', 'readwrite');
    const metaStore = tx.objectStore('cacheMeta');
    const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
    if (existingMeta) {
      existingMeta.cachedChapters = 0;
      existingMeta.lastCachedAt = Date.now();
      await metaStore.put(existingMeta);
    }
    await tx.done;
  }
}

/**
 * 清除一本书的 TTS 音频缓存（保留文字缓存）
 */
export async function clearBookTTSAudioCache(bookId: string): Promise<void> {
  const db = await getDB();
  // ⓵ 用游标批量删除 ttsAudio，不逐条 delete（大书可能有数千条分段，逐条极慢）
  {
    const tx = db.transaction('ttsAudio', 'readwrite');
    const store = tx.objectStore('ttsAudio');
    const index = store.index('bookId');
    let cursor = await index.openCursor(bookId);
    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
  // ⓶ 单独事务更新元数据（避免长时间占用写锁导致其他操作阻塞）
  {
    const tx = db.transaction('cacheMeta', 'readwrite');
    const metaStore = tx.objectStore('cacheMeta');
    const existingMeta = await metaStore.get(bookId) as CacheMeta | undefined;
    if (existingMeta) {
      existingMeta.cachedAudioSegments = 0;
      existingMeta.lastCachedAt = Date.now();
      await metaStore.put(existingMeta);
    }
    await tx.done;
  }
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
 * 清除一本书的所有缓存（章节内容 + TTS 音频 + 元数据）
 */
export async function clearBookCache(bookId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'ttsAudio', 'epubResources', 'epubArchives', 'cacheMeta'], 'readwrite');
  const chapterStore = tx.objectStore('bookChapters');
  const audioStore = tx.objectStore('ttsAudio');
  const resourceStore = tx.objectStore('epubResources');
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

  // 删除 EPUB 资源
  const resourceKeys = await resourceStore.index('bookId').getAllKeys(bookId);
  for (const key of resourceKeys) {
    await resourceStore.delete(key);
  }

  // 删除 EPUB 原始归档
  await tx.objectStore('epubArchives').delete(bookId);

  // 删除元数据
  await metaStore.delete(bookId);

  await tx.done;
}

/**
 * 清除所有缓存
 */
export async function clearAllCache(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['bookChapters', 'ttsAudio', 'epubResources', 'epubArchives', 'cacheMeta'], 'readwrite');
  await tx.objectStore('bookChapters').clear();
  await tx.objectStore('ttsAudio').clear();
  await tx.objectStore('epubResources').clear();
  await tx.objectStore('epubArchives').clear();
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
    const resources = await db.getAll('epubResources') as EpubResourceCache[];

    const chapterBytes = chapters.reduce((sum, c) => sum + new Blob([c.content]).size, 0);
    const audioBytes = audios.reduce((sum, a) => sum + a.audioData.byteLength, 0);
    const resourceBytes = resources.reduce((sum, resource) => sum + resource.data.byteLength, 0);

    return {
      chapterBytes: chapterBytes + resourceBytes,
      audioBytes,
      totalBytes: chapterBytes + resourceBytes + audioBytes,
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


/**
 * 批量下载一本书已预合成的 TTS 音频到 IndexedDB
 * 替代逐段 POST /api/tts，直接调用后端缓存下载接口
 * @returns 成功下载的段落数
 */
export async function downloadBatchCachedAudio(
  bookId: string,
  voice: string,
  synthesisRate: number,
  source: string,
  chapterSegments: Map<string, string[]>,
  onProgress?: (chapterId: string, segIdx: number) => void,
): Promise<number> {
  try {
    const res = await fetch(`/api/tts/batch-cache/${bookId}?voice=${encodeURIComponent(voice)}&speed=${synthesisRate}&source=${encodeURIComponent(source)}`, {
      headers: (() => {
        const headers: Record<string, string> = {};
        const token = localStorage.getItem('ireader_auth_token');
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
      })(),
    });
    if (!res.ok) return 0;
    const json = await res.json();
    if (!json.success || !json.data || json.data.length === 0) return 0;

    const segments: { chapterId: string; segIdx: number; audioUrl: string; text?: string }[] = json.data
      .filter((s: any) => s.chapterId && Number.isInteger(s.segmentIndex))
      .map((s: any) => ({
        chapterId: s.chapterId,
        audioUrl: s.audioUrl,
        segIdx: s.segmentIndex,
        text: chapterSegments.get(s.chapterId)?.[s.segmentIndex],
      }))
      .filter((s: { text?: string }) => Boolean(s.text));

    // 服务端返回明确 chapterId + segmentIndex，不再依赖数据库返回顺序猜测映射。

    // 并发下载所有段落（最大 6 并发）
    const MAX_DOWNLOAD = 6;
    let downloadedCount = 0;
    const totalSegs = segments.length;
    const audioItems: TTSAudioCacheInput[] = [];

    let i = 0;
    const next = async () => {
      while (i < segments.length) {
        const idx = i++;
        const seg = segments[idx];
        try {
          const url = seg.audioUrl;
          const audioRes = await fetch(url);
          if (audioRes.ok) {
            const arrayBuffer = await audioRes.arrayBuffer();
            const segIdx = seg.segIdx;
            audioItems.push({
              chapterId: seg.chapterId,
              segmentIndex: segIdx,
              audioData: arrayBuffer,
              identity: { voice, synthesisRate, source, text: seg.text! },
            });
            downloadedCount++;
            onProgress?.(seg.chapterId, segIdx);
          }
        } catch { /* 单段下载失败跳过 */ }
      }
    };

    const workers = Array.from({ length: Math.min(MAX_DOWNLOAD, totalSegs) }, () => next());
    await Promise.all(workers);

    // 批量写入 IndexedDB
    if (audioItems.length > 0) {
      await cacheTTSAudioBatch(bookId, audioItems);
    }

    return downloadedCount;
  } catch {
    return 0;
  }
}

// ==========================
// P1-8：离线下载事务（downloadSession）
// ==========================

export type DownloadSessionStatus = 'downloading' | 'ready' | 'failed';

export interface DownloadSession {
  sessionId: string;
  bookId: string;
  profileHash: string;
  totalItems: number;
  completedItems: number;
  completedKeys: string[];
  status: DownloadSessionStatus;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** 生成 profile hash（voice+synthesisRate+source） */
export function computeProfileHash(voice: string, synthesisRate: number, source: string): string {
  return `${voice}:${synthesisRate}:${source}`;
}

/** 创建或恢复下载 session */
export async function createOrResumeDownloadSession(
  bookId: string,
  profileHash: string,
  totalItems: number,
): Promise<DownloadSession> {
  const db = await getDB();
  const tx = db.transaction('downloadSessions', 'readwrite');
  const store = tx.objectStore('downloadSessions');
  const index = store.index('bookId');

  // 查找同 bookId + profileHash 的未完成 session
  let cursor = await index.openCursor(bookId);
  let existing: DownloadSession | null = null;
  while (cursor) {
    const s = cursor.value as DownloadSession;
    if (s.profileHash === profileHash && s.status === 'downloading') {
      existing = s;
      break;
    }
    cursor = await cursor.continue();
  }

  if (existing) {
    existing.totalItems = totalItems;
    existing.updatedAt = Date.now();
    await store.put(existing);
    await tx.done;
    return existing;
  }

  const session: DownloadSession = {
    sessionId: `${bookId}:${profileHash}:${Date.now()}`,
    bookId,
    profileHash,
    totalItems,
    completedItems: 0,
    completedKeys: [],
    status: 'downloading',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.put(session);
  await tx.done;
  return session;
}

/** 更新 session 进度（每批写入后调用） */
export async function updateDownloadSessionProgress(
  sessionId: string,
  newlyCompletedKeys: string[],
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction('downloadSessions', 'readwrite');
  const store = tx.objectStore('downloadSessions');
  const session = await store.get(sessionId) as DownloadSession | undefined;
  if (!session) { await tx.done; return; }

  session.completedKeys.push(...newlyCompletedKeys);
  session.completedItems = session.completedKeys.length;
  session.updatedAt = Date.now();

  if (session.completedItems >= session.totalItems) {
    session.status = 'ready';
  }
  await store.put(session);
  await tx.done;
}

/** 标记 session 失败（保留已完成项供续传） */
export async function failDownloadSession(sessionId: string, error: string): Promise<void> {
  const db = await getDB();
  const session = await db.get('downloadSessions', sessionId) as DownloadSession | undefined;
  if (!session) return;
  session.status = 'failed';
  session.error = error;
  session.updatedAt = Date.now();
  await db.put('downloadSessions', session);
}

/** 查询书籍的下载 session 状态 */
export async function getDownloadSession(bookId: string, profileHash: string): Promise<DownloadSession | null> {
  try {
    const db = await getDB();
    const tx = db.transaction('downloadSessions', 'readonly');
    const index = tx.objectStore('downloadSessions').index('bookId');
    let cursor = await index.openCursor(bookId);
    while (cursor) {
      const s = cursor.value as DownloadSession;
      if (s.profileHash === profileHash && (s.status === 'downloading' || s.status === 'ready')) {
        return s;
      }
      cursor = await cursor.continue();
    }
    return null;
  } catch {
    return null;
  }
}

/** 清理已完成/失败的旧 session（保留最近 1 个 ready） */
export async function cleanupDownloadSessions(bookId: string): Promise<void> {
  try {
    const db = await getDB();
    const tx = db.transaction('downloadSessions', 'readwrite');
    const store = tx.objectStore('downloadSessions');
    const index = store.index('bookId');
    const sessions: DownloadSession[] = [];
    let cursor = await index.openCursor(bookId);
    while (cursor) {
      sessions.push(cursor.value as DownloadSession);
      cursor = await cursor.continue();
    }
    const ready = sessions.filter(s => s.status === 'ready').sort((a, b) => b.updatedAt - a.updatedAt);
    const toDelete = sessions.filter(s => s.status === 'failed' || (s.status === 'ready' && s !== ready[0]));
    for (const s of toDelete) {
      await store.delete(s.sessionId);
    }
    await tx.done;
  } catch { /* 清理失败不阻塞 */ }
}