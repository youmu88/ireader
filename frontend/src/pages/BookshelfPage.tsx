import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { subscribeGlobalPlayer, getGlobalPlayerSnapshot, getDefaultPlayer, getLastPlaybackFromLocalStorage, type PlayerState } from '../services/ttsPlayer';
import UploadQueue, { type UploadQueueStats, type UploadQueueHandle } from '../components/UploadQueue';
import { APP_VERSION } from '../version';
import {
  cacheShelfBooksMeta,
  getOfflineShelfBooks,
} from '../services/offlineCacheService';
import { useAuth } from '../contexts/AuthContext';

interface TTSJob {
  id: string;
  bookId: string;
  bookTitle: string;
  voice: string;
  speed: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  totalChunks: number;
  completedChunks: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

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
    if (!window.confirm(`确定删除选中的 ${selectedIds.size} 本书？此操作不可恢复。`)) return;
    try {
      await Promise.all([...selectedIds].map(id => axios.delete(`/api/books/${id}`)));
      exitSelectionMode();
      await loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || '批量删除失败');
    }
  };

  const [batchActionLoading, setBatchActionLoading] = useState<string | null>(null);
  // ── TTS 生成队列可视化 ──
  const [ttsJobs, setTtsJobs] = useState<TTSJob[]>([]);
  const [showTtsQueue, setShowTtsQueue] = useState(false);
  const ttsQueuePollRef = useRef<ReturnType<typeof setInterval>>();

  const fetchTTSJobs = useCallback(async () => {
    try {
      const res = await axios.get('/api/tts/jobs');
      if (res.data.success) {
        setTtsJobs(res.data.data);
        // 如果没有活跃任务，停止轮询
        const active = res.data.data.filter((j: TTSJob) => j.status === 'pending' || j.status === 'running');
        if (active.length === 0 && ttsQueuePollRef.current) {
          clearInterval(ttsQueuePollRef.current);
          ttsQueuePollRef.current = undefined;
        }
      }
    } catch { /* 静默 */ }
  }, []);

  // ── 取消单个 TTS 生成任务 ──
  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await axios.delete(`/api/tts/jobs/${jobId}`);
      await fetchTTSJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || '取消失败');
    }
  }, [fetchTTSJobs]);

  // ── 队列批量选择模式 ──
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());

  const toggleJobSelection = (id: string) => {
    setSelectedJobIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllJobs = () => {
    setSelectedJobIds(new Set(ttsJobs.map(j => j.id)));
  };

  const deselectAllJobs = () => {
    setSelectedJobIds(new Set());
  };

  // ── 批量取消选中的排队/运行中任务 ──
  const handleBatchCancelSelected = async () => {
    if (selectedJobIds.size === 0) return;
    const cancelIds = [...selectedJobIds].filter(id => {
      const job = ttsJobs.find(j => j.id === id);
      return job && (job.status === 'pending' || job.status === 'running');
    });
    if (cancelIds.length === 0) {
      alert('选中的任务中没有可取消的（仅 pending/running 可取消）');
      return;
    }
    if (!window.confirm(`确定取消 ${cancelIds.length} 个语音生成任务？`)) return;
    try {
      await axios.post('/api/tts/jobs/batch-cancel', { jobIds: cancelIds });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || '批量取消失败');
    }
  };

  // ── 批量删除选中的任务（不限状态） ──
  const handleBatchDeleteSelected = async () => {
    if (selectedJobIds.size === 0) return;
    if (!window.confirm(`确定删除选中的 ${selectedJobIds.size} 个任务？此操作不可恢复。`)) return;
    try {
      await axios.post('/api/tts/jobs/delete', { jobIds: [...selectedJobIds] });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || '批量删除失败');
    }
  };

  // ── 清除所有已完成/失败任务 ──
  const handleClearTerminated = async () => {
    const terminatedCount = ttsJobs.filter(j => j.status === 'completed' || j.status === 'failed').length;
    if (terminatedCount === 0) {
      alert('没有已完成或失败的任务');
      return;
    }
    if (!window.confirm(`确定清除 ${terminatedCount} 个已完成/失败的任务？`)) return;
    try {
      await axios.post('/api/tts/jobs/clear-terminated');
      await fetchTTSJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || '清除失败');
    }
  };

  // ── 清除全部排队任务 ──
  const handleClearAllJobs = useCallback(async () => {
    if (!window.confirm('确定取消所有排队中的语音生成任务？')) return;
    try {
      await axios.post('/api/tts/jobs/clear-all');
      await fetchTTSJobs();
    } catch (err: any) {
      alert(err.response?.data?.error || '清除失败');
    }
  }, [fetchTTSJobs]);

  // ── 书籍去重 ──
  const [deduping, setDeduping] = useState(false);
  const handleDedup = useCallback(async () => {
    if (deduping) return;
    if (!window.confirm('确定要扫描并删除书架上的重复书籍吗？仅保留每本书最早上传的副本。')) return;
    setDeduping(true);
    try {
      const res = await axios.post('/api/books/dedup');
      alert(res.data.message);
      if (res.data.data.removed > 0) {
        await loadData();
      }
    } catch (err: any) {
      alert(err.response?.data?.error || '去重操作失败');
    } finally {
      setDeduping(false);
    }
  }, [deduping]);

  // 当面板打开或有活跃任务时轮询
  useEffect(() => {
    if (showTtsQueue) {
      fetchTTSJobs();
      if (!ttsQueuePollRef.current) {
        ttsQueuePollRef.current = setInterval(fetchTTSJobs, 3000);
      }
    }
    return () => {
      if (ttsQueuePollRef.current) {
        clearInterval(ttsQueuePollRef.current);
        ttsQueuePollRef.current = undefined;
      }
    };
  }, [showTtsQueue, fetchTTSJobs]);

  // 全局：只要有 pending/running 任务就后台轮询（更新书架 stats 显示）
  useEffect(() => {
    const hasActive = ttsJobs.some(j => j.status === 'pending' || j.status === 'running');
    if (hasActive && !ttsQueuePollRef.current) {
      ttsQueuePollRef.current = setInterval(fetchTTSJobs, 5000);
    }
    if (!hasActive && ttsQueuePollRef.current) {
      clearInterval(ttsQueuePollRef.current);
      ttsQueuePollRef.current = undefined;
    }
  }, [ttsJobs, fetchTTSJobs]);

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
      alert(err.response?.data?.error || '提交语音预生成失败');
    } finally {
      setBatchActionLoading(null);
    }
  };

  /** 批量操作项配置（可扩展） */
  interface BatchAction {
    id: string;
    label: string;
    icon: string;
    color: string;
    hoverColor: string;
    disabled?: boolean;
    loading?: boolean;
    onClick: () => void;
  }
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
  const [globalTtsInfo, setGlobalTtsInfo] = useState<{
    state: PlayerState;
    bookId?: string;
    bookTitle?: string;
    chapterTitle?: string;
    progress: number;
  } | null>(() => {
    // 优先使用实时播放器状态，空闲时从 localStorage 恢复上次播放记录
    const snapshot = getGlobalPlayerSnapshot();
    if (snapshot) return snapshot;
    const lastPlayback = getLastPlaybackFromLocalStorage();
    if (lastPlayback) {
      return {
        state: 'paused' as PlayerState,
        bookId: lastPlayback.bookId,
        bookTitle: lastPlayback.bookTitle,
        chapterTitle: lastPlayback.chapterTitle,
        progress: lastPlayback.progress,
      };
    }
    return null;
  });

  useEffect(() => {
    const unsub = subscribeGlobalPlayer((info) => setGlobalTtsInfo(info));
    return unsub;
  }, []);

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
            lastReadAt: null,
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
          lastReadAt: null,
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

    if (!window.confirm(`确定删除《${book.title}》？此操作不可恢复。`)) return;

    try {
      await axios.delete(`/api/books/${book.id}`);
      await loadData();
    } catch (err: any) {
      alert(err.response?.data?.error || '删除失败');
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
      alert('操作失败：' + (err.response?.data?.error || err.message));
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
      alert(err.response?.data?.error || '保存失败');
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
  const pinnedBooks = filteredBooks.filter(b => b.pinned);
  const otherBooks = filteredBooks.filter(b => !b.pinned);

  // Categorize books for sidebar count
  const categoryCount = new Map<string, number>();
  books.forEach((b) => {
    const catId = b.categoryId || 'default-uncategorized';
    categoryCount.set(catId, (categoryCount.get(catId) || 0) + 1);
  });

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <p className="text-gray-500 dark:text-gray-400">加载中...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-700 dark:text-red-300">{error}</p>
          <div className="flex flex-wrap gap-2 mt-3">
            <button
              onClick={loadData}
              className="px-4 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 text-sm font-medium"
            >
              重试
            </button>
            {isOfflineMode && (
              <button
                onClick={() => navigate('/login', { replace: true })}
                className="px-4 py-1.5 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-50 dark:hover:bg-gray-800 text-sm font-medium"
              >
                返回登录页
              </button>
            )}
            <button
              onClick={exitOfflineMode}
              className="px-4 py-1.5 border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-sm font-medium"
            >
              退出离线模式
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className={`max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-8 ${globalTtsInfo?.state !== 'idle' && globalTtsInfo?.bookId ? 'pb-28' : ''}`}>
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
              <button onClick={() => setShowTtsQueue(true)}
                className="hidden sm:flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full animate-fade-in tap-active"
                style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
                title="点击查看 TTS 队列">
                <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--color-primary)' }} />
                合成中
              </button>
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
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center tap-icon"
              style={{ background: 'var(--color-text-muted)' }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* 操作按钮行 */}
        <div className="flex items-center gap-2 mt-3 overflow-x-auto scrollbar-hide">
          <button
            onClick={() => { setSelectionMode(true); setSelectedIds(new Set()); }}
            className="flex items-center gap-1.5 px-3.5 h-9 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 tap-active transition-all duration-200"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <polyline points="9 11 12 14 22 4" />
            </svg>
            批量选择
          </button>
          <button
            onClick={() => uploadQueueRef.current?.show()}
            className="flex items-center gap-1.5 px-4 h-9 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 ripple-btn transition-all duration-200 shadow-sm"
            style={{ background: 'var(--color-primary)', color: 'white' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            上传图书
          </button>
          <button
            onClick={handleDedup}
            className="flex items-center gap-1.5 px-3.5 h-9 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 tap-active transition-all duration-200"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text-secondary)' }}
            title="扫描并删除书架上的重复书籍"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
            去重
          </button>
          {/* 上传队列状态 */}
          {uploadStats.total > 0 && (
            <button
              onClick={() => uploadQueueRef.current?.show()}
              className="flex items-center gap-1.5 px-3 h-9 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 tap-active transition-all duration-200 animate-fade-in"
              style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}
              title={`上传队列：${uploadStats.active} 个进行中，${uploadStats.completed} 个完成`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              上传中 {uploadStats.active > 0 && `(${uploadStats.active})`}
            </button>
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
      {editingBook && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditingBook(null)}>
          <div className="rounded-2xl p-6 w-full max-w-md mx-4 shadow-ios-lg animate-pop-in" onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--color-bg-card)' }}>
            <h2 className="text-lg font-semibold mb-4" style={{ color: 'var(--color-text)' }}>编辑图书信息</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>书名</label>
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
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--color-text-secondary)' }}>作者</label>
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

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditingBook(null)}
                className="px-4 py-2 rounded-xl text-sm font-medium tap-active"
                style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 rounded-xl text-sm font-medium text-white ripple-btn"
                style={{ background: 'var(--color-primary)' }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="flex flex-col sm:flex-row gap-4 sm:gap-6">
        {/* Category Sidebar */}
        <div className="w-full sm:w-48 shrink-0 overflow-x-auto scrollbar-hide">
          <div className="flex sm:flex-col gap-1 pb-1 sm:pb-0">
            <button
              onClick={() => setSelectedCategoryId(null)}
              className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                selectedCategoryId === null
                  ? 'font-medium'
                  : ''
              }`}
              style={{
                background: selectedCategoryId === null ? 'var(--color-primary-subtle)' : 'transparent',
                color: selectedCategoryId === null ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              }}
            >
              全部 ({books.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`w-full text-left px-3 py-2 rounded-xl text-sm transition-all duration-200 ${
                  selectedCategoryId === cat.id
                    ? 'font-medium'
                    : ''
                }`}
                style={{
                  background: selectedCategoryId === cat.id ? 'var(--color-primary-subtle)' : 'transparent',
                  color: selectedCategoryId === cat.id ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                }}
              >
                {cat.name} ({categoryCount.get(cat.id) || 0})
              </button>
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
                            selectedIds.has(book.id) ? 'bg-blue-500 border-blue-500' : 'bg-white/90 dark:bg-gray-700/90 border-gray-400'
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
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{book.author}</p>
                    )}
                    <div className="mt-1 flex items-center gap-1">
                      <span className="text-xs text-gray-400 uppercase">{book.format}</span>
                      {book.status === 'processing' && (
                        <span className="text-xs text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30 px-1.5 py-0.5 rounded">解析中</span>
                      )}
                      {book.status === 'failed' && (
                        <span className="text-xs text-red-600 bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded" title={book.parseError || ''}>解析失败</span>
                      )}
                    </div>
                    {/* 阅读百分比 + 语音生成率 */}
                    {book.status === 'ready' && bookStats[book.id] && (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 dark:text-gray-400">阅读</span>
                          <span className="text-gray-700 dark:text-gray-300 font-medium">
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
                          <span className="text-gray-700 dark:text-gray-300 font-medium">
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
                    {/* 正在播放指示器 */}
                    {globalTtsInfo?.state !== 'idle' && globalTtsInfo?.bookId === book.id && (
                      <div className="absolute top-2 left-2 z-10">
                        <span className="bg-green-500 text-white text-xs px-1.5 py-0.5 rounded-full shadow-lg animate-pulse flex items-center gap-0.5">🔊</span>
                      </div>
                    )}
                    <button onClick={(e) => handleEditBook(book, e)} className="w-7 h-7 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-blue-600 tap-icon" title="编辑信息">✎</button>
                    <button onClick={(e) => handleDelete(book, e)} className="w-7 h-7 bg-red-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-red-600 tap-icon" title="删除图书">✕</button>
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
                              selectedIds.has(book.id) ? 'bg-blue-500 border-blue-500' : 'bg-white/90 dark:bg-gray-700/90 border-gray-400'
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
                      <div className="mt-1 flex items-center gap-1">
                        <span className="text-xs uppercase" style={{ color: 'var(--color-text-muted)' }}>{book.format}</span>
                        {book.status === 'processing' && (
                          <span className="text-xs text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30 px-1.5 py-0.5 rounded">解析中</span>
                        )}
                        {book.status === 'failed' && (
                          <span className="text-xs text-red-600 bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded" title={book.parseError || ''}>解析失败</span>
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
                          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%` }} />
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
                      {globalTtsInfo?.state !== 'idle' && globalTtsInfo?.bookId === book.id && (
                        <div className="absolute top-2 left-2 z-10">
                          <span className="bg-green-500 text-white text-xs px-1.5 py-0.5 rounded-full shadow-lg animate-pulse flex items-center gap-0.5">🔊</span>
                        </div>
                      )}
                      <button onClick={(e) => handleTogglePin(book, e)} className="w-7 h-7 bg-amber-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-amber-600 tap-icon" title={book.pinned ? '取消置顶' : '置顶'}>{book.pinned ? '📌' : '📍'}</button>
                      <button onClick={(e) => handleEditBook(book, e)} className="w-7 h-7 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-blue-600 tap-icon" title="编辑信息">✎</button>
                      <button onClick={(e) => handleDelete(book, e)} className="w-7 h-7 bg-red-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-red-600 tap-icon" title="删除图书">✕</button>
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
      {/* 批量选择操作栏 — 可扩展的 actions 数组驱动 */}
      {selectionMode && (
        <div className="fixed bottom-0 left-0 right-0 z-50 px-4 py-3"
          style={{
            background: 'var(--color-bg-card)',
            borderTop: '0.5px solid var(--color-border)',
            boxShadow: '0 -2px 12px rgba(0,0,0,0.06)',
          }}>
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                已选择 <strong style={{ color: 'var(--color-primary)' }}>{selectedIds.size}</strong> 本
              </span>
              <span style={{ color: 'var(--color-border)' }}>|</span>
              <button
                onClick={() => {
                  const allFilteredIds = new Set(filteredBooks.map(b => b.id));
                  if (allFilteredIds.size === selectedIds.size) {
                    // 已全选 → 全不选
                    setSelectedIds(new Set());
                  } else {
                    // 未全选 → 全选
                    setSelectedIds(allFilteredIds);
                  }
                }}
                className="text-sm font-medium transition-colors"
                style={{ color: 'var(--color-primary)' }}
              >
                {selectedIds.size > 0 && selectedIds.size >= filteredBooks.length ? '☐ 全不选' : '☑ 全选'}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={exitSelectionMode}
                className="px-4 py-2 text-sm rounded-xl transition-colors"
                style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}
              >
                取消
              </button>
              {/* ⭐ 可扩展操作列表：在此数组中添加新项即可扩展批量操作 */}
              {([
                {
                  id: 'delete',
                  label: '删除选中',
                  icon: '🗑',
                  color: 'bg-red-600',
                  hoverColor: 'hover:bg-red-700',
                  disabled: selectedIds.size === 0,
                  onClick: handleBatchDelete,
                },
                {
                  id: 'voice',
                  label: '预生成语音',
                  icon: '🎙',
                  color: 'bg-green-600',
                  hoverColor: 'hover:bg-green-700',
                  disabled: selectedIds.size === 0 || batchActionLoading === 'voice',
                  loading: batchActionLoading === 'voice',
                  onClick: handleBatchGenerateVoice,
                },
                {
                  id: 'dedup',
                  label: '去重',
                  icon: '🔄',
                  color: 'bg-purple-600',
                  hoverColor: 'hover:bg-purple-700',
                  disabled: deduping,
                  loading: deduping,
                  onClick: handleDedup,
                },
              ] as BatchAction[]).map(action => (
                <button
                  key={action.id}
                  onClick={action.onClick}
                  disabled={action.disabled}
                  className={`px-4 py-2 text-sm text-white rounded-lg transition-colors ${action.color} ${action.hoverColor} disabled:opacity-40 disabled:cursor-not-allowed`}
                >
                  {action.loading ? '⏳ 处理中...' : `${action.icon} ${action.label}`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── TTS 预生成队列可视化面板（支持批量选择） ── */}
      {showTtsQueue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }}>
                           <div className="rounded-2xl shadow-ios-lg max-w-lg w-full mx-4 max-h-[70vh] overflow-hidden flex flex-col animate-pop-in"
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--color-bg-card)' }}>
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '0.5px solid var(--color-border)' }}>
              <h3 className="text-base font-semibold flex items-center gap-1.5"
                style={{ color: 'var(--color-text)' }}>
                🎙 语音生成队列
                {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs"
                    style={{ color: 'var(--color-primary)' }}>
                    <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--color-primary)' }} />
                    任务进行中
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={fetchTTSJobs} className="text-xs px-2 py-1 rounded-xl tap-active"
                  style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}>🔄 刷新</button>
                <button onClick={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }} className="text-xl leading-none tap-icon"
                  style={{ color: 'var(--color-text-muted)' }}>&times;</button>
              </div>
            </div>
            {/* 批量选择工具栏 */}
            {ttsJobs.length > 0 && (
              <div className="flex items-center justify-between px-4 py-2"
                style={{ borderBottom: '0.5px solid var(--color-border)', background: 'var(--color-bg-alt)' }}>
                <div className="flex items-center gap-2">
                  <button onClick={selectAllJobs} className="text-xs px-2 py-1 rounded-lg transition-all duration-150 tap-active font-medium"
                    style={{ background: 'var(--color-primary-subtle)', color: 'var(--color-primary)' }}>
                    ☑ 全选
                  </button>
                  <button onClick={deselectAllJobs} className="text-xs px-2 py-1 rounded-lg transition-all duration-150 tap-active"
                    style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-card)' }}>
                    □ 取消全选
                  </button>
                </div>
                {selectedJobIds.size > 0 && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={handleBatchCancelSelected} className="text-xs px-2 py-1 rounded-lg transition-all duration-150 tap-active text-white"
                      style={{ background: '#FF9500' }} title="取消选中的排队/运行中任务">
                      ⏹ 取消选中
                    </button>
                    <button onClick={handleBatchDeleteSelected} className="text-xs px-2 py-1 rounded-lg transition-all duration-150 tap-active text-white"
                      style={{ background: '#FF3B30' }} title="删除选中的任务（不限状态）">
                      🗑 删除选中
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* 列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {ttsJobs.length === 0 ? (
                <p className="text-center py-8 text-sm" style={{ color: 'var(--color-text-muted)' }}>暂无语音生成任务</p>
              ) : (
                ttsJobs.slice(0, 30).map(job => {
                  const pct = job.totalChunks > 0 ? Math.min(job.completedChunks / job.totalChunks, 1) : 0;
                  const statusLabel: Record<string, string> = { pending: '排队中', running: '生成中', completed: '已完成', failed: '失败' };
                  const statusColor: Record<string, string> = {
                    pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
                    running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
                    completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
                    failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
                  };
                  const isSelected = selectedJobIds.has(job.id);
                  return (
                    <div
                      key={job.id}
                      className={`border rounded-xl p-3 cursor-pointer transition-all duration-200 ${
                        isSelected
                          ? ''
                          : ''
                      }`}
                      style={{
                        borderColor: isSelected ? 'var(--color-primary)' : 'var(--color-border)',
                        background: isSelected ? 'var(--color-primary-subtle)' : 'var(--color-bg-card)',
                      }}
                      onClick={() => toggleJobSelection(job.id)}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {/* 多选框 */}
                          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0`}
                            style={{
                              background: isSelected ? 'var(--color-primary)' : 'transparent',
                              borderColor: isSelected ? 'var(--color-primary)' : 'var(--color-border)',
                            }}>
                            {isSelected && <span className="text-white text-[10px] font-bold">✓</span>}
                          </div>
                          <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>
                            {job.bookTitle}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-2">
                          {(job.status === 'pending' || job.status === 'running') && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleCancelJob(job.id); }}
                              className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800/40 transition-colors"
                              title="取消此任务"
                            >
                              ✕ 取消
                            </button>
                          )}
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColor[job.status] || ''}`}>
                            {statusLabel[job.status] || job.status}
                          </span>
                        </div>
                      </div>
                      {(job.status === 'running' || job.status === 'pending') && (
                        <div className="mt-2 ml-6">
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                            <span>{job.completedChunks || 0} / {job.totalChunks || '?'} 段</span>
                            <span>{Math.round(pct * 100)}%</span>
                          </div>
                          <div className="w-full h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'var(--color-border)' }}>
                            <div className="h-full rounded-full transition-all duration-500"
                              style={{ width: `${Math.round(pct * 100)}%`, background: 'var(--color-primary)' }} />
                          </div>
                        </div>
                      )}
                      {job.status === 'completed' && (
                        <div className="text-xs text-green-600 dark:text-green-400 mt-1 ml-6">
                          ✅ 已生成 {job.completedChunks || job.totalChunks || '全部'} 段语音
                        </div>
                      )}
                      {job.status === 'failed' && (
                        <div className="text-xs text-red-500 mt-1 ml-6">{job.error || '生成失败'}</div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {/* 底部按钮 */}
            <div className="px-4 py-3 flex flex-col gap-2"
              style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <div className="flex justify-between items-center">
                <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                  共 {ttsJobs.length} 个任务 · {ttsJobs.filter(j => j.status === 'running').length} 个运行中 · {ttsJobs.filter(j => j.status === 'pending').length} 个排队中
                </span>
                <button onClick={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }}
                  className="text-sm px-3 py-1 rounded-xl"
                  style={{ color: 'var(--color-text-secondary)', background: 'var(--color-bg-alt)' }}>
                  关闭
                </button>
              </div>
              {/* 操作按钮组 */}
              <div className="flex items-center justify-end gap-2 flex-wrap">
                {/* 清除已完成/失败任务 */}
                {ttsJobs.some(j => j.status === 'completed' || j.status === 'failed') && (
                  <button
                    onClick={handleClearTerminated}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all duration-150 tap-active text-white"
                    style={{ background: 'var(--color-text-muted)' }}
                  >
                    🧹 清除已完成/失败
                  </button>
                )}
                {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                  <button
                    onClick={handleClearAllJobs}
                    className="text-xs px-3 py-1.5 rounded-lg transition-all duration-150 tap-active text-white"
                    style={{ background: '#FF3B30' }}
                  >
                    🗑 清除全部排队任务
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {globalTtsInfo?.bookId && (
        <div className="fixed bottom-0 left-0 right-0 z-40 glass-bar">
          {/* 进度条 */}
          <div className="max-w-7xl mx-auto">
            <div className="h-0.5" style={{ background: 'var(--color-border)' }}>
              <div
                className="h-full transition-all duration-300"
                style={{ width: `${Math.round(globalTtsInfo.progress * 100)}%`, background: 'var(--color-primary)' }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 px-5 py-3 max-w-7xl mx-auto">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: 'var(--color-text)' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline mr-1.5" style={{ color: 'var(--color-primary)' }}>
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
                {globalTtsInfo.bookTitle || '正在播放'}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {globalTtsInfo.state === 'playing' ? '播放中' : globalTtsInfo.state === 'paused' ? '已暂停' : '上次听到'}
                </span>
                <span className="text-xs font-semibold" style={{ color: 'var(--color-primary)' }}>
                  {Math.round(globalTtsInfo.progress * 100)}%
                </span>
              </div>
            </div>
            <button
              onClick={async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const player = getDefaultPlayer();
                if (player.currentBookId === globalTtsInfo.bookId) {
                  if (globalTtsInfo.state === 'playing') player.pause();
                  else if (globalTtsInfo.state === 'paused') player.resume();
                } else {
                  try {
                    const lastPlayback = getLastPlaybackFromLocalStorage();
                    if (!lastPlayback || lastPlayback.bookId !== globalTtsInfo.bookId) return;
                    const [chaptersRes] = await Promise.all([
                      axios.get(`/api/books/${globalTtsInfo.bookId}/chapters`),
                    ]);
                    const chapters = chaptersRes.data.data || [];
                    if (chapters.length === 0) return;
                    let targetChapter = chapters[0];
                    if (lastPlayback.chapterId) {
                      const saved = chapters.find((c: any) => c.id === lastPlayback.chapterId);
                      if (saved) targetChapter = saved;
                    }
                    const contentRes = await axios.get(`/api/books/${globalTtsInfo.bookId}/chapters/${targetChapter.id}/content`);
                    const content = contentRes.data.data;
                    if (!content) return;
                    player.init({
                      bookId: globalTtsInfo.bookId,
                      bookTitle: globalTtsInfo.bookTitle || lastPlayback.bookTitle,
                    });
                    const contentText = content.text || content.content || content;
                    const isHtml = typeof contentText === 'string' && /<[a-z][\s\S]*?>/i.test(contentText);
                    await player.load(contentText, isHtml, targetChapter.id);
                    if (lastPlayback.currentIndex > 0) {
                      player['currentIndex'] = lastPlayback.currentIndex;
                    }
                    await player.play();
                  } catch { /* 恢复播放失败时静默处理 */ }
                }
              }}
              className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 active:scale-90 shadow-lg ripple-btn shrink-0"
              style={{ background: 'var(--color-primary)', color: 'white' }}
            >
              {globalTtsInfo.state === 'playing' ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <polygon points="5 3 19 12 5 21 5 3" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
}