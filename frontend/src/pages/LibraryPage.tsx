import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import UploadQueue, { type UploadQueueHandle } from '../components/UploadQueue';
import TtsQueuePanel, { type TTSJob } from '../components/TtsQueuePanel';
import { Button, toast, confirm } from '../components/ui';

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
  const [submittingVoice, setSubmittingVoice] = useState<string | null>(null);
  const uploadRef = useRef<UploadQueueHandle>(null);

  // ── TTS 语音生成队列（任务进度可视化） ──
  const [ttsJobs, setTtsJobs] = useState<TTSJob[]>([]);
  const [showTtsQueue, setShowTtsQueue] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const ttsQueuePollRef = useRef<ReturnType<typeof setInterval>>();

  const fetchTTSJobs = useCallback(async () => {
    try {
      const res = await axios.get('/api/tts/jobs');
      if (res.data.success) {
        setTtsJobs(res.data.data);
        const active = res.data.data.filter((j: TTSJob) => j.status === 'pending' || j.status === 'running');
        if (active.length === 0 && ttsQueuePollRef.current) {
          clearInterval(ttsQueuePollRef.current);
          ttsQueuePollRef.current = undefined;
        }
      }
    } catch { /* 静默 */ }
  }, []);

  // 面板打开或有活跃任务时轮询进度
  useEffect(() => {
    const hasActive = ttsJobs.some(j => j.status === 'pending' || j.status === 'running');
    const shouldPoll = showTtsQueue || hasActive;
    if (shouldPoll && !ttsQueuePollRef.current) {
      fetchTTSJobs();
      ttsQueuePollRef.current = setInterval(fetchTTSJobs, 3000);
    }
    if (!shouldPoll && ttsQueuePollRef.current) {
      clearInterval(ttsQueuePollRef.current);
      ttsQueuePollRef.current = undefined;
    }
    return () => {
      if (ttsQueuePollRef.current) {
        clearInterval(ttsQueuePollRef.current);
        ttsQueuePollRef.current = undefined;
      }
    };
  }, [showTtsQueue, ttsJobs, fetchTTSJobs]);

  // ── TTS 队列操作 ──
  const toggleJobSelection = (id: string) => {
    setSelectedJobIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAllJobs = () => setSelectedJobIds(new Set(ttsJobs.map(j => j.id)));
  const deselectAllJobs = () => setSelectedJobIds(new Set());

  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await axios.delete(`/api/tts/jobs/${jobId}`);
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '取消失败');
    }
  }, [fetchTTSJobs]);

  const handleBatchCancelSelected = async () => {
    if (selectedJobIds.size === 0) return;
    const cancelIds = [...selectedJobIds].filter(id => {
      const job = ttsJobs.find(j => j.id === id);
      return job && (job.status === 'pending' || job.status === 'running');
    });
    if (cancelIds.length === 0) return;
    try {
      await axios.post('/api/tts/jobs/batch-cancel', { jobIds: cancelIds });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量取消失败');
    }
  };

  const handleBatchDeleteSelected = async () => {
    if (selectedJobIds.size === 0) return;
    try {
      await axios.post('/api/tts/jobs/delete', { jobIds: [...selectedJobIds] });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量删除失败');
    }
  };

  const handleClearTerminated = async () => {
    const terminated = ttsJobs.filter(j => j.status === 'completed' || j.status === 'failed').length;
    if (terminated === 0) { toast.info('没有可清除的任务'); return; }
    try {
      await axios.post('/api/tts/jobs/clear-terminated');
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '清除失败');
    }
  };

  const handleClearAllJobs = useCallback(async () => {
    const ok = await confirm({ title: '清除全部', message: '确定清除所有排队中的语音生成任务？', confirmText: '清除', danger: true });
    if (!ok) return;
    try {
      await axios.post('/api/tts/jobs/clear-all');
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '清除失败');
    }
  }, [fetchTTSJobs]);

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

  /** 预合成语音：对选中书籍逐个提交 tts-generate，随后打开任务队列面板 */
  const handleGenerateVoice = async () => {
    if (selectedIds.size === 0) return;
    setSubmittingVoice('voice');
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
      setSubmittingVoice(null);
    }
  };

  const activeTtsJobs = ttsJobs.filter(j => j.status === 'pending' || j.status === 'running').length;

  return (
    <div className="min-h-full pb-24 px-4 pt-6 max-w-3xl mx-auto" style={{ background: 'var(--color-bg)' }}>
      <h1 className="text-2xl font-semibold mb-4" style={{ color: 'var(--color-text)' }}>图书管理</h1>

      {/* iOS 分段控件 */}
      <div className="flex items-center gap-1 p-1 rounded-ios-xl mb-5"
        style={{ background: 'var(--color-bg-alt)', border: '0.5px solid var(--color-border)' }}>
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`flex-1 h-9 rounded-ios-lg text-[13px] font-medium transition-all tap-icon ${
              tab === t ? 'bg-ios-bg-card text-ios-primary shadow-ios-sm' : 'text-ios-text-secondary'
            }`}
          >
            {t}
          </button>
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
                <li key={book.id} className="flex items-center justify-between py-3">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      data-testid={`select-${book.id}`}
                      aria-label={`选择 ${book.title}`}
                      onClick={() => toggleSelectOne(book.id)}
                      className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all tap-icon ${
                        checked ? 'bg-ios-primary border-ios-primary' : 'border-ios-border'
                      }`}
                    >
                      {checked && <span className="text-white text-xs leading-none">✓</span>}
                    </button>
                    <div>
                      <p className="text-sm font-medium" style={{ color: 'var(--color-text)' }}>{book.title}</p>
                      {book.author && <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{book.author}</p>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {selectedIds.size > 0 && (
            <div className="mt-4 pt-4 space-y-2" style={{ borderTop: '0.5px solid var(--color-border)' }}>
              <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>已选 <strong className="text-ios-primary">{selectedIds.size}</strong> 本</p>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={exitSelection}>取消</Button>
                <Button
                  variant="success"
                  size="sm"
                  onClick={handleGenerateVoice}
                  loading={submittingVoice === 'voice'}
                >
                  🎙 预合成语音
                </Button>
              </div>
            </div>
          )}
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
            🗂 查看语音队列{activeTtsJobs > 0 ? `（${activeTtsJobs} 进行中）` : ''}
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
        onClose={() => { setShowTtsQueue(false); setSelectedJobIds(new Set()); }}
      />
    </div>
  );
}

export default LibraryPage;
