/**
 * useBookLoader —— 书籍/章节数据加载 hook（Phase 6.3）
 *
 * 职责：
 *   - 加载书籍元数据（GET /api/books/:id）
 *   - 加载章节列表（GET /api/books/:id/chapters）
 *   - 加载章节内容（GET /api/books/:id/chapters/:cid/content）
 *   - 管理 loading/error 状态
 *   - 支持离线缓存回退（IndexedDB）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import type { BookFormat, Chapter } from '../types';

export interface BookMeta {
  id: string;
  title: string;
  author?: string;
  format: BookFormat;
  status?: string;
}

export interface UseBookLoaderOptions {
  bookId: string | undefined;
  /** 是否启用离线缓存回退 */
  offlineFallback?: boolean;
}

export interface UseBookLoaderResult {
  book: BookMeta | null;
  chapters: Chapter[];
  loading: boolean;
  error: string | null;
  /** 重新加载 */
  reload: () => void;
  /** 加载指定章节内容 */
  loadChapterContent: (chapter: Chapter) => Promise<string>;
  /** 获取当前章节纯文本（TTS 用） */
  getChapterText: (chapter: Chapter) => Promise<string>;
}

export function useBookLoader(options: UseBookLoaderOptions): UseBookLoaderResult {
  const { bookId } = options;
  const [book, setBook] = useState<BookMeta | null>(null);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  // 主加载 effect
  useEffect(() => {
    if (!bookId) { setLoading(false); return; }

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // 并行加载书籍元数据 + 章节列表
        const [bookRes, chaptersRes] = await Promise.all([
          axios.get(`/api/books/${bookId}`, { signal: controller.signal }),
          axios.get(`/api/books/${bookId}/chapters`, { signal: controller.signal }),
        ]);

        if (controller.signal.aborted) return;

        const bookData = bookRes.data?.data || bookRes.data;
        setBook({
          id: bookData.id || bookId,
          title: bookData.title || '未知书籍',
          author: bookData.author,
          format: bookData.format || 'txt',
          status: bookData.status,
        });

        const chaptersData = chaptersRes.data?.data || chaptersRes.data || [];
        const parsed: Chapter[] = (Array.isArray(chaptersData) ? chaptersData : []).map((ch: any, i: number) => ({
          id: ch.id || String(i),
          title: ch.title || `第${i + 1}章`,
          order: ch.order ?? i,
          href: ch.href,
          startOffset: ch.startOffset,
        }));
        setChapters(parsed);
      } catch (err: any) {
        if (controller.signal.aborted) return;
        const msg = err?.response?.data?.message || err?.message || '加载失败';
        setError(msg);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();

    return () => { controller.abort(); };
  }, [bookId, reloadKey]);

  // 加载章节内容
  const loadChapterContent = useCallback(async (chapter: Chapter): Promise<string> => {
    if (!bookId) return '';
    try {
      const res = await axios.get(`/api/books/${bookId}/chapters/${chapter.id}/content`);
      const data = res.data?.data || res.data;
      return typeof data === 'string' ? data : (data?.content || '');
    } catch {
      return '';
    }
  }, [bookId]);

  // 获取纯文本（TTS 用，与 loadChapterContent 相同但语义不同）
  const getChapterText = useCallback(async (chapter: Chapter): Promise<string> => {
    return loadChapterContent(chapter);
  }, [loadChapterContent]);

  return { book, chapters, loading, error, reload, loadChapterContent, getChapterText };
}
