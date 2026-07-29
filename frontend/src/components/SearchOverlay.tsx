/**
 * SearchOverlay — 全书搜索浮层（从 ReaderPage 提取）
 *
 * 双线程搜索架构：
 *   线程1：目录章节名匹配（同步，最高优先级）
 *   线程2：全文内容搜索（异步并发加载各章节后搜索）
 */
import { useState, useRef, useCallback, useEffect } from 'react';
import axios from 'axios';
import type { Chapter } from '../reader/types';
import { stripHtml } from '../reader/utils/stripHtml';

export interface SearchResult {
  index: number;
  text: string;
  offset: number;
  chapterIdx: number;
  chapterTitle: string;
  isChapterMatch: boolean;
}

export interface SearchOverlayProps {
  visible: boolean;
  onClose: () => void;
  chapters: Chapter[];
  bookId: string;
  bookFormat: 'epub' | 'txt';
  onJump: (result: SearchResult) => void;
  /** 从预加载缓存获取章节内容（避免重复请求） */
  getPreloadedContent?: (chapterId: string) => string | undefined;
}

export function SearchOverlay({ visible, onClose, chapters, bookId, bookFormat, onJump, getPreloadedContent }: SearchOverlayProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchActiveIdx, setSearchActiveIdx] = useState(-1);
  const [isSearchingFullBook, setIsSearchingFullBook] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fullBookTextCache = useRef<Map<string, { text: string; order: number }>>(new Map());
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchReqIdRef = useRef(0);

  // 打开时自动聚焦
  useEffect(() => {
    if (visible) setTimeout(() => searchInputRef.current?.focus(), 100);
  }, [visible]);

  // 关闭时重置
  useEffect(() => {
    if (!visible) { setSearchQuery(''); setSearchResults([]); setSearchActiveIdx(-1); }
  }, [visible]);

  // 卸载清理
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);

  /** 线程1：目录章节名匹配 */
  const searchChapterTitles = useCallback((_query: string, lowerQuery: string): SearchResult[] => {
    const results: SearchResult[] = [];
    let matchIdx = 0;
    for (let ci = 0; ci < chapters.length; ci++) {
      const ch = chapters[ci];
      if (ch.title.toLowerCase().includes(lowerQuery)) {
        results.push({ index: matchIdx++, text: ch.title, offset: 0, chapterIdx: ci, chapterTitle: ch.title, isChapterMatch: true });
      }
    }
    return results;
  }, [chapters]);

  /** 线程2：全文内容搜索 */
  const searchFullText = useCallback(async (query: string, lowerQuery: string, reqId: number): Promise<SearchResult[]> => {
    const cache = fullBookTextCache.current;
    const uncached = chapters.filter(ch => !cache.has(ch.id));
    if (uncached.length > 0) {
      setIsSearchingFullBook(true);
      try {
        const BATCH_SIZE = 5;
        for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
          if (searchReqIdRef.current !== reqId) return [];
          const batch = uncached.slice(i, i + BATCH_SIZE);
          await Promise.all(batch.map(async (ch) => {
            if (cache.has(ch.id)) return;
            const preloaded = getPreloadedContent?.(ch.id);
            let content: string;
            if (preloaded) {
              content = preloaded;
            } else {
              try {
                const res = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`, { timeout: 30000 });
                content = res.data.data?.content || '';
                if (bookFormat === 'epub') content = stripHtml(content);
              } catch { content = ''; }
            }
            cache.set(ch.id, { text: content, order: ch.order });
          }));
        }
      } finally {
        if (searchReqIdRef.current === reqId) setIsSearchingFullBook(false);
      }
    }
    if (searchReqIdRef.current !== reqId) return [];

    const results: SearchResult[] = [];
    let matchIdx = 0;
    for (let ci = 0; ci < chapters.length && matchIdx < 20; ci++) {
      const ch = chapters[ci];
      const cached = cache.get(ch.id);
      if (!cached || !cached.text) continue;
      const lowerContent = cached.text.toLowerCase();
      let searchPos = 0;
      while (matchIdx < 20) {
        const pos = lowerContent.indexOf(lowerQuery, searchPos);
        if (pos === -1) break;
        const start = Math.max(0, pos - 20);
        const end = Math.min(cached.text.length, pos + query.length + 20);
        let context = cached.text.slice(start, end);
        if (start > 0) context = '…' + context;
        if (end < cached.text.length) context = context + '…';
        results.push({ index: matchIdx, text: context, offset: pos, chapterIdx: ci, chapterTitle: ch.title, isChapterMatch: false });
        searchPos = pos + query.length;
        matchIdx++;
      }
    }
    return results;
  }, [chapters, bookId, bookFormat, getPreloadedContent]);

  /** 合并搜索入口 */
  const performSearch = useCallback(async (query: string) => {
    const reqId = ++searchReqIdRef.current;
    if (!query) { setSearchResults([]); setSearchActiveIdx(-1); return; }
    const lowerQuery = query.toLowerCase();
    const titleResults = searchChapterTitles(query, lowerQuery);
    setSearchResults(titleResults);
    setSearchActiveIdx(titleResults.length > 0 ? 0 : -1);
    searchFullText(query, lowerQuery, reqId).then((textResults) => {
      if (searchReqIdRef.current !== reqId) return;
      const titleChapterIdxSet = new Set(titleResults.map(r => r.chapterIdx));
      const filtered = textResults.filter(r => !titleChapterIdxSet.has(r.chapterIdx));
      const merged = [...titleResults];
      for (const tr of filtered) { tr.index = merged.length; merged.push(tr); }
      setSearchResults(merged);
      if (merged.length > 0) setSearchActiveIdx(prev => prev < 0 ? 0 : prev);
    });
  }, [searchChapterTitles, searchFullText]);

  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center pt-16" onClick={onClose}>
      <div className="bg-ios-bg-card rounded-xl shadow-2xl border border-ios-border w-full max-w-lg mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* 搜索输入框 */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-ios-border">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ios-text-muted"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => {
              const val = e.target.value;
              setSearchQuery(val);
              if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
              if (!val) { setSearchResults([]); setSearchActiveIdx(-1); return; }
              searchTimerRef.current = setTimeout(() => performSearch(val), 400);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchResults.length > 0) onJump(searchResults[0]);
              if (e.key === 'Escape') onClose();
            }}
            placeholder="搜索全书…"
            className="flex-1 bg-transparent outline-none text-sm py-1.5 text-ios-text placeholder-ios-text-muted"
            autoFocus
          />
          <button onClick={onClose} className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-ios-bg-alt text-ios-text-muted">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        {/* 搜索结果列表 */}
        <div className="max-h-64 overflow-y-auto">
          {searchQuery && isSearchingFullBook && searchResults.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ios-text-muted"><span className="animate-pulse">正在搜索全书…</span></div>
          )}
          {searchQuery && !isSearchingFullBook && searchResults.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ios-text-muted">未找到匹配结果</div>
          )}
          {searchResults.some(r => r.isChapterMatch) && searchResults.some(r => !r.isChapterMatch) && (
            <div className="px-3 py-1.5 text-xs font-semibold text-ios-primary bg-ios-primary-subtle border-b border-ios-primary">📖 章节匹配（最高优先级）</div>
          )}
          {searchResults.map((result, i) => (
            <button
              key={i}
              onClick={() => onJump(result)}
              className={`w-full text-left px-4 py-2.5 text-sm border-b border-ios-border last:border-b-0 hover:bg-ios-primary-subtle transition-colors duration-150 ${searchActiveIdx === i ? 'bg-ios-primary-subtle' : ''}`}
            >
              <span className="block text-xs text-ios-text-muted mb-0.5">
                {result.isChapterMatch ? (
                  <span className="inline-flex items-center gap-1">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ios-primary"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                    章节匹配
                  </span>
                ) : (<>匹配 {i + 1}</>)}
                {result.chapterTitle && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-ios-bg-alt text-ios-text-muted">{result.chapterTitle}</span>
                )}
              </span>
              {result.isChapterMatch ? (
                <span className="text-ios-primary font-medium">{result.chapterTitle}</span>
              ) : (
                <span className="text-ios-text-secondary leading-relaxed" dangerouslySetInnerHTML={{
                  __html: result.text.replace(
                    new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'),
                    '<mark class="bg-ios-warning-subtle text-ios-text rounded px-0.5">$1</mark>'
                  )
                }} />
              )}
            </button>
          ))}
          {searchQuery && isSearchingFullBook && searchResults.length > 0 && (
            <div className="px-3 py-2 text-xs text-center text-ios-text-muted border-t border-ios-border"><span className="animate-pulse">正在深入搜索全文内容…</span></div>
          )}
        </div>
        {searchResults.length > 0 && !isSearchingFullBook && (
          <div className="px-4 py-2 text-xs text-ios-text-muted border-t border-ios-border text-center">共 {searchResults.length} 个匹配结果，点击跳转</div>
        )}
      </div>
    </div>
  );
}
