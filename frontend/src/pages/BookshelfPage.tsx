import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import UploadQueue, { type UploadQueueStats, type UploadQueueHandle } from '../components/UploadQueue';
import { APP_VERSION } from '../version';
import {
  cacheShelfBooksMeta,
  getOfflineShelfBooks,
  checkPackageStaleness,
  getAllOfflinePackageBookIds,
  getStalePackageBookIds,
} from '../services/offlineCacheService';
import { useAuth } from '../contexts/AuthContext';
import { useTtsQueue } from '../hooks/useTtsQueue';
import { toast, confirm, Modal, Button } from '../components/ui';
import { TtsQueuePanel } from '../components/TtsQueuePanel';
import { BatchActionBar } from '../components/BatchActionBar';
import { IconButton } from '../components/ui/IconButton';

interface Book {
  id: string;
  title: string;
  author: string | null;
  format: 'epub' | 'txt';
  categoryId: string | null;
  coverPath: string | null;
  status: 'processing' | 'ready' | 'failed';
  parseError: string | null;
  createdAt: string;
  pinned: number;
  lastReadAt: string | null;
}

/** 书架排序：置顶优先 → 最近阅读（lastReadAt 降序）→ 书名升序兜底（未读/无记录时按书名排列） */
export function sortShelfBooks(books: Book[]): Book[] {
  return [...books].sort((a, b) => {
    if ((a.pinned || 0) !== (b.pinned || 0)) return (b.pinned || 0) - (a.pinned || 0);
    // lastReadAt 降序：已读（有效时间戳）在前，未读（-Infinity）在后；相同则按书名升序
    const ta = a.lastReadAt ? Date.parse(a.lastReadAt) : -Infinity;
    const tb = b.lastReadAt ? Date.parse(b.lastReadAt) : -Infinity;
    if (tb !== ta) return tb - ta;
    return (a.title || '').localeCompare(b.title || '', 'zh-CN');
  });
}

interface BookStats {
  readingPercentage: number;
  voiceGenerationRate: number;
  totalChapters: number;
  completedVoiceChapters: number;
  totalVoiceChunks: number;
  cachedChapters: number;
  cacheType: string | null;
  ttsCacheCount?: number;
}

interface Category {
  id: string;
  name: string;
  sort: number;
}

export default function BookshelfPage() {
  const { isOfflineMode, exitOfflineMode } = useAuth();
  const navigate = useNavigate();
  const [books, setBooks] = useState<Book[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [uploadStats, setUploadStats] = useState<UploadQueueStats>({ total: 0, active: 0, completed: 0, failed: 0 });
  const uploadQueueRef = useRef<UploadQueueHandle>(null);
const [bookStats, setBookStats] = useState<Record<string, BookStats>>({});
// 加载书籍统计信息
const loadBookStats = useCallback(async (bookId: string) => {
  try {
    const res = await axios.get(`/api/books/${bookId}/stats`);
    if (res.data.success) {
      setBookStats(prev => ({ ...prev, [bookId]: res.data.data }));
    }
  } catch {
    // 静默失败，不影响书架展示
  }
}, []);

// 当书籍列表变化时加载统计信息
useEffect(() => {
  books.forEach(book => {
    if (book.status === 'ready' && !bookStats[book.id]) {
      loadBookStats(book.id);
    }
  });
}, [books, bookStats, loadBookStats]);

  // ── mount 时检测离线包过期（比对本地 versionHash 与服务端 fileHash） ──
  const [staleBookIds, setStaleBookIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const ids = await getAllOfflinePackageBookIds();
        await Promise.allSettled(
          ids.map(id => checkPackageStaleness(id)),
        );
        // 检测完成后获取 stale 列表用于 UI 提示
        const staleIds = await getStalePackageBookIds();
        if (staleIds.length > 0) setStaleBookIds(new Set(staleIds));
      } catch {
        // 静默失败，不影响书架展示
      }
    })();
  }, []);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingBook, setEditingBook] = useState<Book | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editAuthor, setEditAuthor] = useState('');
  // ── 长按批量选择模式 ──
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const toggleSelection = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // ── Batch Delete ──
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({
      title: '删除确认',
      message: `确定删除选中的 ${selectedIds.size} 本书？此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await Promise.all([...selectedIds].map(id => axios.delete(`/api/books/${id}`)));
      exitSelectionMode();
      await loadData();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量删除失败');
    }
  };

  const [batchActionLoading, setBatchActionLoading] = useState<string | null>(null);
  // ── TTS 生成队列（共享 hook：状态/轮询/操作，confirm 弹窗文案随 action 还原） ──
  const {
    ttsJobs, showTtsQueue, setShowTtsQueue, selectedJobIds,
    fetchTTSJobs, toggleJobSelection, selectAllJobs, deselectAllJobs,
    handleCancelJob, handleBatchCancelSelected, handleBatchDeleteSelected,
    handleClearTerminated, handleClearAllJobs, closeQueue,
  } = useTtsQueue({
    confirm: (action, count) => {
      switch (action) {
        case 'batchCancel':
          return confirm({ title: '取消任务', message: `确定取消 ${count} 个语音生成任务？`, confirmText: '取消任务', danger: true });
        case 'batchDelete':
          return confirm({ title: '删除任务', message: `确定删除选中的 ${count} 个任务？此操作不可恢复。`, confirmText: '删除', danger: true });
        case 'clearTerminated':
          return confirm({ title: '清除任务', message: `确定清除 ${count} 个已完成/失败的任务？`, confirmText: '清除', danger: true });
        case 'clearAll':
          return confirm({ title: '清除全部', message: '确定取消所有排队中的语音生成任务？', confirmText: '全部取消', danger: true });
      }
    },
  });

  // ── 书籍去重 ──
  const [deduping, setDeduping] = useState(false);
  const handleDedup = useCallback(async () => {
    if (deduping) return;
    const okDedup = await confirm({
      title: '书籍去重',
      message: '确定要扫描并删除书架上的重复书籍吗？仅保留每本书最早上传的副本。',
      confirmText: '开始去重',
      danger: true,
    });
    if (!okDedup) return;
    setDeduping(true);
    try {
      const res = await axios.post('/api/books/dedup');
      toast.success(res.data.message);
      if (res.data.data.removed > 0) {
        await loadData();
      }
    } catch (err: any) {
      toast.error(err.response?.data?.error || '去重操作失败');
    } finally {
      setDeduping(false);
    }
  }, [deduping]);

  const handleBatchGenerateVoice = async () => {
    if (selectedIds.size === 0) return;
    setBatchActionLoading('voice');
    try {
      await Promise.all([...selectedIds].map(id =>
        axios.post(`/api/books/${id}/tts-generate`)
      ));
      // 提交成功 → 自动打开队列面板查看进展
      setShowTtsQueue(true);
      await fetchTTSJobs();
      exitSelectionMode();
      await loadData();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '提交语音预生成失败');
    } finally {
      setBatchActionLoading(null);
    }
  };


  // ── 全局 TTS 播放状态（来自 TTSPlayer 单例，书架页后台听书控制） ──

  // ── 从路由 state 自动打开队列（由 Layout 中的 TTS 队列图标触发） ──
  const location = useLocation();
  useEffect(() => {
    const state = location.state as { openTtsQueue?: boolean } | null;
    if (state?.openTtsQueue) {
      setShowTtsQueue(true);
      // 清除 state，防止刷新后重复触发
      window.history.replaceState({}, document.title);
    }
  }, [location.state]);
  useEffect(() => {
    loadData();
  }, []);

  // 网络状态监听（用于离线时自动刷新书架）
  useEffect(() => {
    const handleOnline = () => { loadData(); };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);

      // 在线且未主动离线时正常请求 API
      if (navigator.onLine && !isOfflineMode) {
        const [booksRes, catsRes] = await Promise.all([
          axios.get('/api/books'),
          axios.get('/api/categories'),
        ]);
        const booksData = booksRes.data.data || [];
        setBooks(booksData);
        setCategories(catsRes.data.data || []);
        setError(null);

        // 后台静默缓存书架元数据到 IndexedDB（用于离线展示）
        cacheShelfBooksMeta(booksData).catch(() => {});
      } else {
        // 离线时从 IndexedDB 读取书架
        const offlineBooks = await getOfflineShelfBooks();
        if (offlineBooks.length > 0) {
          setBooks(offlineBooks.map(b => ({
            id: b.bookId,
            title: b.bookTitle,
            author: b.author || null,
            format: b.format,
            coverPath: b.hasCover ? `/api/books/${b.bookId}/cover` : null,
            status: 'ready' as const,
            categoryId: null,
            pinned: 0,
            parseError: null,
            lastReadAt: b.lastReadAt || null,
            createdAt: new Date(b.cachedAt).toISOString(),
          })));
          setCategories([]);
          setError(null);
        } else {
          setError('当前为离线状态，且没有已缓存的书籍');
          setBooks([]);
          setCategories([]);
        }
      }
    } catch (err: any) {
      // 网络请求失败或主动离线 → 始终尝试 IndexedDB 降级
      const offlineBooks = await getOfflineShelfBooks();
      if (offlineBooks.length > 0) {
        setBooks(offlineBooks.map(b => ({
          id: b.bookId,
          title: b.bookTitle,
          author: b.author || null,
          format: b.format,
          coverPath: b.hasCover ? `/api/books/${b.bookId}/cover` : null,
          status: 'ready' as const,
          categoryId: null,
          pinned: 0,
          parseError: null,
          lastReadAt: b.lastReadAt || null,
          createdAt: new Date(b.cachedAt).toISOString(),
        })));
        setCategories([]);
        setError(null);
        return;
      }
      setError(err.response?.data?.error || '当前无法连接服务器，且没有已缓存的书籍');
    } finally {
      setLoading(false);
    }
  };

  // ── Delete ──
  const handleDelete = async (book: Book, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const okDel = await confirm({
      title: '删除书籍',
      message: `确定删除《${book.title}》？此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!okDel) return;

    try {
      await axios.delete(`/api/books/${book.id}`);
      await loadData();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '删除失败');
    }
  };

  // ── Edit book metadata ──
  const handleEditBook = (book: Book, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingBook(book);
    setEditTitle(book.title);
    setEditAuthor(book.author || '');
  };

  // ── 置顶/取消置顶 ──
  const handleTogglePin = useCallback(async (book: Book, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const newPinned = book.pinned ? 0 : 1;
    try {
      await axios.put(`/api/books/${book.id}`, { pinned: newPinned });
      setBooks(prev => prev.map(b => b.id === book.id ? { ...b, pinned: newPinned } : b));
    } catch (err: any) {
      toast.error('操作失败：' + (err.response?.data?.error || err.message));
    }
  }, []);

  const handleSaveEdit = async () => {
    if (!editingBook) return;
    try {
      await axios.put(`/api/books/${editingBook.id}`, {
        title: editTitle.trim() || editingBook.title,
        author: editAuthor.trim() || null,
      });
      setEditingBook(null);
      await loadData();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '保存失败');
    }
  };

  // ── Filter (search + category) ──
  const filteredBooks = books.filter((b) => {
    // Category filter
    if (selectedCategoryId && b.categoryId !== selectedCategoryId) return false;
    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = b.title.toLowerCase().includes(q);
      const matchAuthor = b.author?.toLowerCase().includes(q);
      if (!matchTitle && !matchAuthor) return false;
    }
    return true;
  });

  // ── Split into pinned / others for two-section display ──
  // 最近阅读优先：lastReadAt 降序（最近读的在前），无阅读记录的按书名升序兜底（见 sortShelfBooks）
  const pinnedBooks = sortShelfBooks(filteredBooks.filter(b => b.pinned));
  const otherBooks = sortShelfBooks(filteredBooks.filter(b => !b.pinned));

  // Categorize books for sidebar count
  const categoryCount = new Map<string, number>();
  books.forEach((b) => {
    const catId = b.categoryId || 'default-uncategorized';
    categoryCount.set(catId, (categoryCount.get(catId) || 0) + 1);
  });

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <p className="text-ios-text-muted">加载中...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <div className="bg-ios-danger-subtle border border-ios-danger rounded-lg p-4">
          <p className="text-ios-danger">{error}</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="danger" size="sm" onClick={loadData}>
              重试
            </Button>
            {isOfflineMode && (
              <Button variant="secondary" size="sm"
                onClick={() => navigate('/login', { replace: true })}>
                返回登录页
              </Button>
            )}
            <Button variant="ghost" size="sm" className="!text-ios-danger"
              onClick={exitOfflineMode}>
              退出离线模式
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8">
      {/* iOS 大标题区域 */}
      <div className="mb-5 sm:mb-8">
        {/* 标题行 */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-[28px] sm:text-[34px] font-bold tracking-tight"
              style={{ color: 'var(--color-text)' }}>
              我的书架
            </h1>
            <span className="text-xs font-medium px-2 py-0.5 rounded-full select-none"
              style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-muted)' }}>
              v{APP_VERSION}
            </span>
            {/* 合成活跃指示器 */}
            {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
              <Button variant="pill" active size="xs"
                onClick={() => setShowTtsQueue(true)}
                className="hidden sm:flex animate-fade-in gap-1.5"
                title="点击查看 TTS 队列">
                <span className="w-2 h-2 rounded-full animate-pulse bg-ios-primary" />
                合成中
              </Button>
            )}
          </div>
        </div>

        {/* iOS 风格搜索栏 */}
        <div className="relative w-full">
          <svg className="absolute left-3.5 top-1/2 -translate-y-1/2" width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="var(--color-text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索书名或作者…"
            className="w-full pl-10 pr-4 h-10 text-sm rounded-xl border-0 outline-none transition-all duration-200"
            style={{
              background: 'var(--color-bg-alt)',
              color: 'var(--color-text)',
            }}
            onFocus={(e) => { e.target.style.boxShadow = '0 0 0 2px var(--color-primary-muted)'; }}
            onBlur={(e) => { e.target.style.boxShadow = 'none'; }}
          />
          {searchQuery && (
            <IconButton
              onClick={() => setSearchQuery('')}
              variant="subtle"
              size="xs"
              className="absolute right-3 top-1/2 -translate-y-1/2 bg-ios-text-muted text-white"
              aria-label="清除搜索"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </IconButton>
          )}
        </div>

        {/* 操作按钮行 */}
        <div className="flex items-center gap-2 mt-3 overflow-x-auto scrollbar-hide">
          <Button variant="secondary" size="sm" className="shrink-0"
            onClick={() => { setSelectionMode(true); setSelectedIds(new Set()); }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <polyline points="9 11 12 14 22 4" />
            </svg>
            批量选择
          </Button>
          <Button size="sm" className="shrink-0"
            onClick={() => uploadQueueRef.current?.show()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            上传图书
          </Button>
          <Button variant="secondary" size="sm" className="shrink-0"
            onClick={handleDedup} title="扫描并删除书架上的重复书籍">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            去重
          </Button>
          {/* 上传队列状态 */}
          {uploadStats.total > 0 && (
            <Button variant="ghost" size="sm" className="shrink-0 animate-fade-in"
              onClick={() => uploadQueueRef.current?.show()}
              title={`上传队列：${uploadStats.active} 个进行中，${uploadStats.completed} 个完成`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              上传中 {uploadStats.active > 0 && `(${uploadStats.active})`}
            </Button>
          )}
        </div>
      </div>
      {/* Upload Queue Modal — 始终渲染以支持后台运行 */}
      <UploadQueue
        ref={uploadQueueRef}
        onComplete={() => { loadData(); }}
        onClose={() => {}}
        onStatsChange={setUploadStats}
      />

      {/* Sidebar + Content */}
      {/* Edit Modal */}
      <Modal
        open={!!editingBook}
        onClose={() => setEditingBook(null)}
        title="编辑图书信息"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditingBook(null)}>取消</Button>
            <Button onClick={handleSaveEdit}>保存</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1 text-ios-text-secondary">书名</label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full px-3 py-2 rounded-xl text-sm outline-none transition-all duration-200"
              style={{
                background: 'var(--color-bg-alt)',
                color: 'var(--color-text)',
                border: '0.5px solid var(--color-border)',
              }}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1 text-ios-text-secondary">作者</label>
            <input
              type="text"
              value={editAuthor}
              onChange={(e) => setEditAuthor(e.target.value)}
              placeholder="可选"
              className="w-full px-3 py-2 rounded-xl text-sm outline-none transition-all duration-200"
              style={{
                background: 'var(--color-bg-alt)',
                color: 'var(--color-text)',
                border: '0.5px solid var(--color-border)',
              }}
            />
          </div>
        </div>
      </Modal>
      <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
        {/* Category Sidebar */}
        <div className="w-full sm:w-48 shrink-0 overflow-x-auto scrollbar-hide">
          <div className="flex sm:flex-col gap-1 pb-1 sm:pb-0">
            <Button
              variant="row"
              active={selectedCategoryId === null}
              justify="start"
              size="sm"
              fullWidth
              onClick={() => setSelectedCategoryId(null)}
              className="h-auto py-2"
            >
              全部 ({books.length})
            </Button>
            {categories.map((cat) => (
              <Button
                key={cat.id}
                variant="row"
                active={selectedCategoryId === cat.id}
                justify="start"
                size="sm"
                fullWidth
                onClick={() => setSelectedCategoryId(cat.id)}
                className="h-auto py-2"
              >
                {cat.name} ({categoryCount.get(cat.id) || 0})
              </Button>
            ))}
          </div>
        </div>

        {/* Book Grid */}
        <div className="flex-1">
          {filteredBooks.length === 0 ? (
            <div className="text-center py-16" style={{ color: 'var(--color-text-muted)' }}>
              <p className="text-6xl mb-4">📚</p>
              <p className="text-lg">
                {selectedCategoryId ? '该分类下还没有图书' : '书架还是空的'}
              </p>
              {!selectedCategoryId && (
                <p className="mt-2">点击上方「上传图书」开始添加</p>
              )}
            </div>
          ) : (<div>
              {/* ── 置顶区 ── */}
              {pinnedBooks.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"
                    style={{ color: 'var(--color-text-muted)' }}>
                    <span>📌</span> 置顶
                  </h3>
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                    {pinnedBooks.map((book) => (
                <div
                  key={book.id}
                  className="relative group"
                  onTouchStart={() => {
                    if (selectionMode) return;
                    longPressTimerRef.current = setTimeout(() => {
                      setSelectionMode(true);
                      setSelectedIds(new Set([book.id]));
                    }, 500);
                  }}
                  onTouchMove={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = undefined; } }}
                  onTouchEnd={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = undefined; } }}
                >
                  <Link
                    to={selectionMode ? '#' : `/reader/${book.id}`}
                    onClick={(e) => {
                      if (selectionMode) {
                        e.preventDefault();
                        toggleSelection(book.id);
                      }
                    }}
                    className={`block p-2 sm:p-3 border rounded-2xl transition-all duration-200 tap-row ${
                      selectionMode && selectedIds.has(book.id)
                        ? ''
                        : ''
                    }`}
                    style={{
                      background: 'var(--color-bg-card)',
                      borderColor: selectionMode && selectedIds.has(book.id) ? 'var(--color-primary)' : 'var(--color-border)',
                      boxShadow: selectionMode && selectedIds.has(book.id) ? '0 0 0 2px var(--color-primary-muted)' : 'var(--shadow-ios-sm)',
                    }}
                  >
                    <div className="aspect-[3/4] rounded-xl mb-2 flex items-center justify-center overflow-hidden relative"
                      style={{ background: 'var(--color-bg-alt)' }}>
                      {/* 选中态勾选框 */}
                      {selectionMode && (
                        <div className="absolute top-1 left-1 z-20">
                          <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shadow-sm ${
                            selectedIds.has(book.id) ? 'bg-ios-primary border-ios-primary' : 'bg-white/90 dark:bg-gray-700/90 border-ios-border-hover'
                          }`}>
                            {selectedIds.has(book.id) && <span className="text-white text-[11px] font-bold">✓</span>}
                          </div>
                        </div>
                      )}
                      <img
                        src={`/api/books/${book.id}/cover`}
                        alt={book.title}
                        className="w-full h-full object-cover rounded"
                        loading="lazy"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          (e.target as HTMLImageElement).parentElement!.innerHTML =
                            `<span class="text-4xl">${book.format === 'epub' ? '📖' : '📄'}</span>`;
                        }}
                      />
                    </div>
                    <h3 className="font-medium text-sm truncate" title={book.title}>{book.title}</h3>
                    {book.author && (
                      <p className="text-xs text-ios-text-muted truncate">{book.author}</p>
                    )}
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <span className="text-xs text-ios-text-muted uppercase">{book.format}</span>
                      {book.status === 'processing' && (
                        <span className="text-xs text-ios-warning bg-ios-warning-subtle px-1.5 py-0.5 rounded">解析中</span>
                      )}
                      {book.status === 'failed' && (
                        <span className="text-xs text-ios-danger bg-ios-danger-subtle px-1.5 py-0.5 rounded" title={book.parseError || ''}>解析失败</span>
                      )}
                      {staleBookIds.has(book.id) && (
                        <span className="text-xs text-ios-warning bg-ios-warning-subtle px-1.5 py-0.5 rounded" title="离线包已过期，进入阅读器可重新下载">离线包过期</span>
                      )}
                    </div>
                    {/* 阅读百分比 + 语音生成率 */}
                    {book.status === 'ready' && bookStats[book.id] && (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-ios-text-muted">阅读</span>
                          <span className="text-ios-text-secondary font-medium">
                            {Math.round(bookStats[book.id].readingPercentage * 100)}%
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full overflow-hidden"
                          style={{ background: 'var(--color-border)' }}>
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%`, background: 'var(--color-primary)' }} />
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span style={{ color: 'var(--color-text-muted)' }}>语音</span>
                          <span className="text-ios-text-secondary font-medium">
                            ${Math.round((bookStats[book.id].voiceGenerationRate || 0) * bookStats[book.id].totalChapters)}/${bookStats[book.id].totalChapters}章
                          </span>
                        </div>
                        <div className="w-full h-1.5 rounded-full overflow-hidden"
                          style={{ background: 'var(--color-border)' }}>
                          <div className="h-full rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(bookStats[book.id].voiceGenerationRate * 100)}%`, background: 'var(--color-accent-2)' }} />
                        </div>
                      </div>
                    )}
                  </Link>
                  {/* Action buttons - desktop hover only, mobile via long-press */}
                  <div className="hidden sm:flex absolute top-2 right-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton variant="primary" size="xs" className="w-7 h-7" onClick={(e) => handleEditBook(book, e)} title="编辑信息">✎</IconButton>
                    <IconButton variant="danger" size="xs" className="w-7 h-7" onClick={(e) => handleDelete(book, e)} title="删除图书">✕</IconButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
          )}
          {/* ── 其它区 ── */}
          {otherBooks.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5"
                style={{ color: 'var(--color-text-muted)' }}>
                <span>📚</span> 其它
              </h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
                {otherBooks.map((book) => (
                  <div
                    key={book.id}
                    className="relative group"
                    onTouchStart={() => {
                      if (selectionMode) return;
                      longPressTimerRef.current = setTimeout(() => {
                        setSelectionMode(true);
                        setSelectedIds(new Set([book.id]));
                      }, 500);
                    }}
                    onTouchMove={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = undefined; } }}
                    onTouchEnd={() => { if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = undefined; } }}
                  >
                    <Link
                      to={selectionMode ? '#' : `/reader/${book.id}`}
                      onClick={(e) => {
                        if (selectionMode) {
                          e.preventDefault();
                          toggleSelection(book.id);
                        }
                      }}
                                             className={`block p-2 sm:p-3 border rounded-2xl transition-all duration-200 tap-row ${
                        selectionMode && selectedIds.has(book.id)
                          ? ''
                          : ''
                      }`}
                      style={{
                        background: 'var(--color-bg-card)',
                        borderColor: selectionMode && selectedIds.has(book.id) ? 'var(--color-primary)' : 'var(--color-border)',
                        boxShadow: selectionMode && selectedIds.has(book.id) ? '0 0 0 2px var(--color-primary-muted)' : 'var(--shadow-ios-sm)',
                      }}
                    >
                      <div className="aspect-[3/4] rounded-xl mb-2 flex items-center justify-center overflow-hidden relative"
                      style={{ background: 'var(--color-bg-alt)' }}>
                        {selectionMode && (
                          <div className="absolute top-1 left-1 z-20">
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shadow-sm ${
                              selectedIds.has(book.id) ? 'bg-ios-primary border-ios-primary' : 'bg-white/90 dark:bg-gray-700/90 border-ios-border-hover'
                            }`}>
                              {selectedIds.has(book.id) && <span className="text-white text-[11px] font-bold">✓</span>}
                            </div>
                          </div>
                        )}
                        <img
                          src={`/api/books/${book.id}/cover`}
                          alt={book.title}
                          className="w-full h-full object-cover rounded"
                          loading="lazy"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                            (e.target as HTMLImageElement).parentElement!.innerHTML =
                              `<span class="text-4xl">${book.format === 'epub' ? '📖' : '📄'}</span>`;
                          }}
                        />
                      </div>
                      <h3 className="font-medium text-sm truncate" title={book.title}>{book.title}</h3>
                      {book.author && (
                        <p className="text-xs truncate" style={{ color: 'var(--color-text-muted)' }}>{book.author}</p>
                      )}
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        <span className="text-xs uppercase" style={{ color: 'var(--color-text-muted)' }}>{book.format}</span>
                        {book.status === 'processing' && (
                          <span className="text-xs text-ios-warning bg-ios-warning-subtle px-1.5 py-0.5 rounded">解析中</span>
                        )}
                        {book.status === 'failed' && (
                          <span className="text-xs text-ios-danger bg-ios-danger-subtle px-1.5 py-0.5 rounded" title={book.parseError || ''}>解析失败</span>
                        )}
                        {staleBookIds.has(book.id) && (
                          <span className="text-xs text-ios-warning bg-ios-warning-subtle px-1.5 py-0.5 rounded" title="离线包已过期，进入阅读器可重新下载">离线包过期</span>
                        )}
                      </div>
                      {book.status === 'ready' && bookStats[book.id] && (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span style={{ color: 'var(--color-text-muted)' }}>阅读</span>
                            <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                              {Math.round(bookStats[book.id].readingPercentage * 100)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-ios-bg-alt rounded-full overflow-hidden">
                            <div className="h-full bg-ios-primary rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span style={{ color: 'var(--color-text-muted)' }}>语音</span>
                            <span className="font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                              ${Math.round((bookStats[book.id].voiceGenerationRate || 0) * bookStats[book.id].totalChapters)}/${bookStats[book.id].totalChapters}章
                            </span>
                          </div>
                          <div className="w-full h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'var(--color-border)' }}>
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${Math.round(bookStats[book.id].voiceGenerationRate * 100)}%`, background: 'var(--color-accent-2)' }} />
                          </div>
                        </div>
                      )}
                    </Link>
                    <div className="hidden sm:flex absolute top-2 right-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <IconButton variant="warning" size="xs" className="w-7 h-7" onClick={(e) => handleTogglePin(book, e)} title={book.pinned ? '取消置顶' : '置顶'}>{book.pinned ? '📌' : '📍'}</IconButton>
                      <IconButton variant="primary" size="xs" className="w-7 h-7" onClick={(e) => handleEditBook(book, e)} title="编辑信息">✎</IconButton>
                      <IconButton variant="danger" size="xs" className="w-7 h-7" onClick={(e) => handleDelete(book, e)} title="删除图书">✕</IconButton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          </div>)}
        </div>
      </div>
    </div>
      {/* 迷你播放器 - TTS 后台听书控制 */}
      {/* 批量选择操作栏 */}
      {selectionMode && (
        <BatchActionBar
          selectedCount={selectedIds.size}
          totalCount={filteredBooks.length}
          onToggleSelectAll={() => {
            const allFilteredIds = new Set(filteredBooks.map(b => b.id));
            if (allFilteredIds.size === selectedIds.size) setSelectedIds(new Set());
            else setSelectedIds(allFilteredIds);
          }}
          onExit={exitSelectionMode}
          actions={[
            { id: 'delete', label: '删除选中', icon: '🗑', variant: 'danger', disabled: selectedIds.size === 0, onClick: handleBatchDelete },
            { id: 'voice', label: '预生成语音', icon: '🎙', variant: 'success', disabled: selectedIds.size === 0 || batchActionLoading === 'voice', loading: batchActionLoading === 'voice', onClick: handleBatchGenerateVoice },
            { id: 'dedup', label: '去重', icon: '🔄', variant: 'accent', disabled: deduping, loading: deduping, onClick: handleDedup },
          ]}
        />
      )}

      {/* ── TTS 预生成队列可视化面板（统一 Modal 体系） ── */}
      <TtsQueuePanel
        open={showTtsQueue}
        ttsJobs={ttsJobs}
        selectedJobIds={selectedJobIds}
        onToggleJobSelection={toggleJobSelection}
        onSelectAllJobs={selectAllJobs}
        onDeselectAllJobs={deselectAllJobs}
        onBatchCancelSelected={handleBatchCancelSelected}
        onBatchDeleteSelected={handleBatchDeleteSelected}
        onCancelJob={handleCancelJob}
        onClearTerminated={handleClearTerminated}
        onClearAllJobs={handleClearAllJobs}
        onRefresh={fetchTTSJobs}
        onClose={closeQueue}
      />

    </>
  );
}