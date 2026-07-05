import { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import axios from 'axios';

/* ───────── Types ───────── */
interface UploadTask {
  id: string;
  fileName: string;
  fileSize: number;
  status: 'pending' | 'uploading' | 'success' | 'failed';
  progress: number;       // 0–100
  error?: string;
  bookId?: string;
  addedAt: string;        // ISO string
}

export interface UploadQueueStats {
  total: number;
  active: number;   // pending + uploading
  completed: number;
  failed: number;
}

export interface UploadQueueHandle {
  show: () => void;
}

interface UploadQueueProps {
  onComplete: () => void;   // 重新加载书架
  onClose: () => void;
  onStatsChange?: (stats: UploadQueueStats) => void;
}

/* ───────── Persistence keys ───────── */
const STORAGE_KEY = 'ireader_upload_queue';
const CONCURRENCY = 5;

/* ───────── Helpers ───────── */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ───────── Component ───────── */
const UploadQueue = forwardRef<UploadQueueHandle, UploadQueueProps>(({ onComplete, onClose, onStatsChange }, ref) => {
  /* 队列状态 —— 持久化到 localStorage */
  const [tasks, setTasks] = useState<UploadTask[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed: UploadTask[] = JSON.parse(saved);
        // 把 reload 前的 uploading 重置为 pending
        return parsed.map(t =>
          t.status === 'uploading' ? { ...t, status: 'pending' as const, progress: 0 } : t
        );
      }
    } catch { /* ignore */ }
    return [];
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const runningRef = useRef(0);          // 当前并发数
  const abortMapRef = useRef<Map<string, AbortController>>(new Map());

  /* ── 持久化到 localStorage ── */
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch { /* quota exceeded — silent */ }
  }, [tasks]);

  /* ── 队列调度：取出 pending 任务，启动上传 ── */
  const uploadOneRef = useRef<() => void>();
  uploadOneRef.current = () => {
    if (runningRef.current >= CONCURRENCY) return;

    setTasks(prev => {
      const pending = prev.find(t => t.status === 'pending');
      if (!pending) return prev;       // 没有待上传的

      runningRef.current += 1;
      // 立即标记为 uploading
      doUpload(pending.id);

      return prev.map(t =>
        t.id === pending.id ? { ...t, status: 'uploading' as const, progress: 0 } : t
      );
    });
  };

  /* ── 执行单文件上传 ── */
  const doUpload = async (taskId: string) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const controller = new AbortController();
    abortMapRef.current.set(taskId, controller);

    const formData = new FormData();
    // 文件本身我们需要从什么地方获取？ — 当用户选择文件时，需要把 File 对象临时存起来
    // 所以实际上我们需要额外存储 File 对象映射

    // 等一下——File 对象不能序列化到 localStorage，所以我们需要在内存中维护一个 Map
    const fileObj = fileMapRef.current.get(taskId);
    if (!fileObj) {
      setTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, status: 'failed' as const, error: '文件对象丢失，请重新选择' } : t
      ));
      runningRef.current -= 1;
      uploadOneRef.current?.();
      return;
    }

    formData.append('file', fileObj);

    try {
      // 先标记进度为 0
      setTasks(prev => prev.map(t =>
        t.id === taskId ? { ...t, progress: 1 } : t
      ));

      const res = await axios.post('/api/books/upload', formData, {
        signal: controller.signal,
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (e) => {
          if (e.total) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setTasks(prev => prev.map(t =>
              t.id === taskId ? { ...t, progress: Math.min(pct, 99) } : t
            ));
          }
        },
      });

      if (res.data?.success && res.data?.data) {
        setTasks(prev => prev.map(t =>
          t.id === taskId
            ? { ...t, status: 'success' as const, progress: 100, bookId: res.data.data.id }
            : t
        ));
      } else {
        throw new Error(res.data?.error || '上传响应异常');
      }
    } catch (err: any) {
      if (axios.isCancel(err)) {
        // 用户取消了上传，不做特殊处理
        setTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: 'pending' as const, progress: 0 } : t
        ));
      } else {
        const msg = err.response?.data?.error || err.message || '上传失败';
        setTasks(prev => prev.map(t =>
          t.id === taskId ? { ...t, status: 'failed' as const, error: msg } : t
        ));
      }
    } finally {
      abortMapRef.current.delete(taskId);
      runningRef.current -= 1;
      // 调度下一个
      setTimeout(() => uploadOneRef.current?.(), 100);
    }
  };

  /* ── 当 tasks 变化后，检查是否需要启动新的上传 ── */
  const hasPendingRef = useRef(false);
  useEffect(() => {
    const pending = tasks.some(t => t.status === 'pending');
    if (pending && !hasPendingRef.current) {
      hasPendingRef.current = true;
      uploadOneRef.current?.();
    }
    if (!pending) hasPendingRef.current = false;
  }, [tasks]);

  /* ── 文件变更处理（从 file input 选择文件） ── */
  const fileMapRef = useRef<Map<string, File>>(new Map());

  /* ── 最小化模式（关闭弹窗但后台继续上传） ── */
  const [minimized, setMinimized] = useState(true);

  /* ── 暴露给父组件的方法 ── */
  useImperativeHandle(ref, () => ({
    show: () => setMinimized(false),
  }));

  /* ── 统计变化通知父组件 ── */
  useEffect(() => {
    onStatsChange?.({
      total: tasks.length,
      active: tasks.filter(t => t.status === 'pending' || t.status === 'uploading').length,
      completed: tasks.filter(t => t.status === 'success').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    });
  }, [tasks, onStatsChange]);

  const handleFilesSelected = useCallback((fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;

    const newTasks: UploadTask[] = [];
    const now = new Date().toISOString();

    Array.from(fileList).forEach(file => {
      const id = generateId();
      fileMapRef.current.set(id, file);
      newTasks.push({
        id,
        fileName: file.name,
        fileSize: file.size,
        status: 'pending',
        progress: 0,
        addedAt: now,
      });
    });

    setTasks(prev => [...prev, ...newTasks]);
  }, []);

  /* ── 从文件管理器选择 ── */
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFilesSelected(e.target.files);
    // 重置 input 以便再次选择同一文件
    e.target.value = '';
  };

  /* ── 拖拽上传 ── */
  const [dragging, setDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    handleFilesSelected(e.dataTransfer.files);
  };

  /* ── 重试单个 ── */
  const handleRetry = (taskId: string) => {
    setTasks(prev => prev.map(t =>
      t.id === taskId ? { ...t, status: 'pending' as const, progress: 0, error: undefined } : t
    ));
  };

  /* ── 重试所有失败 ── */
  const handleRetryAll = () => {
    setTasks(prev => prev.map(t =>
      t.status === 'failed' ? { ...t, status: 'pending' as const, progress: 0, error: undefined } : t
    ));
  };

  /* ── 移除单个任务 ── */
  const handleRemove = (taskId: string) => {
    // 如果正在上传，尝试取消
    const ctrl = abortMapRef.current.get(taskId);
    if (ctrl) {
      ctrl.abort();
      runningRef.current = Math.max(0, runningRef.current - 1);
    }
    fileMapRef.current.delete(taskId);
    setTasks(prev => prev.filter(t => t.id !== taskId));
  };

  /* ── 清除所有已完成 ── */
  const handleClearCompleted = () => {
    setTasks(prev => prev.filter(t => t.status !== 'success'));
  };

  /* ── 最小化（后台继续上传） ── */
  const handleMinimize = () => {
    setMinimized(true);
    onClose();
  };

  /* ── 完成并最小化 ── */
  const handleFinish = () => {
    onComplete();
    setMinimized(true);
    onClose();
  };

  /* ── 统计 ── */
  const total = tasks.length;
  const successCount = tasks.filter(t => t.status === 'success').length;
  const failedCount = tasks.filter(t => t.status === 'failed').length;
  const pendingCount = tasks.filter(t => t.status === 'pending' || t.status === 'uploading').length;

  const overallProgress = total > 0
    ? Math.round(tasks.reduce((sum, t) => sum + t.progress, 0) / total)
    : 0;

  const hasCompleted = successCount > 0 || failedCount > 0;

  /* ── 最小化时不渲染 UI，上传继续 ── */
  if (minimized) return null;

  
  /* ═════════════════════════ Render ═════════════════════════ */
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold">
            上传图书
            {total > 0 && <span className="text-sm font-normal text-gray-500 ml-2">({total} 本)</span>}
          </h2>
          <button
            onClick={handleMinimize}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 tap-icon"
            title="最小化（后台继续上传）"
          >
            ⛅
          </button>
        </div>

        {/* ── Drop Zone / 文件选择 ── */}
        <div className="p-4">
          <div
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
              dragging
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-blue-400'
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !dragging && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".epub,.txt,.zip"
              multiple
              className="hidden"
              onChange={handleInputChange}
            />
            <p className="text-4xl mb-2">{dragging ? '📥' : '📁'}</p>
            <p className="text-gray-600 dark:text-gray-300 font-medium">
              {dragging ? '松开鼠标添加文件' : '点击或拖拽 EPUB / TXT 文件到这里'}
            </p>
            <p className="text-sm text-gray-400 mt-1">支持批量选择，最大 500MB/个（兼容 .epub.zip 格式）</p>
          </div>
        </div>

        {/* ── Overall Progress Bar ── */}
        {total > 0 && (
          <div className="px-4 pb-2">
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-400">
                总体进度
              </span>
              <span className="text-gray-700 dark:text-gray-300 font-medium">
                {overallProgress}%
              </span>
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{ width: `${overallProgress}%` }}
              />
            </div>
          </div>
        )}

        {/* ── Stats Bar ── */}
        {hasCompleted && (
          <div className="px-4 pb-2 flex items-center gap-4 text-sm">
            <span className="text-green-600 dark:text-green-400">✅ 成功 {successCount}</span>
            {failedCount > 0 && (
              <span className="text-red-600 dark:text-red-400">❌ 失败 {failedCount}</span>
            )}
            {pendingCount > 0 && (
              <span className="text-yellow-600 dark:text-yellow-400">⏳ 待上传 {pendingCount}</span>
            )}
            <span className="text-gray-500">📊 {total} 本</span>
          </div>
        )}

        {/* ── Queue List ── */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0 max-h-80">
          {total === 0 ? (
            <div className="text-center py-10 text-gray-400 dark:text-gray-500">
              <p className="text-5xl mb-3">📚</p>
              <p>还没有选择文件</p>
            </div>
          ) : (
            <div className="space-y-2">
              {tasks.map(task => (
                <div
                  key={task.id}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
                    task.status === 'success'
                      ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10'
                      : task.status === 'failed'
                      ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10'
                      : task.status === 'uploading'
                      ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/10'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                >
                  {/* Status Icon */}
                  <div className="shrink-0 w-8 text-center text-lg">
                    {task.status === 'success' && '✅'}
                    {task.status === 'failed' && '❌'}
                    {task.status === 'uploading' && '⏳'}
                    {task.status === 'pending' && '📄'}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" title={task.fileName}>
                      {task.fileName}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-gray-500">{formatSize(task.fileSize)}</span>
                      {task.status === 'uploading' && (
                        <span className="text-xs text-blue-600">{task.progress}%</span>
                      )}
                      {task.status === 'success' && (
                        <span className="text-xs text-green-600">上传完成</span>
                      )}
                      {task.status === 'failed' && task.error && (
                        <span className="text-xs text-red-600 truncate" title={task.error}>
                          {task.error}
                        </span>
                      )}
                    </div>

                    {/* Per-file progress bar (uploading only) */}
                    {task.status === 'uploading' && (
                      <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1.5 overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-200"
                          style={{ width: `${task.progress}%` }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="shrink-0 flex gap-1">
                    {task.status === 'failed' && (
              <button
                onClick={() => handleRetry(task.id)}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors tap-active"
                title="重试"
              >
                重试
              </button>
                    )}
                    <button
                      onClick={() => handleRemove(task.id)}
                      className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors tap-icon"
                      title="移除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Footer Actions ── */}
        <div className="flex items-center justify-between p-4 border-t border-gray-200 dark:border-gray-700">
          <div className="flex gap-2">
            {failedCount > 0 && (
              <button
                onClick={handleRetryAll}
                className="px-3 py-1.5 text-sm bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors tap-active"
              >
                重试全部失败 ({failedCount})
              </button>
            )}
            {successCount > 0 && (
              <button
                onClick={handleClearCompleted}
                className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors tap-active"
              >
                清除已完成
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleMinimize}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors tap-active"
            >
              后台运行
            </button>
            <button
              onClick={handleFinish}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors ripple-btn"
            >
              完成并刷新
            </button>
          </div>
        </div>
      </div>
    </div>
    );
});

export default UploadQueue;

