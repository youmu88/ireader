/**
 * ReaderPage — Apple Books 风格 EPUB 阅读页
 *
 * 组装：书籍加载（离线包优先）→ EpubBookController → 点按层 / Chrome / 面板。
 * 交互：点按左右 1/4 翻页（带滑动动画），点按中央显隐工具栏；
 *       TXT 书籍显示暂不支持提示；翻页动画加在包装层，不重建 epub iframe。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { EpubBookController, type TxtFeedSectionInput } from '../reader/EpubBookController';
import { READER_THEMES } from '../reader/theme';
import type { ReaderLocation, TocItem } from '../reader/types';
import { useReaderSettings } from '../reader/useReaderSettings';
import { useReaderProgress } from '../reader/useReaderProgress';
import { useBookmarks, type BookmarkItem } from '../reader/useBookmarks';
import { ReaderChrome } from '../reader/components/ReaderChrome';
import { ReaderTopBar } from '../reader/components/ReaderTopBar';
import { ReaderBottomBar } from '../reader/components/ReaderBottomBar';
import { FontSettingsPanel } from '../reader/components/FontSettingsPanel';
import { TocPanel } from '../reader/components/TocPanel';
import { SearchPanel } from '../reader/components/SearchPanel';
import type { SearchResult } from '../reader/searchBook';
import { getCachedEpubArchive } from '../services/offlineCacheService';
import { getToken } from '../services/authService';
import { Button, toast } from '../components/ui';

interface BookMeta {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
}

/** 目录树递归反查章节标题（搜索结果归属展示；href 去 fragment 匹配） */
function findTocLabel(items: TocItem[], href: string): string | undefined {
  for (const item of items) {
    if (item.href === href || item.href.split('#')[0] === href) return item.label;
    const sub = findTocLabel(item.subitems ?? [], href);
    if (sub) return sub;
  }
  return undefined;
}

export default function ReaderPage() {
  const { bookId = '' } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [book, setBook] = useState<BookMeta | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [location, setLocation] = useState<ReaderLocation | null>(null);
  const [locationsReady, setLocationsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [fontOpen, setFontOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerWrapRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EpubBookController | null>(null);
  const turnDirRef = useRef<'next' | 'prev' | null>(null);
  const [turnAnim, setTurnAnim] = useState<{ dir: 'next' | 'prev'; seq: number } | null>(null);

  const { settings, updateSettings } = useReaderSettings();
  const { loadInitialCfi, scheduleSave } = useReaderProgress({ bookId });
  const { bookmarks, isBookmarked, toggle: toggleBookmark, remove: removeBookmark } = useBookmarks(bookId);
  const themeSpec = READER_THEMES[settings.theme];

  // ── 加载书籍并初始化渲染 ──
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    const controller = new EpubBookController();
    controllerRef.current = controller;

    (async () => {
      const res = await axios.get(`/api/books/${bookId}`);
      const meta = res.data?.data as BookMeta | null;
      if (!meta) throw new Error('书籍不存在');
      if (cancelled) return;
      setBook(meta);

      // TXT/EPUB 共用：设置目录，绑定位置监听（驱动位置+翻页动画），异步生成全局页码
      const attachReader = (tocItems?: TocItem[]) => {
        if (tocItems) setToc(tocItems);
        setLoading(false);
        controller.onLocationChange(loc => {
          setLocation(loc);
          scheduleSave(loc);
          if (turnDirRef.current) {
            setTurnAnim({ dir: turnDirRef.current, seq: Date.now() });
            turnDirRef.current = null;
          }
        });
        void controller.generateLocations().then(() => {
          if (!cancelled) setLocationsReady(true);
        });
      };

      if (meta.format === 'txt') {
        // TXT：拉取章节清单 → 逐章取正文 → 以 HTML Feed 渲染（复用全套阅读管线）
        const chaptersRes = await axios.get(`/api/books/${bookId}/chapters`);
        const chapters: { id: string; title: string; href: string | null }[] = chaptersRes.data?.data || [];
        const initialCfiTxt = await loadInitialCfi();
        const feedInputs: TxtFeedSectionInput[] = [];
        for (const ch of chapters) {
          const contentRes = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`);
          const raw = contentRes.data?.data;
          const text = typeof raw === 'string' ? raw : raw?.text ?? raw?.content ?? '';
          feedInputs.push({ id: ch.id, title: ch.title || `第${feedInputs.length + 1}部分`, text: String(text) });
        }
        const tocItemsTxt = await controller.loadTxt(feedInputs, viewerRef.current!, {
          initialCfi: initialCfiTxt,
          settings,
        });
        if (cancelled) return;
        attachReader(tocItemsTxt);
        return;
      }

      if (meta.format !== 'epub') {
        setError('该书籍格式暂不支持');
        setLoading(false);
        return;
      }

      const initialCfi = await loadInitialCfi();
      // 离线包优先：有本地 epub 归档直接用 ArrayBuffer，避免网络请求
      const archive = await getCachedEpubArchive(bookId).catch(() => undefined);
      const source: string | ArrayBuffer = archive?.data ?? `/api/books/${bookId}/file`;
      const token = getToken();
      const requestHeaders = typeof source === 'string' && token
        ? { Authorization: `Bearer ${token}` }
        : undefined;

      const tocItems = await controller.load(source, viewerRef.current!, {
        initialCfi,
        requestHeaders,
        settings,
      });
      if (cancelled) return;
      // 注册位置监听 + 页码生成（TXT/EPUB 共用）
      setToc(tocItems);
      attachReader();
    })().catch(err => {
      if (cancelled) return;
      console.error('书籍加载失败:', err);
      setError('书籍加载失败，请稍后重试');
      setLoading(false);
    });

    return () => {
      cancelled = true;
      controller.destroy();
      controllerRef.current = null;
    };
    // 仅随书籍切换重建；settings 初始值在 load 时传入，后续由下方 effect 实时应用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ── 设置变化实时应用到 rendition（不重建 DOM） ──
  useEffect(() => {
    controllerRef.current?.applySettings(settings);
  }, [settings]);

  // ── 滚动模式切换：rendition.flow 实时切换，自动回到相近位置 ──
  useEffect(() => {
    controllerRef.current?.setFlow(settings.scrollMode);
  }, [settings.scrollMode]);

  // ── 翻页滑动动画：relocated 后触发，操作包装层 style，不重建 epub 容器 ──
  useEffect(() => {
    const el = viewerWrapRef.current;
    if (!el || !turnAnim) return;
    el.style.animation = 'none';
    void el.offsetWidth; // 强制 reflow 以重启动画
    el.style.animation = `${turnAnim.dir === 'next' ? 'reader-page-next' : 'reader-page-prev'} 0.28s ease-out`;
  }, [turnAnim]);

  const handlePrev = useCallback(() => {
    turnDirRef.current = 'prev';
    void controllerRef.current?.prev();
  }, []);

  const handleNext = useCallback(() => {
    turnDirRef.current = 'next';
    void controllerRef.current?.next();
  }, []);

  const handleTocSelect = useCallback((href: string) => {
    setTocOpen(false);
    void controllerRef.current?.goTo(href);
  }, []);

  const handleSeek = useCallback((percentage: number) => {
    controllerRef.current?.goToPercentage(percentage);
  }, []);

  // ── 书签：切换当前页书签（提取摘要 → toggle → toast 反馈） ──
  const handleToggleBookmark = useCallback(async () => {
    const loc = controllerRef.current?.currentLocation;
    if (!loc) return;
    const excerpt = (await controllerRef.current?.getExcerptAt(loc.cfi)) ?? '';
    const result = toggleBookmark(loc, excerpt);
    if (result === 'added') toast.success('已添加书签');
    else if (result === 'removed') toast.success('已移除书签');
  }, [toggleBookmark]);

  const handleSelectBookmark = useCallback((item: BookmarkItem) => {
    setTocOpen(false);
    void controllerRef.current?.goTo(item.cfi);
  }, []);

  // ── 全书搜索：空查询清结果；seq 防竞态（旧搜索结果被新搜索覆盖时丢弃） ──
  const searchSeqRef = useRef(0);
  const handleSearch = useCallback(async (query: string) => {
    const seq = ++searchSeqRef.current;
    if (!query.trim()) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    try {
      const results = (await controllerRef.current?.search(query)) ?? [];
      if (searchSeqRef.current === seq) setSearchResults(results);
    } finally {
      if (searchSeqRef.current === seq) setSearching(false);
    }
  }, []);

  const handleSelectSearchResult = useCallback((result: SearchResult) => {
    setSearchOpen(false);
    void controllerRef.current?.goTo(result.cfi);
  }, []);

  // ── 错误态（含 TXT 暂不支持提示） ──
  if (error) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-5 bg-ios-bg px-8">
        <p className="text-ios-text text-center leading-relaxed">{error}</p>
        <Button variant="secondary" onClick={() => navigate('/')}>返回书库</Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: themeSpec.background, perspective: '1600px' }}>
      {/* epub.js 渲染区（翻页动画作用于包装层，不重建内部 iframe） */}
      <div ref={viewerWrapRef} className="absolute inset-0">
        <div ref={viewerRef} className="absolute inset-0" />
      </div>

      {loading && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center"
          style={{ background: themeSpec.background, color: themeSpec.color }}
        >
          <div className="text-center">
            <div
              className="animate-spin rounded-full h-8 w-8 border-b-2 mx-auto mb-4"
              style={{ borderColor: themeSpec.color }}
            />
            <p className="text-sm" style={{ opacity: 0.6 }}>正在打开书籍…</p>
          </div>
        </div>
      )}

      {/* 点按层：左 1/4 上一页 · 中央显隐工具栏 · 右 1/4 下一页（滚动模式下禁用左右翻页区） */}
      {!loading && (
        <div className="absolute inset-0 z-10 flex" data-testid="tap-zones">
          {!settings.scrollMode && (
            <button className="w-1/4 h-full" onClick={handlePrev} aria-label="上一页" />
          )}
          <button className="flex-1 h-full" onClick={() => setChromeVisible(v => !v)} aria-label="显示或隐藏工具栏" />
          {!settings.scrollMode && (
            <button className="w-1/4 h-full" onClick={handleNext} aria-label="下一页" />
          )}
        </div>
      )}

      <ReaderChrome
        visible={chromeVisible}
        top={
          <ReaderTopBar
            title={book?.title ?? ''}
            chromeBackground={themeSpec.chromeBackground}
            chromeColor={themeSpec.chromeColor}
            onBack={() => navigate('/')}
            onOpenToc={() => setTocOpen(true)}
            onOpenFontSettings={() => setFontOpen(true)}
            bookmarked={isBookmarked(location?.cfi)}
            onToggleBookmark={handleToggleBookmark}
            onOpenSearch={() => setSearchOpen(true)}
          />
        }
        bottom={
          <ReaderBottomBar
            location={location}
            locationsReady={locationsReady}
            chromeBackground={themeSpec.chromeBackground}
            chromeColor={themeSpec.chromeColor}
            onSeek={handleSeek}
          />
        }
      />

      <TocPanel
        open={tocOpen}
        toc={toc}
        currentHref={location?.chapterHref}
        chromeBackground={themeSpec.chromeBackground}
        chromeColor={themeSpec.chromeColor}
        onSelect={handleTocSelect}
        onClose={() => setTocOpen(false)}
        bookmarks={bookmarks}
        onSelectBookmark={handleSelectBookmark}
        onRemoveBookmark={removeBookmark}
      />
      <FontSettingsPanel
        open={fontOpen}
        settings={settings}
        chromeBackground={themeSpec.chromeBackground}
        chromeColor={themeSpec.chromeColor}
        onChange={updateSettings}
        onClose={() => setFontOpen(false)}
      />
      <SearchPanel
        open={searchOpen}
        chromeBackground={themeSpec.chromeBackground}
        chromeColor={themeSpec.chromeColor}
        searching={searching}
        results={searchResults}
        onSearch={handleSearch}
        onSelect={handleSelectSearchResult}
        onClose={() => setSearchOpen(false)}
        chapterLabelOf={href => findTocLabel(toc, href)}
      />
    </div>
  );
}
