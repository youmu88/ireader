/**
 * offlineCacheService 单元测试
 * 使用 fakeIndexedDB 模拟 IndexedDB 环境
 *
 * 注意：fake-indexeddb/auto 必须在任何模块导入前加载，
 * 因此放在文件顶部，测试文件中直接 import 而非通过 setup 文件引入。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  cacheBookChapters,
  cacheSingleChapter,
  getCachedChapterContent,
  getCachedChapters,
  cacheTTSAudio,
  getCachedTTSAudio,
  getBookCacheStatus,
  getAllCachedBookIds,
  clearBookCache,
  clearAllCache,
  estimateCacheSize,
} from '../offlineCacheService';

const BOOK_ID = 'test-book-1';
const BOOK_TITLE = '测试图书';

describe('offlineCacheService', () => {
  // 每个测试后清理缓存（避免交叉污染）
  afterEach(async () => {
    await clearAllCache();
  });

  describe('书籍章节缓存', () => {
    const chapters = [
      { chapterId: 'ch1', title: '第一章', order: 1, content: '第一章的内容...' },
      { chapterId: 'ch2', title: '第二章', order: 2, content: '第二章的内容...' },
      { chapterId: 'ch3', title: '第三章', order: 3, content: '第三章的内容...' },
    ];

    it('应能批量缓存章节内容', async () => {
      const result = await cacheBookChapters(BOOK_ID, BOOK_TITLE, chapters);
      expect(result.cached).toBe(3);
      expect(result.total).toBe(3);
    });

    it('应能获取缓存的章节内容', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, chapters);
      const content = await getCachedChapterContent(BOOK_ID, 'ch1');
      expect(content).toBe('第一章的内容...');
    });

    it('不存在的章节应返回 null', async () => {
      const content = await getCachedChapterContent(BOOK_ID, 'nonexistent');
      expect(content).toBeNull();
    });

    it('应能获取所有缓存的章节列表', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, chapters);
      const cached = await getCachedChapters(BOOK_ID);
      expect(cached).toHaveLength(3);
      expect(cached[0].chapterId).toBe('ch1');
      expect(cached[1].chapterId).toBe('ch2');
      expect(cached[2].chapterId).toBe('ch3');
    });

    it('应能缓存单个章节', async () => {
      await cacheSingleChapter(BOOK_ID, BOOK_TITLE, chapters[0]);
      const content = await getCachedChapterContent(BOOK_ID, 'ch1');
      expect(content).toBe('第一章的内容...');
    });

    it('应正确报告缓存状态', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, chapters);
      const status = await getBookCacheStatus(BOOK_ID);
      expect(status).not.toBeNull();
      expect(status!.bookTitle).toBe(BOOK_TITLE);
      expect(status!.cachedChapters).toBe(3);
      expect(status!.totalChapters).toBe(3);
      expect(status!.isFullyCached).toBe(true);
      expect(status!.chapterCacheProgress).toBe(1);
    });
  });

  describe('TTS 音频缓存', () => {
    it('应能缓存和获取 TTS 音频', async () => {
      // 先缓存章节（缓存元数据依赖它）
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);

      const audioData = new ArrayBuffer(1024);
      await cacheTTSAudio(BOOK_ID, 'ch1', 0, audioData, 3.5);

      // 验证缓存元数据中包含音频条目
      const status = await getBookCacheStatus(BOOK_ID);
      expect(status).not.toBeNull();
      expect(status!.cachedAudioSegments).toBeGreaterThanOrEqual(1);
      expect(status!.lastCachedAt).toBeGreaterThan(0);

      // 获取缓存的书籍 ID 列表验证包含此书
      const allCached = await getAllCachedBookIds();
      expect(allCached).toContain(BOOK_ID);
    });

    it('不存在的音频应返回 null', async () => {
      const audio = await getCachedTTSAudio(BOOK_ID, 'ch1', 999);
      expect(audio).toBeNull();
    });

    it('应按文本和语音配置隔离本地音频缓存', async () => {
      const identity = { voice: 'voice-a', synthesisRate: 1, source: 'edgetts', text: '第一段正文。' };
      await cacheTTSAudio(BOOK_ID, 'ch1', 0, new Uint8Array([1, 2, 3]).buffer, undefined, identity);

      expect(await getCachedTTSAudio(BOOK_ID, 'ch1', 0, identity)).not.toBeNull();
      expect(await getCachedTTSAudio(BOOK_ID, 'ch1', 0, { ...identity, voice: 'voice-b' })).toBeNull();
      expect(await getCachedTTSAudio(BOOK_ID, 'ch1', 0, { ...identity, synthesisRate: 1.25 })).toBeNull();
      expect(await getCachedTTSAudio(BOOK_ID, 'ch1', 0, { ...identity, text: '正文已修改。' })).toBeNull();
    });
  });

  describe('缓存元数据', () => {
    it('应能获取所有已缓存书籍 ID', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);
      await cacheBookChapters('test-book-2', '第二本书', [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);

      const ids = await getAllCachedBookIds();
      expect(ids).toContain(BOOK_ID);
      expect(ids).toContain('test-book-2');
    });
  });

  describe('缓存清理', () => {
    it('应能清除单本书的缓存', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);

      await clearBookCache(BOOK_ID);

      const status = await getBookCacheStatus(BOOK_ID);
      expect(status).toBeNull();
      const content = await getCachedChapterContent(BOOK_ID, 'ch1');
      expect(content).toBeNull();
    });

    it('应能清除所有缓存', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);
      await cacheBookChapters('test-book-2', '第二本书', [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '内容' },
      ]);

      await clearAllCache();

      const ids = await getAllCachedBookIds();
      expect(ids).toHaveLength(0);
    });
  });

  describe('缓存大小估算', () => {
    it('应返回缓存大小信息', async () => {
      await cacheBookChapters(BOOK_ID, BOOK_TITLE, [
        { chapterId: 'ch1', title: '第一章', order: 1, content: '测试内容' },
      ]);
      const size = await estimateCacheSize();
      expect(size.chapterBytes).toBeGreaterThan(0);
      expect(size.totalBytes).toBeGreaterThan(0);
    });
  });
});