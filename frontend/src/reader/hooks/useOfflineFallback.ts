/**
 * useOfflineFallback —— 离线降级 hook（Phase 6.3d）
 *
 * 职责：
 *   - 判断当前是否离线
 *   - 从 IndexedDB 缓存读取书籍信息和章节列表
 *   - 作为 useBookLoader 的降级数据源
 */
import { useCallback } from 'react';
import { getOfflineBookInfo, getCachedChapters } from '../../services/offlineCacheService';
import type { BookFormat, Chapter } from '../types';

export interface OfflineBookData {
  book: { id: string; title: string; author?: string; format: BookFormat } | null;
  chapters: Chapter[];
}

export interface UseOfflineFallbackResult {
  /** 判断是否离线 */
  isOffline: (isOfflineMode: boolean) => boolean;
  /** 从 IndexedDB 加载离线数据 */
  loadOffline: (bookId: string) => Promise<OfflineBookData>;
}

export function useOfflineFallback(): UseOfflineFallbackResult {
  const isOffline = useCallback((isOfflineMode: boolean): boolean => {
    return isOfflineMode || (typeof navigator !== 'undefined' && navigator.onLine === false);
  }, []);

  const loadOffline = useCallback(async (bookId: string): Promise<OfflineBookData> => {
    try {
      const [offlineBook, offlineChapters] = await Promise.all([
        getOfflineBookInfo(bookId),
        getCachedChapters(bookId),
      ]);

      const book = offlineBook ? {
        id: bookId,
        title: (offlineBook as any).title || '未知书籍',
        author: (offlineBook as any).author,
        format: ((offlineBook as any).format || 'txt') as BookFormat,
      } : null;

      const chapters: Chapter[] = offlineChapters.map((c: any) => ({
        id: c.chapterId,
        title: c.title,
        order: c.order,
      }));

      return { book, chapters };
    } catch {
      return { book: null, chapters: [] };
    }
  }, []);

  return { isOffline, loadOffline };
}
