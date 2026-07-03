import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import axios from 'axios';
import { subscribeGlobalPlayer, getGlobalPlayerSnapshot, getDefaultPlayer, getLastPlaybackFromLocalStorage, type PlayerState } from '../services/ttsPlayer';
import UploadQueue, { type UploadQueueStats, type UploadQueueHandle } from '../components/UploadQueue';
import { APP_VERSION } from '../version';

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

function BookshelfPage() {
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

  const loadData = async () => {
    try {
      setLoading(true);
      const [booksRes, catsRes] = await Promise.all([
        axios.get('/api/books'),
        axios.get('/api/categories'),
      ]);
      setBooks(booksRes.data.data || []);
      setCategories(catsRes.data.data || []);
      setError(null);
    } catch (err: any) {
      setError(err.response?.data?.error || '加载数据失败');
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
          <button
            onClick={loadData}
            className="mt-2 px-4 py-1 bg-red-600 text-white rounded hover:bg-red-700"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className={`max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8 ${globalTtsInfo?.state !== 'idle' && globalTtsInfo?.bookId ? 'pb-24' : ''}`}>
      {/* Header */}
      <div className="mb-6">
        {/* Row 1: 标题行 + 桌面端操作栏 */}
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold flex items-center gap-2 shrink-0">
             我的书架
             <span className="text-xs text-gray-400 dark:text-gray-500 font-normal bg-gray-100 dark:bg-gray-700/50 px-1.5 py-0.5 rounded select-none">
               v{APP_VERSION}
             </span>
              {/* 预合成活跃指示器（点击可跳转到队列面板） */}
              {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                <button onClick={() => setShowTtsQueue(true)}
                  className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 ml-1 cursor-pointer hover:text-green-700 dark:hover:text-green-300 transition-colors"
                  title="点击查看 TTS 队列">
                  <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse shadow-sm shadow-green-400/50" />
                  合成中
                </button>
              )}
          </h1>
          {/* 桌面端（sm+）：操作栏与标题同行 */}
          <div className="hidden sm:flex items-center gap-2">
            {/* 搜索框 */}
            <div className="relative w-56">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索书名或作者..."
                className="w-full px-3 py-2 pl-9 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            </div>
            <button
              onClick={() => { setSelectionMode(true); setSelectedIds(new Set()); }}
              className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200 tap-active whitespace-nowrap"
            >
              ☐ 批量选择
            </button>
            <button
              onClick={() => uploadQueueRef.current?.show()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-all duration-200 ripple-btn whitespace-nowrap"
            >
              + 上传图书
            </button>
            {/* 书籍去重按钮 */}
            <button
              onClick={handleDedup}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200 tap-active whitespace-nowrap"
              title="扫描并删除书架上的重复书籍"
            >
              🔄 去重
            </button>
            {/* 上传队列图标（带角标）— 队列有任务时动态显示 */}
            {uploadStats.total > 0 && (
              <button
                onClick={() => uploadQueueRef.current?.show()}
                className="relative px-2 sm:px-3 py-1 rounded text-xs sm:text-sm hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={`上传队列：${uploadStats.active} 个进行中，${uploadStats.completed} 个完成`}
              >
                📤
                {uploadStats.active > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 sm:-top-1 sm:-right-1 inline-flex items-center justify-center w-4 h-4 sm:w-5 sm:h-5 text-[10px] sm:text-xs font-bold text-white bg-red-500 rounded-full">
                    {uploadStats.active > 99 ? '99+' : uploadStats.active}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>
        {/* 移动端（< sm）：搜索 + 操作分两行排列 */}
        <div className="sm:hidden mt-3 space-y-2">
          {/* 第1行：搜索框（全宽） */}
          <div className="relative w-full">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索书名或作者..."
              className="w-full px-3 py-2 pl-9 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
          </div>
          {/* 第2行：操作按钮组（可横向滚动） */}
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide -mx-1 px-1 pb-0.5">
            <button
              onClick={() => { setSelectionMode(true); setSelectedIds(new Set()); }}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200 tap-active whitespace-nowrap shrink-0"
            >
              ☐ 批量选择
            </button>
            <button
              onClick={() => uploadQueueRef.current?.show()}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-all duration-200 ripple-btn whitespace-nowrap shrink-0 shadow-sm"
            >
              + 上传图书
            </button>
            <button
              onClick={handleDedup}
              className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-all duration-200 tap-active whitespace-nowrap shrink-0"
              title="扫描并删除书架上的重复书籍"
            >
              🔄 去重
            </button>
            {/* 上传队列图标（带角标） */}
            {uploadStats.total > 0 && (
              <button
                onClick={() => uploadQueueRef.current?.show()}
                className="relative shrink-0 px-2 py-2 rounded text-xs hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                title={`上传队列：${uploadStats.active} 个进行中，${uploadStats.completed} 个完成`}
              >
                📤
                {uploadStats.active > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-red-500 rounded-full">
                    {uploadStats.active > 99 ? '99+' : uploadStats.active}
                  </span>
                )}
              </button>
            )}
          </div>
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
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-xl animate-pop-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">编辑图书信息</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">书名</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">作者</label>
                <input
                  type="text"
                  value={editAuthor}
                  onChange={(e) => setEditAuthor(e.target.value)}
                  placeholder="可选"
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setEditingBook(null)}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg tap-active"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 ripple-btn"
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
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                selectedCategoryId === null
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              全部 ({books.length})
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setSelectedCategoryId(cat.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  selectedCategoryId === cat.id
                    ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 font-medium'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                }`}
              >
                {cat.name} ({categoryCount.get(cat.id) || 0})
              </button>
            ))}
          </div>
        </div>

        {/* Book Grid */}
        <div className="flex-1">
          {filteredBooks.length === 0 ? (
            <div className="text-center py-16 text-gray-500 dark:text-gray-400">
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
                  <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
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
                    className={`block p-2 sm:p-3 border rounded-lg transition-all duration-200 bg-white dark:bg-gray-800 tap-row ${
                      selectionMode && selectedIds.has(book.id)
                        ? 'border-blue-500 ring-2 ring-blue-300 dark:ring-blue-700'
                        : 'border-gray-200 dark:border-gray-700 hover:shadow-md'
                    }`}
                  >
                    <div className="aspect-[3/4] bg-gray-100 dark:bg-gray-700 rounded mb-2 flex items-center justify-center overflow-hidden relative">
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
                        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 dark:text-gray-400">语音</span>
                          <span className="text-gray-700 dark:text-gray-300 font-medium">
                            {bookStats[book.id].totalVoiceChunks > 0
                              ? `${bookStats[book.id].completedVoiceChapters}/${bookStats[book.id].totalVoiceChunks}段`
                              : `${Math.round((bookStats[book.id].voiceGenerationRate || 0) * bookStats[book.id].totalChapters)}/${bookStats[book.id].totalChapters}章`}
                            {bookStats[book.id].ttsCacheCount ? ` · ${bookStats[book.id].ttsCacheCount}条` : ''}
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div className="h-full bg-green-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].voiceGenerationRate * 100)}%` }} />
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
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 flex items-center gap-1.5">
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
                      className={`block p-2 sm:p-3 border rounded-lg transition-all duration-200 bg-white dark:bg-gray-800 tap-row ${
                        selectionMode && selectedIds.has(book.id)
                          ? 'border-blue-500 ring-2 ring-blue-300 dark:ring-blue-700'
                          : 'border-gray-200 dark:border-gray-700 hover:shadow-md'
                      }`}
                    >
                      <div className="aspect-[3/4] bg-gray-100 dark:bg-gray-700 rounded mb-2 flex items-center justify-center overflow-hidden relative">
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
                      {book.status === 'ready' && bookStats[book.id] && (
                        <div className="mt-2 space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500 dark:text-gray-400">阅读</span>
                            <span className="text-gray-700 dark:text-gray-300 font-medium">
                              {Math.round(bookStats[book.id].readingPercentage * 100)}%
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%` }} />
                          </div>
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-gray-500 dark:text-gray-400">语音</span>
                            <span className="text-gray-700 dark:text-gray-300 font-medium">
                              {bookStats[book.id].totalVoiceChunks > 0
                                ? `${bookStats[book.id].completedVoiceChapters}/${bookStats[book.id].totalVoiceChunks}段`
                                : `${Math.round((bookStats[book.id].voiceGenerationRate || 0) * bookStats[book.id].totalChapters)}/${bookStats[book.id].totalChapters}章`}
                              {bookStats[book.id].ttsCacheCount ? ` · ${bookStats[book.id].ttsCacheCount}条` : ''}
                            </span>
                          </div>
                          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full transition-all duration-500" style={{ width: `${Math.round(bookStats[book.id].voiceGenerationRate * 100)}%` }} />
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
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-2xl px-4 py-3">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-700 dark:text-gray-300">
                已选择 <strong className="text-blue-600 dark:text-blue-400">{selectedIds.size}</strong> 本
              </span>
              <span className="text-gray-300 dark:text-gray-600">|</span>
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
                className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 font-medium transition-colors"
              >
                {selectedIds.size > 0 && selectedIds.size >= filteredBooks.length ? '☐ 全不选' : '☑ 全选'}
              </button>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={exitSelectionMode}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
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
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[70vh] overflow-hidden flex flex-col animate-pop-in"
            onClick={(e) => e.stopPropagation()}>
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-1.5">
                🎙 语音生成队列
                {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                  <span className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
                    <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    任务进行中
                  </span>
                )}
              </h3>
              <div className="flex items-center gap-2">
                <button onClick={fetchTTSJobs} className="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 tap-active">🔄 刷新</button>
                <button onClick={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none tap-icon">&times;</button>
              </div>
            </div>
            {/* 批量选择工具栏 */}
            {ttsJobs.length > 0 && (
              <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                <div className="flex items-center gap-2">
                  <button onClick={selectAllJobs} className="text-xs px-2 py-1 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800/60 transition-all duration-150 tap-active">
                    ☑ 全选
                  </button>
                  <button onClick={deselectAllJobs} className="text-xs px-2 py-1 rounded bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 transition-all duration-150 tap-active">
                    □ 取消全选
                  </button>
                </div>
                {selectedJobIds.size > 0 && (
                  <div className="flex items-center gap-1.5">
                    <button onClick={handleBatchCancelSelected} className="text-xs px-2 py-1 rounded bg-yellow-500 text-white hover:bg-yellow-600 transition-all duration-150 tap-active" title="取消选中的排队/运行中任务">
                      ⏹ 取消选中
                    </button>
                    <button onClick={handleBatchDeleteSelected} className="text-xs px-2 py-1 rounded bg-red-500 text-white hover:bg-red-600 transition-all duration-150 tap-active" title="删除选中的任务（不限状态）">
                      🗑 删除选中
                    </button>
                  </div>
                )}
              </div>
            )}
            {/* 列表 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {ttsJobs.length === 0 ? (
                <p className="text-center text-gray-400 dark:text-gray-500 py-8 text-sm">暂无语音生成任务</p>
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
                      className={`border rounded-lg p-3 cursor-pointer transition-colors ${
                        isSelected
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600'
                          : 'border-gray-100 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                      }`}
                      onClick={() => toggleJobSelection(job.id)}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                          {/* 多选框 */}
                          <div className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                            isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-300 dark:border-gray-500'
                          }`}>
                            {isSelected && <span className="text-white text-[10px] font-bold">✓</span>}
                          </div>
                          <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
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
                          <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                            <div className="h-full bg-blue-500 rounded-full transition-all duration-500"
                              style={{ width: `${Math.round(pct * 100)}%` }} />
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
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-gray-400">
                  共 {ttsJobs.length} 个任务 · {ttsJobs.filter(j => j.status === 'running').length} 个运行中 · {ttsJobs.filter(j => j.status === 'pending').length} 个排队中
                </span>
                <button onClick={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }}
                  className="text-sm text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white px-3 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
                  关闭
                </button>
              </div>
              {/* 操作按钮组 */}
              <div className="flex items-center justify-end gap-2 flex-wrap">
                {/* 清除已完成/失败任务 */}
                {ttsJobs.some(j => j.status === 'completed' || j.status === 'failed') && (
                  <button
                    onClick={handleClearTerminated}
                    className="text-xs px-3 py-1.5 rounded bg-gray-500 text-white hover:bg-gray-600 transition-all duration-150 tap-active"
                  >
                    🧹 清除已完成/失败
                  </button>
                )}
                {ttsJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                  <button
                    onClick={handleClearAllJobs}
                    className="text-xs px-3 py-1.5 rounded bg-red-500 text-white hover:bg-red-600 transition-all duration-150 tap-active"
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
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 shadow-2xl">
          {/* 进度条与书架整排宽度一致 */}
          <div className="max-w-7xl mx-auto">
            <div className="h-0.5 bg-gray-200 dark:bg-gray-700">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.round(globalTtsInfo.progress * 100)}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-3 px-4 py-3 max-w-7xl mx-auto">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                🔊 {globalTtsInfo.bookTitle || '正在播放'}
              </p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {globalTtsInfo.state === 'playing' ? '播放中' : globalTtsInfo.state === 'paused' ? '已暂停' : '上次听到'}
                </span>
                <span className="text-xs text-blue-500 font-medium">
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
                    await player.load(content.text || content.content || content, false, targetChapter.id);
                    if (lastPlayback.currentIndex > 0) {
                      player['currentIndex'] = lastPlayback.currentIndex;
                    }
                    await player.play();
                  } catch { /* 恢复播放失败时静默处理 */ }
                }
              }}
              className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center hover:bg-blue-600 transition-all duration-200 active:scale-90 shadow-lg ripple-btn shrink-0"
            >
              {globalTtsInfo.state === 'playing' ? '⏸' : '▶'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default BookshelfPage;
