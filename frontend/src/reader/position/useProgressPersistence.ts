/**
 * useProgressPersistence —— 统一进度持久化
 *
 * 替代原有 4 路竞态保存（debounceSaveProgress / startTtsProgressSaver /
 * scrollProgressSaveTimer / persistPlaybackState），收敛为单一管道：
 *
 *   ReadingPosition 变化 → debounce 800ms → PUT /api/books/:id/progress
 *                        → 同步写 localStorage（崩溃恢复）
 *
 * 设计原则：
 *   - 只消费 ReadingPosition，不关心位置来自翻页/滚动/TTS/EPUB
 *   - 单一定时器，不存在多路覆盖竞态
 *   - 卸载 / 页面隐藏时 flush 最后一次位置，不丢失
 */
import { useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import type { ReadingPosition } from './types';
import { getDeviceId } from '../../services/deviceId';

// ── 常量 ─────────────────────────────────────────────────

/** API 保存防抖延迟（ms） */
const SAVE_DEBOUNCE_MS = 800;
/** localStorage 键名 */
const LS_KEY = 'ireader_reading_position';

// ── 类型 ─────────────────────────────────────────────────

/** 后端 PUT /api/books/:id/progress 接受的 payload */
export interface ProgressPayload {
  chapterId: string;
  /** 全书进度百分比 0~100 */
  percentage: number;
  /** TXT 滚动位置（0~10000 整数） */
  pageIndex?: number;
  /** TTS 分段索引 */
  textOffset?: number;
  /** EPUB CFI */
  cfi?: string;
  /** 单调递增版本号，用于多设备冲突合并 */
  progressVersion: number;
  /** 写入来源设备标识 */
  deviceId: string;
}

/** 后端 PUT 响应中的冲突信息 */
export interface ProgressSaveResponse {
  success: boolean;
  conflict: boolean;
  message?: string;
  data?: {
    progressVersion: number;
    deviceId: string | null;
    updatedAt: string;
    [key: string]: unknown;
  };
}

export interface UseProgressPersistenceOptions {
  /** 书籍 ID（为空时不保存） */
  bookId: string | undefined;
  /** 总章节数（用于计算全书百分比） */
  totalChapters: number;
  /** 是否启用（如加载中可禁用） */
  enabled?: boolean;
}

export interface UseProgressPersistenceResult {
  /** 立即保存（跳过 debounce，用于页面卸载等必须同步写入的场景） */
  saveImmediate: (pos: ReadingPosition) => void;
  /** 立即刷新待保存的位置（跳过 debounce，用于页面卸载前） */
  flush: () => void;
  /** 从服务端同步版本号（恢复进度后调用，避免首次保存触发冲突） */
  syncVersion: (serverVersion: number) => void;
}

// ── 工具函数 ─────────────────────────────────────────────

/** ReadingPosition → 后端 API payload */
function toPayload(pos: ReadingPosition, totalChapters: number, version: number): ProgressPayload {
  const percentage = totalChapters > 0
    ? Math.round(((pos.chapterIndex + pos.ratio) / totalChapters) * 100)
    : 0;

  const payload: ProgressPayload = {
    chapterId: pos.chapterId,
    percentage: Math.max(0, Math.min(100, percentage)),
    progressVersion: version,
    deviceId: getDeviceId(),
  };

  // 滚动模式：ratio → pageIndex (0~10000)
  if (pos.scrollRatio != null) {
    payload.pageIndex = Math.round(pos.scrollRatio * 10000);
  } else if (pos.page != null && pos.pageCount != null && pos.pageCount > 1) {
    // 分页模式：page/pageCount → pageIndex
    payload.pageIndex = Math.round((pos.page / (pos.pageCount - 1)) * 10000);
  }

  if (pos.textOffset != null) {
    payload.textOffset = pos.textOffset;
  }

  if (pos.cfi) {
    payload.cfi = pos.cfi;
  }

  return payload;
}

/** 写入 localStorage（同步，崩溃恢复用） */
function persistToLocal(pos: ReadingPosition): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(pos));
  } catch { /* 存储满或隐私模式，静默 */ }
}

/** 从 localStorage 读取上次位置 */
export function loadLocalPosition(): ReadingPosition | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ReadingPosition;
  } catch {
    return null;
  }
}

// ── Hook ─────────────────────────────────────────────────

export function useProgressPersistence(
  position: ReadingPosition | null,
  options: UseProgressPersistenceOptions,
): UseProgressPersistenceResult {
  const { bookId, totalChapters, enabled = true } = options;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<ReadingPosition | null>(null);
  const optionsRef = useRef({ bookId, totalChapters, enabled });
  optionsRef.current = { bookId, totalChapters, enabled };
  /** 本地版本号，每次成功保存后从服务端响应同步 */
  const versionRef = useRef(1);

  /** 从服务端同步版本号（恢复进度后调用） */
  const syncVersion = useCallback((serverVersion: number) => {
    versionRef.current = serverVersion;
  }, []);

  /** 执行实际保存（API + localStorage） */
  const doSave = useCallback((pos: ReadingPosition) => {
    const { bookId: bid, totalChapters: total, enabled: en } = optionsRef.current;
    if (!en || !bid) return;

    // localStorage 同步写入（每次位置变化都写，保证崩溃恢复）
    persistToLocal(pos);

    // 递增本地版本号
    versionRef.current += 1;

    // API 异步写入
    const payload = toPayload(pos, total, versionRef.current);
    axios.put(`/api/books/${bid}/progress`, payload)
      .then((res) => {
        const body = res.data as ProgressSaveResponse;
        if (body?.data?.progressVersion != null) {
          versionRef.current = body.data.progressVersion;
        }
      })
      .catch(() => { /* 静默 */ });
  }, []);


  /** 立即保存（跳过 debounce） */
  const saveImmediate = useCallback((pos: ReadingPosition) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    doSave(pos);
  }, [doSave]);

  /** 立即刷新（跳过 debounce） */
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current) {
      doSave(pendingRef.current);
      pendingRef.current = null;
    }
  }, [doSave]);

  // 监听 position 变化 → debounce 保存
  useEffect(() => {
    if (!position || !enabled) return;

    // localStorage 立即写入（不等 debounce）
    persistToLocal(position);

    // API debounce
    pendingRef.current = position;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pendingRef.current) {
        doSave(pendingRef.current);
        pendingRef.current = null;
      }
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [position, enabled, doSave]);

  // 页面隐藏 / 卸载时 flush
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const handleBeforeUnload = () => flush();

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      flush(); // 组件卸载时也 flush
    };
  }, [flush]);

  return { saveImmediate, flush, syncVersion };
}
