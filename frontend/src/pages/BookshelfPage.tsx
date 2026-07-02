import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

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
}

interface BookStats {
  readingPercentage: number;
  voiceGenerationRate: number;
  totalChapters: number;
  completedVoiceChapters: number;
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
  const [showUpload, setShowUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // ── Upload (支持多文件) ──
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;

    const files = Array.from(fileList);

    // Separate supported and unsupported files
    const supported: File[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'epub' || ext === 'txt') {
        supported.push(file);
      } else {
        skipped.push(file.name);
      }
    }

    // If nothing supported, show message and stop
    if (supported.length === 0) {
      setUploadProgress(
        skipped.length === 1
          ? `「${skipped[0]}」格式不支持，仅支持 EPUB 和 TXT`
          : `所选文件均不支持（仅支持 EPUB 和 TXT）`
      );
      return;
    }

    setUploading(true);
    const skipMsg = skipped.length > 0 ? `（已跳过 ${skipped.length} 个不支持的文件）` : '';
    setUploadProgress(`上传中 ${supported.length} 个文件${skipMsg}...`);

    try {
      const formData = new FormData();
      for (const file of supported) {
        formData.append('files', file);
      }

      const res = await axios.post('/api/books/upload', formData);

      const uploaded = res.data.data || [];
      const serverSkipped: Array<{ fileName: string; reason: string }> = res.data.skipped || [];
      const success = uploaded.filter((b: any) => b?.status === 'ready').length;
      const failed = uploaded.filter((b: any) => b?.status === 'failed').length;
      const processing = uploaded.filter((b: any) => b?.status === 'processing').length;

      const parts: string[] = [`上传完成 ✅ 成功 ${success}`];
      if (failed) parts.push(`失败 ${failed}`);
      if (processing) parts.push(`处理中 ${processing}`);
      if (serverSkipped.length > 0) parts.push(`跳过 ${serverSkipped.length} 个`);
      else if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个`);

      setUploadProgress(parts.join('，'));
      await loadData();

      // Reset after short delay
      setTimeout(() => {
        setShowUpload(false);
        setUploadProgress(null);
        setUploading(false);
      }, 2000);
    } catch (err: any) {
      setUploadProgress(err.response?.data?.error || '上传失败');
      setUploading(false);
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
    <div className="max-w-7xl mx-auto px-3 sm:px-4 py-4 sm:py-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-bold">我的书架</h1>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {/* 搜索框 */}
          <div className="relative flex-1 sm:w-56">
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
            onClick={() => setShowUpload(true)}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors whitespace-nowrap"
          >
            + 上传图书
          </button>
        </div>
      </div>

      {/* Upload Modal */}
      {showUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => !uploading && setShowUpload(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold mb-4">上传图书</h2>

            <div
              className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".epub,.txt"
                multiple
                className="hidden"
                onChange={handleFileSelect}
                disabled={uploading}
              />
              {uploadProgress ? (
                <div>
                  <p className="text-lg mb-2">{uploading ? '⏳' : '✅'}</p>
                  <p className="text-gray-600 dark:text-gray-300 whitespace-pre-wrap">{uploadProgress}</p>
                </div>
              ) : (
                <div>
                  <p className="text-4xl mb-2">📁</p>
                  <p className="text-gray-600 dark:text-gray-300">点击选择 EPUB 或 TXT 文件</p>
                  <p className="text-sm text-gray-400 mt-1">可多选，最大 500MB/个</p>
                </div>
              )}
            </div>

            <div className="flex justify-end mt-4">
              <button
                onClick={() => setShowUpload(false)}
                disabled={uploading}
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg disabled:opacity-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar + Content */}
      {/* Edit Modal */}
      {editingBook && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditingBook(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-6 w-full max-w-md mx-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
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
                className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg"
              >
                取消
              </button>
              <button
                onClick={handleSaveEdit}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
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
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2 sm:gap-3">
              {filteredBooks.map((book) => (
                <div key={book.id} className="relative group">
                  <a
                    href={`/reader/${book.id}`}
                    className="block p-2 sm:p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:shadow-md transition-shadow bg-white dark:bg-gray-800"
                  >
                    <div className="aspect-[3/4] bg-gray-100 dark:bg-gray-700 rounded mb-2 flex items-center justify-center overflow-hidden">
                      <img
                        src={`/api/books/${book.id}/cover`}
                        alt={book.title}
                        className="w-full h-full object-cover rounded"
                        loading="lazy"
                        onError={(e) => {
                          // Fallback to emoji on load error
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
                        <span className="text-xs text-yellow-600 bg-yellow-100 dark:bg-yellow-900/30 px-1.5 py-0.5 rounded">
                          解析中
                        </span>
                      )}
                      {book.status === 'failed' && (
                        <span className="text-xs text-red-600 bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded" title={book.parseError || ''}>
                          解析失败
                        </span>
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
                          <div
                            className="h-full bg-blue-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(bookStats[book.id].readingPercentage * 100)}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-gray-500 dark:text-gray-400">语音</span>
                          <span className="text-gray-700 dark:text-gray-300 font-medium">
                            {Math.round((bookStats[book.id].voiceGenerationRate || 0) * bookStats[book.id].totalChapters)}/{bookStats[book.id].totalChapters}章
                            {bookStats[book.id].ttsCacheCount ? ` · ${bookStats[book.id].ttsCacheCount}条` : ''}
                          </span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500 rounded-full transition-all duration-500"
                            style={{ width: `${Math.round(bookStats[book.id].voiceGenerationRate * 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </a>
                  {/* Action buttons */}
                  <div className="absolute top-2 right-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => handleEditBook(book, e)}
                      className="w-7 h-7 bg-blue-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-blue-600"
                      title="编辑信息"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => handleDelete(book, e)}
                      className="w-7 h-7 bg-red-500 text-white rounded-full flex items-center justify-center text-sm hover:bg-red-600"
                      title="删除图书"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default BookshelfPage;
