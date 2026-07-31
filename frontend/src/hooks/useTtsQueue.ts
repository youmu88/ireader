import { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { toast } from '../components/ui';
import type { TTSJob } from '../components/TtsQueuePanel';

export interface UseTtsQueueOptions {
  /** 是否在存在活跃任务时自动轮询进度（默认 true） */
  poll?: boolean;
  /** 轮询间隔 ms（默认 3000） */
  interval?: number;
}

/**
 * useTtsQueue — 共享 TTS 语音生成队列管理 hook
 *
 * 收敛 BookShelfPage / LibraryPage 重复的队列状态、轮询与操作逻辑。
 * 职责：
 *  - 队列数据加载与轮询（有活跃任务或面板打开时）
 *  - 批量选择集合管理（toggle / selectAll / deselectAll）
 *  - 单任务取消、批量取消/删除、清除已完成、清除全部
 * 不负责 UI 确认弹窗（confirm）—— 调用方决定交互层。
 */
export function useTtsQueue(options: UseTtsQueueOptions = {}) {
  const { poll = true, interval = 3000 } = options;

  const [ttsJobs, setTtsJobs] = useState<TTSJob[]>([]);
  const [showTtsQueue, setShowTtsQueue] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** 拉取最新队列，且无活跃任务时停止轮询 */
  const fetchTTSJobs = useCallback(async () => {
    try {
      const res = await axios.get('/api/tts/jobs');
      if (res.data.success) {
        setTtsJobs(res.data.data);
        const active = res.data.data.filter(
          (j: TTSJob) => j.status === 'pending' || j.status === 'running'
        );
        if (active.length === 0 && pollRef.current) stopPolling();
      }
    } catch { /* 静默 */ }
  }, [stopPolling]);

  // 面板打开 或 存在活跃任务 时轮询
  useEffect(() => {
    if (!poll) return;
    const hasActive = ttsJobs.some(j => j.status === 'pending' || j.status === 'running');
    const shouldPoll = showTtsQueue || hasActive;
    if (shouldPoll && !pollRef.current) {
      fetchTTSJobs();
      pollRef.current = setInterval(fetchTTSJobs, interval);
    }
    if (!shouldPoll && pollRef.current) stopPolling();
    return () => stopPolling();
  }, [poll, showTtsQueue, ttsJobs, fetchTTSJobs, interval, stopPolling]);

  // ── 选择集合管理 ──
  const toggleJobSelection = useCallback((id: string) => {
    setSelectedJobIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllJobs = useCallback(() => {
    setSelectedJobIds(new Set(ttsJobs.map(j => j.id)));
  }, [ttsJobs]);

  const deselectAllJobs = useCallback(() => {
    setSelectedJobIds(new Set());
  }, []);

  // ── 取消单个任务 ──
  const handleCancelJob = useCallback(async (jobId: string) => {
    try {
      await axios.delete(`/api/tts/jobs/${jobId}`);
      await fetchTTSJobs();
    } catch (err: any) {
      toast.error(err.response?.data?.error || '取消失败');
    }
  }, [fetchTTSJobs]);

  // ── 批量取消选中的排队/运行中任务 ──
  const handleBatchCancelSelected = useCallback(async () => {
    if (selectedJobIds.size === 0) return false;
    const cancelIds = [...selectedJobIds].filter(id => {
      const job = ttsJobs.find(j => j.id === id);
      return job && (job.status === 'pending' || job.status === 'running');
    });
    if (cancelIds.length === 0) return false;
    try {
      await axios.post('/api/tts/jobs/batch-cancel', { jobIds: cancelIds });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量取消失败');
      return false;
    }
  }, [selectedJobIds, ttsJobs, fetchTTSJobs]);

  // ── 批量删除选中的任务 ──
  const handleBatchDeleteSelected = useCallback(async () => {
    if (selectedJobIds.size === 0) return false;
    try {
      await axios.post('/api/tts/jobs/delete', { jobIds: [...selectedJobIds] });
      setSelectedJobIds(new Set());
      await fetchTTSJobs();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.error || '批量删除失败');
      return false;
    }
  }, [selectedJobIds, fetchTTSJobs]);

  // ── 清除所有已完成/失败任务 ──
  const handleClearTerminated = useCallback(async () => {
    const terminated = ttsJobs.filter(j => j.status === 'completed' || j.status === 'failed').length;
    if (terminated === 0) { toast.info('没有可清除的任务'); return false; }
    try {
      await axios.post('/api/tts/jobs/clear-terminated');
      await fetchTTSJobs();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.error || '清除失败');
      return false;
    }
  }, [ttsJobs, fetchTTSJobs]);

  // ── 清除全部排队任务 ──
  const handleClearAllJobs = useCallback(async () => {
    try {
      await axios.post('/api/tts/jobs/clear-all');
      await fetchTTSJobs();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.error || '清除失败');
      return false;
    }
  }, [fetchTTSJobs]);

  const activeCount = ttsJobs.filter(j => j.status === 'pending' || j.status === 'running').length;

  const closeQueue = useCallback(() => {
    setShowTtsQueue(false);
    setSelectedJobIds(new Set());
  }, []);

  return {
    ttsJobs,
    showTtsQueue,
    setShowTtsQueue,
    selectedJobIds,
    activeCount,
    fetchTTSJobs,
    toggleJobSelection,
    selectAllJobs,
    deselectAllJobs,
    handleCancelJob,
    handleBatchCancelSelected,
    handleBatchDeleteSelected,
    handleClearTerminated,
    handleClearAllJobs,
    closeQueue,
  };
}

export default useTtsQueue;
