/**
 * useReaderProgress — 阅读进度恢复与保存
 *
 * 契约（复用后端 progress API）：
 *   GET /api/books/:id/progress → { success, data: { cfi, percentage, pageIndex, progressVersion } | null }
 *   PUT /api/books/:id/progress ← { cfi, percentage, pageIndex, progressVersion, deviceId }
 *     → { success, conflict, data: { progressVersion } | 完整记录(conflict 时) }
 *
 * 策略：
 *  - 恢复：优先服务端 cfi；离线/失败回退 localStorage 快照
 *  - 保存：relocated 后防抖发送；每次从响应吸收最新 progressVersion（含 conflict 场景），
 *    版本单调递增避免旧设备覆盖新进度；冲突时不强制跳页，避免打断阅读
 *  - 离线兜底：每次保存同步写 localStorage；网络失败静默
 */
import { useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { getDeviceId } from '../services/deviceId';
import type { ReaderLocation } from './types';

const posKey = (bookId: string) => `ireader_reader_pos_${bookId}`;

export interface LocalPosition {
  cfi: string;
  percentage: number | null;
  pageIndex: number | null;
  updatedAt: string;
}

/** 读取本地进度快照（离线回退用） */
export function loadLocalPosition(bookId: string): LocalPosition | null {
  try {
    const raw = localStorage.getItem(posKey(bookId));
    if (!raw) return null;
    const pos = JSON.parse(raw) as LocalPosition;
    return pos?.cfi ? pos : null;
  } catch {
    return null;
  }
}

/** 写本地进度快照（同步、尽力而为） */
function saveLocalPosition(bookId: string, loc: ReaderLocation): void {
  try {
    const payload: LocalPosition = {
      cfi: loc.cfi,
      percentage: loc.percentage,
      pageIndex: loc.globalPage ?? loc.pageInChapter ?? null,
      updatedAt: new Date().toISOString(),
    };
    localStorage.setItem(posKey(bookId), JSON.stringify(payload));
  } catch { /* 存储不可用时静默 */ }
}

export interface UseReaderProgressOptions {
  bookId: string;
  /** 保存防抖间隔 ms（默认 800） */
  saveDelay?: number;
}

export interface UseReaderProgressResult {
  /** 加载初始 CFI：优先服务端，离线/失败回退 localStorage */
  loadInitialCfi: () => Promise<string | null>;
  /** 防抖调度保存（每次 relocated 调用） */
  scheduleSave: (loc: ReaderLocation) => void;
}

export function useReaderProgress({ bookId, saveDelay = 800 }: UseReaderProgressOptions): UseReaderProgressResult {
  const versionRef = useRef(1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ReaderLocation | null>(null);

  const sendNow = useCallback(async (loc: ReaderLocation) => {
    saveLocalPosition(bookId, loc);
    try {
      const res = await axios.put(`/api/books/${bookId}/progress`, {
        cfi: loc.cfi,
        percentage: loc.percentage,
        pageIndex: loc.globalPage ?? loc.pageInChapter ?? null,
        progressVersion: versionRef.current,
        deviceId: getDeviceId(),
      });
      // 正常与 conflict 响应都从 data.progressVersion 吸收版本，保持单调递增
      const v = res.data?.data?.progressVersion;
      if (typeof v === 'number') versionRef.current = v;
    } catch { /* 离线静默：localStorage 已兜底 */ }
  }, [bookId]);

  const loadInitialCfi = useCallback(async (): Promise<string | null> => {
    try {
      const res = await axios.get(`/api/books/${bookId}/progress`);
      const data = res.data?.data;
      if (typeof data?.progressVersion === 'number') versionRef.current = data.progressVersion;
      if (data?.cfi) return data.cfi as string;
    } catch { /* 离线/失败回退本地 */ }
    return loadLocalPosition(bookId)?.cfi ?? null;
  }, [bookId]);

  const scheduleSave = useCallback((loc: ReaderLocation) => {
    if (!loc.cfi) return;
    pendingRef.current = loc;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending) void sendNow(pending);
    }, saveDelay);
  }, [saveDelay, sendNow]);

  // 卸载 flush：取消待发请求，将 pending 位置同步写入 localStorage（可靠）
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (pendingRef.current) saveLocalPosition(bookId, pendingRef.current);
  }, [bookId]);

  return { loadInitialCfi, scheduleSave };
}
