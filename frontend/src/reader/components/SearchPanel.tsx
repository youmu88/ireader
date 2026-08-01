/**
 * SearchPanel — 全书搜索面板（Apple Books 风格全屏覆盖层）
 *
 * 顶部搜索栏（输入防抖 300ms 即输即搜）+ 结果列表（命中词 <mark> 高亮 + 章节标题）。
 * 始终渲染，open 控制透明度/指针；关闭时清空查询并通知上层清结果。
 */
import { useEffect, useState } from 'react';
import type { SearchResult } from '../searchBook';
import { Button } from '../../components/ui/Button';
import { IconButton } from '../../components/ui/IconButton';

export interface SearchPanelProps {
  open: boolean;
  chromeBackground: string;
  chromeColor: string;
  searching: boolean;
  results: SearchResult[];
  onSearch: (query: string) => void;
  onSelect: (result: SearchResult) => void;
  onClose: () => void;
  /** 章节标题反查（可选；返回 undefined 时显示原始 href） */
  chapterLabelOf?: (href: string) => string | undefined;
}

/** 摘要中命中词高亮渲染（大小写不敏感分段） */
export function HighlightedExcerpt({ excerpt, query }: { excerpt: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{excerpt}</>;
  const lower = excerpt.toLowerCase();
  const segments: { text: string; match: boolean }[] = [];
  let i = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > i) segments.push({ text: excerpt.slice(i, idx), match: false });
    segments.push({ text: excerpt.slice(idx, idx + q.length), match: true });
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < excerpt.length) segments.push({ text: excerpt.slice(i), match: false });
  return (
    <>
      {segments.map((s, k) =>
        s.match ? (
          <mark key={k} className="bg-yellow-300/70 text-inherit rounded-sm px-0.5">{s.text}</mark>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

export function SearchPanel({
  open,
  chromeBackground,
  chromeColor,
  searching,
  results,
  onSearch,
  onSelect,
  onClose,
  chapterLabelOf,
}: SearchPanelProps) {
  const [query, setQuery] = useState('');

  // 打开/关闭时重置输入
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  // 输入防抖 300ms 触发搜索
  useEffect(() => {
    const t = setTimeout(() => onSearch(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query, onSearch]);

  const handleClose = () => {
    setQuery('');
    onSearch('');
    onClose();
  };

  return (
    <div
      data-testid="search-panel"
      className={`fixed inset-0 z-40 transition-opacity duration-200 ${
        open ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 flex flex-col" style={{ background: chromeBackground, color: chromeColor }}>
        {/* 搜索栏 */}
        <div className="flex items-center gap-2 px-3 h-14 shrink-0 border-b" style={{ borderColor: 'rgba(128,128,128,0.25)' }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" style={{ opacity: 0.5 }}>
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索全书"
            aria-label="搜索全书"
            className="flex-1 bg-transparent outline-none text-[16px] placeholder:opacity-40"
          />
          {query && (
            <IconButton variant="ghost" onClick={() => setQuery('')} aria-label="清空搜索" className="!w-auto !h-auto !p-1.5 !rounded-full !text-current active:opacity-40" style={{ opacity: 0.5 }}>
              &times;
            </IconButton>
          )}
          <Button variant="ghost" onClick={handleClose} className="!h-auto !px-1 !rounded-none !text-current text-[15px] text-blue-500 active:opacity-40">
            取消
          </Button>
        </div>

        {/* 结果区 */}
        <div className="flex-1 overflow-y-auto">
          {!query && (
            <p className="px-5 py-10 text-sm text-center" style={{ opacity: 0.5 }}>输入关键词搜索全书内容</p>
          )}
          {query && searching && (
            <p className="px-5 py-10 text-sm text-center" style={{ opacity: 0.5 }}>搜索中…</p>
          )}
          {query && !searching && results.length === 0 && (
            <p className="px-5 py-10 text-sm text-center" style={{ opacity: 0.5 }}>未找到「{query}」</p>
          )}
          {query && !searching && results.map((r, i) => (
            <Button
              key={`${r.cfi}-${i}`}
              variant="ghost"
              onClick={() => onSelect(r)}
              className="!w-full !justify-start !h-auto !rounded-none !px-5 !py-3 border-b !text-current active:opacity-40 transition-opacity"
              style={{ borderColor: 'rgba(128,128,128,0.15)' }}
            >
              <p className="text-[15px] leading-relaxed">
                <HighlightedExcerpt excerpt={r.excerpt} query={query} />
              </p>
              <p className="text-xs mt-1" style={{ opacity: 0.5 }}>
                {chapterLabelOf?.(r.chapterHref) ?? r.chapterHref}
              </p>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
