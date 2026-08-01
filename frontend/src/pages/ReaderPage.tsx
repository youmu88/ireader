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
import { EpubBookController } from '../reader/EpubBookController';
import { READER_THEMES } from '../reader/theme';
import type { ReaderLocation, TocItem } from '../reader/types';
import { useReaderSettings } from '../reader/useReaderSettings';
import { useReaderProgress } from '../reader/useReaderProgress';
import { ReaderChrome } from '../reader/components/ReaderChrome';
import { ReaderTopBar } from '../reader/components/ReaderTopBar';
import { ReaderBottomBar } from '../reader/components/ReaderBottomBar';
import { FontSettingsPanel } from '../reader/components/FontSettingsPanel';
import { TocPanel } from '../reader/components/TocPanel';
import { getCachedEpubArchive } from '../services/offlineCacheService';
import { getToken } from '../services/authService';
import { Button } from '../components/ui';

interface BookMeta {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
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

  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerWrapRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<EpubBookController | null>(null);
  const turnDirRef = useRef<'next' | 'prev' | null>(null);
  const [turnAnim, setTurnAnim] = useState<{ dir: 'next' | 'prev'; seq: number } | null>(null);

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

      if (meta.format !== 'epub') {
        setError('该书籍为 TXT 格式，新版阅读器暂不支持，敬请期待');
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

      setToc(tocItems);
      setLoading(false);
      controller.onLocationChange(loc => {
        setLocation(loc);
        scheduleSave(loc);
        // 翻页完成后播放滑动动画（初始定位不播放）
        if (turnDirRef.current) {
          setTurnAnim({ dir: turnDirRef.current, seq: Date.now() });
          turnDirRef.current = null;
        }
      });
      // 全局页码异步生成，完成后底栏切换为「第 X 页，共 Y 页」
      void controller.generateLocations().then(() => {
        if (!cancelled) setLocationsReady(true);
      });
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

  // ── 翻页滑动动画：relocated 后触发，操作包装层 style，不重建 epub 容器 ──
  useEffect(() => {
    const el = viewerWrapRef.current;
    if (!el || !turnAnim) return;
    el.style.animation = 'none';
    void el.offsetWidth; // 强制 reflow 以重启动画
    el.style.animation = `${turnAnim.dir === 'next' ? 'reader-page-next' : 'reader-page-prev'} 0.2s ease-out`;
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

      {/* 点按层：左 1/4 上一页 · 中央显隐工具栏 · 右 1/4 下一页 */}
      {!loading && (
        <div className="absolute inset-0 z-10 flex" data-testid="tap-zones">
          <button className="w-1/4 h-full" onClick={handlePrev} aria-label="上一页" />
          <button className="flex-1 h-full" onClick={() => setChromeVisible(v => !v)} aria-label="显示或隐藏工具栏" />
          <button className="w-1/4 h-full" onClick={handleNext} aria-label="下一页" />
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
      />
      <FontSettingsPanel
        open={fontOpen}
        settings={settings}
        chromeBackground={themeSpec.chromeBackground}
        chromeColor={themeSpec.chromeColor}
        onChange={updateSettings}
        onClose={() => setFontOpen(false)}
      />
    </div>
  );
}
