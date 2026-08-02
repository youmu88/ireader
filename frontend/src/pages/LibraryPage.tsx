import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import UploadQueue, { type UploadQueueHandle } from '../components/UploadQueue';
import TtsQueuePanel from '../components/TtsQueuePanel';
import { Button, toast, confirm } from '../components/ui';
import { useTtsQueue } from '../hooks/useTtsQueue';

interface Book {
  id: string;
  title: string;
  author: string | null;
  status: 'processing' | 'ready' | 'failed';
}

const TABS = ['上传图书', '批量选择', '预合成语音'] as const;
type TabId = (typeof TABS)[number];

/** 图书管理页：上传队列 + 批量选择 + 预合成语音，全部打通现有 API，含任务进度可视化 */
export function LibraryPage() {
  const [tab, setTab] = useState<TabId>('批量选择');
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 批量动作 loading 标识：'delete' | 'cache' | 'voice' */
  const [batchAction, setBatchAction] = useState<string | null>(null);
  const uploadRef = useRef<UploadQueueHandle>(null);

  // ── TTS 语音生成队列（共享 hook：状态/轮询/操作） ──
  const {
    ttsJobs, showTtsQueue, setShowTtsQueue, selectedJobIds, activeCount,
    fetchTTSJobs, toggleJobSelection, selectAllJobs, deselectAllJobs,
    handleCancelJob, handleBatchCancelSelected, handleBatchDeleteSelected,
    handleClearTerminated, handleClearAllJobs, closeQueue,
  } = useTtsQueue();

  const loadBooks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/books');
      const data = res.data?.data ?? res.data ?? [];
      setBooks(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.warn('书架加载失败:', err);
      setBooks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBooks(); }, [loadBooks]);

  const filtered = keyword.trim()
    ? books.filter((b) => b.title.includes(keyword.trim()))
    : books;

  const allFilteredIds = new Set(filtered.map((b) => b.id));
  const allSelected = filtered.length > 0 && allFilteredIds.size === selectedIds.size && selectedIds.size > 0;

  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(allFilteredIds);
  };

  const toggleSelectOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const exitSelection = () => setSelectedIds(new Set());

  /** 批量删除：对选中书籍逐个调用 DELETE /api/books/:id */
  const handleBatchDelete = async () => {
    if (selectedIds.size === 0) return;
    const ok = await confirm({
      title: '删除确认',
      message: `确定删除选中的 ${selectedIds.size} 本书？此操作不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBatchAction('delete');
    try {
      await Promise.all([...selectedIds].map((id) => axios.delete(`/api/books/${id}`)));
      toast.success(`已删除 ${selectedIds.size} 本图书`);
      exitSelection();
      await loadBooks();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量删除失败');
    } finally {
      setBatchAction(null);
    }
  };

  /** 批量缓存：对选中书籍提交全书离线缓存 POST /api/books/:id/cache */
  const handleBatchCache = async () => {
    if (selectedIds.size === 0) return;
    setBatchAction('cache');
    try {
      await Promise.all([...selectedIds].map((id) =>
        axios.post(`/api/books/${id}/cache`, { type: 'full' })
      ));
      toast.success(`已提交 ${selectedIds.size} 本图书的离线缓存`);
      exitSelection();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '缓存离线包失败');
    } finally {
      setBatchAction(null);
    }
  };

  /** 预合成语音：对选中书籍逐个提交 tts-generate，随后打开任务队列面板 */
  const handleGenerateVoice = async () => {
    if (selectedIds.size === 0) return;
    setBatchAction('voice');
    try {
      await Promise.all([...selectedIds].map((id) =>
        axios.post(`/api/books/${id}/tts-generate`)
      ));
      toast.success(`已提交 ${selectedIds.size} 本图书的语音预生成`);
      exitSelection();
      setShowTtsQueue(true);
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '提交语音预生成失败');
    } finally {
      setBatchAction(null);
    }
  };

  return (
    <div className="min-h-full pb-24 px-4 pt-6 max-w-3xl mx-auto" style={{ background: 'var(--color-bg)' }}>
      <h1 className="text-2xl font-semibold mb-4" style={{ color: 'var(--color-text)' }}>图书管理</h1>

      {/* iOS 分段控件 */}
      <div className="flex items-center gap-1 p-1 rounded-ios-xl mb-5"
        style={{ background: 'var(--color-bg-alt)', border: '0.5px solid var(--color-border)' }}>
        {TABS.map((t) => (
          <Button
            key={t}
            type="button"
            variant="pill"
            size="md"
            active={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 !h-9 !px-0 !rounded-ios-lg text-[13px] ${tab === t ? '' : '!bg-transparent !text-ios-text-secondary'}`}
          >
            {t}
          </Button>
        ))}
      </div>

      {tab === '上传图书' && (
        <section className="ios-card rounded-ios-2xl p-5" style={{ background: 'var(--color-bg-card)' }}>
          <h2 className="text-base font-semibold mb-3" style={{ color: 'var(--color-text)' }}>上传图书</h2>
          <p className="text-xs mb-4" style={{ color: 'var(--color-text-muted)' }}>
            支持 EPUB / TXT 格式，可多选批量上传。
          </p>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => uploadRef.current?.show()}
          >
            ＋ 选择文件上传
          </Button>
        </section>
      )}

      {tab === '批量选择' && (
        <section className="ios-card rounded-ios-2xl p-5" style={{ background: 'var(--color-bg-card)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>批量选择</h2>
            <Button variant="text" size="sm" onClick={toggleSelectAll}>
              {allSelected ? '☐ 全不选' : '☑ 全选'}
            </Button>
          </div>

          {/* 顶部吸顶动作栏：选中后显示，无需滚动到底即可操作 */}
          {selectedIds.size > 0 && (
            <div
              className="sticky top-12 sm:top-14 z-30 mb-4 -mx-5 px-5 py-2.5 rounded-none sm:rounded-ios-xl flex items-center justify-between gap-2"
              style={{
                background: 'var(--color-bg-card)',
                borderTop: '0.5px solid var(--color-border)',
                borderBottom: '0.5px solid var(--color-border)',
                boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
              }}
            >
              <span className="text-sm whitespace-nowrap" style={{ color: 'var(--color-text-secondary)' }}>
                已选 <strong className="text-ios-primary">{selectedIds.size}</strong> 本
              </span>
              <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
                <Button variant="danger" size="sm" className="shrink-0" loading={batchAction === 'delete'} disabled={batchAction !== null} onClick={handleBatchDelete}>🗑 删除</Button>
                <Button variant="secondary" size="sm" className="shrink-0" loading={batchAction === 'cache'} disabled={batchAction !== null} onClick={handleBatchCache}>📥 缓存离线包</Button>
                <Button variant="success" size="sm" className="shrink-0" loading={batchAction === 'voice'} disabled={batchAction !== null} onClick={handleGenerateVoice}>🎙 合成语音</Button>
                <Button variant="text" size="sm" className="shrink-0" disabled={batchAction !== null} onClick={exitSelection}>取消</Button>
              </div>
            </div>
          )}

          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索图书..."
            className="w-full h-10 px-4 rounded-ios-lg text-sm mb-4 outline-none"
            style={{ background: 'var(--color-bg-alt)', color: 'var(--color-text)', border: '0.5px solid var(--color-border)' }}
          />

          {loading && <p className="text-sm py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>加载中...</p>}
          {!loading && filtered.length === 0 && (
            <p className="text-sm py-6 text-center" style={{ color: 'var(--color-text-muted)' }}>暂无图书，请先上传</p>
          )}

          <ul className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {filtered.map((book) => {
              const checked = selectedIds.has(book.id);
              return (
                <li key={book.id} className="flex items-start py-3 gap-3">
                  {/* 独立圆形勾选框：固定 22px 正圆（inline style 不受 Button 默认样式干扰），与第一行文本对齐 */}
                  <button
                    type="button"
                    data-testid={`select-${book.id}`}
                    aria-label={`选择 ${book.title}`}
                    onClick={() => toggleSelectOne(book.id)}
                    className="shrink-0 rounded-full border-2 flex items-center justify-center transition-colors"
                    style={{
                      width: 22,
                      height: 22,
                      marginTop: 2,
                      borderColor: checked ? 'var(--color-primary)' : 'var(--color-border)',
                      background: checked ? 'var(--color-primary)' : 'transparent',
                    }}
                  >
                    {checked && <span className="text-white text-[11px] leading-none font-bold">✓</span>}
                  </button>
                  <div className="min-w-0">
                    <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{book.title}</p>
                    {book.author && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{book.author}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {tab === '预合成语音' && (
        <section className="ios-card rounded-ios-2xl p-5 space-y-3" style={{ background: 'var(--color-bg-card)' }}>
          <h2 className="text-base font-semibold" style={{ color: 'var(--color-text)' }}>预合成语音</h2>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            为指定图书预先生成语音章节，离线可用。批量提交后自动打开任务队列，可实时查看每本书的合成进度。
          </p>
          <Button variant="accent" size="md" fullWidth onClick={() => { setTab('批量选择'); }}>
            🎙 前往批量预合成
          </Button>
          <Button variant="secondary" size="md" fullWidth onClick={() => { setShowTtsQueue(true); fetchTTSJobs(); }}>
            🗂 查看语音队列{activeCount > 0 ? `（${activeCount} 进行中）` : ''}
          </Button>
        </section>
      )}

      {/* 上传队列弹层 */}
      <UploadQueue
        ref={uploadRef}
        onComplete={loadBooks}
        onClose={() => {}}
      />

      {/* ── TTS 预生成队列可视化面板 ── */}
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
    </div>
  );
}

export default LibraryPage;
