/**
 * useBookmarks — 书签管理（localStorage 持久化 + 云同步）
 *
 * 数据模型：BookmarkItem { id, cfi, excerpt, chapterHref?, globalPage?, createdAt }
 * 存储 key：ireader_bookmarks_{bookId}，列表按创建时间倒序（最新在前）。
 * toggle 语义：同 CFI 已存在则删除（移除书签），否则添加——对应顶栏书签按钮的切换行为。
 *
 * 云同步（后端 bookmarks API，见 backend/routes/bookmarks.ts）：
 *  - 挂载时若已登录：GET 拉取服务端书签合并进本地（避免换设备丢失）
 *  - 每次变更（toggle/remove/启动合并）后：PUT 全量推送
 *  - 离线/失败静默回退本地，不阻塞阅读
 */
import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { getToken } from '../services/authService';
import type { ReaderLocation } from './types';

export interface BookmarkItem {
  id: string;
  /** 书签锚点 CFI（断点定位用，唯一键） */
  cfi: string;
  /** 锚点处文本摘要（列表展示） */
  excerpt: string;
  /** 章节 href（列表展示/目录高亮用） */
  chapterHref?: string;
  /** 全局页码（locations 就绪时记录，列表展示） */
  globalPage?: number;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
}

export type BookmarkToggleResult = 'added' | 'removed' | null;

const keyOf = (bookId: string) => `ireader_bookmarks_${bookId}`;

/** 读取书签列表（损坏/缺失时返回空数组） */
export function loadBookmarks(bookId: string): BookmarkItem[] {
  try {
    const raw = localStorage.getItem(keyOf(bookId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(b => b && typeof b.cfi === 'string') : [];
  } catch {
    return [];
  }
}

/** 写入书签列表（同步、尽力而为） */
function saveBookmarks(bookId: string, items: BookmarkItem[]): void {
  try {
    localStorage.setItem(keyOf(bookId), JSON.stringify(items));
  } catch { /* 存储不可用时静默 */ }
}

function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 以 CFI 为键合并列表（服务端书签并入本地，不重复、不覆盖本地编辑） */
export function mergeBookmarks(local: BookmarkItem[], remote: BookmarkItem[]): BookmarkItem[] {
  const byCfi = new Map(local.map(b => [b.cfi, b]));
  for (const r of remote) {
    if (r?.cfi && !byCfi.has(r.cfi)) byCfi.set(r.cfi, r);
  }
  const merged = [...byCfi.values()];
  return merged.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export interface UseBookmarksResult {
  bookmarks: BookmarkItem[];
  /** 当前 CFI 是否已加书签（cfi 为空时恒 false） */
  isBookmarked: (cfi?: string) => boolean;
  /** 切换当前位置书签：已存在则删除，否则添加。无 CFI 时返回 null 不操作。 */
  toggle: (loc: ReaderLocation, excerpt?: string) => BookmarkToggleResult;
  /** 按 id 删除书签 */
  remove: (id: string) => void;
}

export function useBookmarks(bookId: string): UseBookmarksResult {
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(() => loadBookmarks(bookId));

  // 书籍切换时重载该书书签，并尝试从服务端拉取合并（云同步）
  useEffect(() => {
    let cancelled = false;
    const local = loadBookmarks(bookId);
    setBookmarks(local);
    const token = getToken();
    if (!token) return;
    axios.get(`/api/books/${bookId}/bookmarks`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    })
      .then(res => {
        if (cancelled) return;
        const remote = (res.data?.data || []) as BookmarkItem[];
        const merged = mergeBookmarks(local, remote);
        if (merged.length !== local.length) {
          setBookmarks(merged);
          saveBookmarks(bookId, merged);
          void pushBookmarks(bookId, merged);
        }
      })
      .catch(() => { /* 离线/失败静默：本地书签兜底 */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // 变更后推送服务端（离线静默）
  const pushBookmarks = useCallback((id: string, items: BookmarkItem[]) => {
    const token = getToken();
    if (!token) return;
    axios.put(`/api/books/${id}/bookmarks`, { bookmarks: items }, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    }).catch(() => { /* 离线/失败静默，下次启动合并兜底 */ });
  }, []);

  const isBookmarked = useCallback(
    (cfi?: string) => !!cfi && bookmarks.some(b => b.cfi === cfi),
    [bookmarks],
  );

  const toggle = useCallback(
    (loc: ReaderLocation, excerpt = ''): BookmarkToggleResult => {
      if (!loc.cfi) return null;
      const result: BookmarkToggleResult = bookmarks.some(b => b.cfi === loc.cfi) ? 'removed' : 'added';
      const item: BookmarkItem = {
        id: genId(),
        cfi: loc.cfi,
        excerpt,
        chapterHref: loc.chapterHref,
        globalPage: loc.globalPage,
        createdAt: new Date().toISOString(),
      };
      setBookmarks(prev => {
        const existing = prev.find(b => b.cfi === loc.cfi);
        const next = existing ? prev.filter(b => b.id !== existing.id) : [item, ...prev];
        saveBookmarks(bookId, next);
        pushBookmarks(bookId, next);
        return next;
      });
      return result;
    },
    [bookId, bookmarks, pushBookmarks],
  );

  const remove = useCallback(
    (id: string) => {
      setBookmarks(prev => {
        const next = prev.filter(b => b.id !== id);
        saveBookmarks(bookId, next);
        pushBookmarks(bookId, next);
        return next;
      });
    },
    [bookId, pushBookmarks],
  );

  return { bookmarks, isBookmarked, toggle, remove };
}
