/**
 * ReaderPage — Apple Books 风格 EPUB 阅读页（垂直滚动模式）
 *
 * 组装：书籍加载（离线包优先）→ EpubBookController → 底栏 Chrome / 面板。
 * 交互：正文垂直滚动阅读（滚动容器上无覆盖层，滚动手势直达）；点按正文（epub.js click 桥接）显隐底栏；
 *       TXT 书籍复用同一渲染管线（HTML Feed）。
 * 2.51.0：菜单精简为 目录|书名|搜索·aA（返回书架靠系统手势/浏览器后退；书签功能整体下线）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';
import { EpubBookController, type TxtFeedSectionInput } from '../reader/EpubBookController';
import { READER_THEMES } from '../reader/theme';
import type { ReaderLocation, TocItem } from '../reader/types';
import { useReaderSettings } from '../reader/useReaderSettings';
import { useReaderProgress } from '../reader/useReaderProgress';
import { ReaderChrome } from '../reader/components/ReaderChrome';
import { ReaderMenuBar } from '../reader/components/ReaderMenuBar';
import { ReaderBottomBar } from '../reader/components/ReaderBottomBar';
import { FontSettingsPanel } from '../reader/components/FontSettingsPanel';
import { TocPanel } from '../reader/components/TocPanel';
import { SearchPanel } from '../reader/components/SearchPanel';
import type { SearchResult } from '../reader/searchBook';
import { getCachedEpubArchive } from '../services/offlineCacheService';
import { getToken } from '../services/authService';
import { Button } from '../components/ui';

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

/** 为 Promise 加超时兜底：超时 reject，避免 loading 永不结束（根因见 useReaderProgress 注释） */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`加载超时(${label}>${ms}ms)`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
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
  const controllerRef = useRef<EpubBookController | null>(null);

  const { settings, updateSettings } = useReaderSettings();
  const { loadInitialCfi, scheduleSave } = useReaderProgress({ bookId });
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
        });
        // 正文点按（epub.js 桥接 iframe 内 click）→ 显隐底栏；不叠加覆盖层，滚动手势直达
        controller.onTap(() => setChromeVisible(v => !v));
        void controller.generateLocations().then(() => {
          if (!cancelled) setLocationsReady(true);
        });
      };

      if (meta.format === 'txt') {
        // TXT：拉取章节清单 → 逐章取正文 → 以 HTML Feed 渲染（复用全套阅读管线）
        const chaptersRes = await axios.get(`/api/books/${bookId}/chapters`, { timeout: 15000 });
        const chapters: { id: string; title: string; href: string | null }[] = chaptersRes.data?.data || [];
        const initialCfiTxt = await loadInitialCfi();
        const feedInputs: TxtFeedSectionInput[] = [];
        for (const ch of chapters) {
          const contentRes = await axios.get(`/api/books/${bookId}/chapters/${ch.id}/content`, { timeout: 15000 });
          const raw = contentRes.data?.data;
          const text = typeof raw === 'string' ? raw : raw?.text ?? raw?.content ?? '';
          feedInputs.push({ id: ch.id, title: ch.title || `第${feedInputs.length + 1}部分`, text: String(text) });
        }
        const tocItemsTxt = await withTimeout(
          controller.loadTxt(feedInputs, viewerRef.current!, {
            initialCfi: initialCfiTxt,
            settings,
          }),
          20000,
          'loadTxt',
        );
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

      const tocItems = await withTimeout(
        controller.load(source, viewerRef.current!, {
          initialCfi,
          requestHeaders,
          settings,
        }),
        20000,
        'load-epub',
      );
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

  const handleTocSelect = useCallback((href: string) => {
    setTocOpen(false);
    void controllerRef.current?.goTo(href);
  }, []);

  const handleSeek = useCallback((percentage: number) => {
    controllerRef.current?.goToPercentage(percentage);
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
    <div className="fixed inset-0 overflow-hidden" style={{ background: themeSpec.background }}>
      {/* epub.js 渲染区（垂直滚动容器；上方无覆盖层，滚动手势直达） */}
      <div ref={viewerRef} className="absolute inset-0" />

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

      <ReaderChrome visible={chromeVisible}>
        <ReaderMenuBar
          title={book?.title ?? ''}
          chromeBackground={themeSpec.chromeBackground}
          chromeColor={themeSpec.chromeColor}
          onOpenToc={() => setTocOpen(true)}
          onOpenFontSettings={() => setFontOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
        />
        <ReaderBottomBar
          location={location}
          locationsReady={locationsReady}
          chromeBackground={themeSpec.chromeBackground}
          chromeColor={themeSpec.chromeColor}
          onSeek={handleSeek}
        />
      </ReaderChrome>

      <TocPanel
        open={tocOpen}
        toc={toc}
        currentHref={location?.chapterHref}
        chromeBackground={themeSpec.chromeBackground}
        chromeColor={themeSpec.chromeColor}
        onSelect={handleTocSelect}
        onClose={() => setTocOpen(false)}
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
