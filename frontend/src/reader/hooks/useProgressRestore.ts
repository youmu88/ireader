/**
 * useProgressRestore —— 阅读进度恢复 hook（Phase 6.3d, final）
 *
 * 职责：
 *   - 从后端 API 获取保存的阅读进度
 *   - 根据 chapterId / percentage / pageIndex / cfi 计算目标章节和位置
 *   - 返回恢复信息供 ReaderPage 消费
 */
import { useCallback } from 'react';
import axios from 'axios';
import type { Chapter } from '../types';

export interface ProgressRestoreResult {
  /** 目标章节 */
  targetChapter: Chapter;
  /** 恢复比例 0~1（TXT 用） */
  restoreRatio: number;
  /** EPUB CFI（EPUB 用） */
  cfi: string | null;
  /** TTS 分段索引（供 TTS 恢复） */
  ttsSegmentIndex: number | null;
  /** 服务端进度版本号（用于冲突合并） */
  progressVersion: number;
  /** 最后写入设备标识 */
  deviceId: string | null;
  /** 服务端最后更新时间（ISO string） */
  updatedAt: string | null;
  /** 原始进度数据 */
  rawProgress: any;
}

export interface UseProgressRestoreResult {
  /** 尝试恢复进度，返回恢复信息（失败时返回 null） */
  restore: (bookId: string, chapters: Chapter[], isOffline: boolean) => Promise<ProgressRestoreResult | null>;
}

export function useProgressRestore(): UseProgressRestoreResult {
  const restore = useCallback(async (
    bookId: string,
    chapters: Chapter[],
    isOffline: boolean,
  ): Promise<ProgressRestoreResult | null> => {
    if (!chapters.length) return null;

    let savedProgress: any = null;
    try {
      if (!isOffline) {
        const res = await axios.get(`/api/books/${bookId}/progress`, { timeout: 15000 });
        savedProgress = res.data?.data || res.data;
      }
    } catch { /* 无保存的进度或请求超时 */ }

    if (!savedProgress) {
      return { targetChapter: chapters[0], restoreRatio: 0, cfi: null, ttsSegmentIndex: null, progressVersion: 0, deviceId: null, updatedAt: null, rawProgress: null };
    }

    // 确定目标章节
    let targetChapter = chapters[0];
    if (savedProgress.chapterId) {
      const exact = chapters.find(c => c.id === savedProgress.chapterId);
      if (exact) {
        targetChapter = exact;
      } else if (savedProgress.percentage != null) {
        const estimatedOrder = Math.round((savedProgress.percentage / 100) * chapters.length);
        const fallback = chapters.find(c => c.order === estimatedOrder);
        if (fallback) targetChapter = fallback;
      }
    }

    // 计算恢复比例（percentage 是 0~100，需除以 100 归一化）
    let restoreRatio = 0;
    if (savedProgress.pageIndex != null) {
      restoreRatio = Math.min(1, Math.max(0, savedProgress.pageIndex / 10000));
    } else if (savedProgress.percentage != null) {
      restoreRatio = Math.min(1, Math.max(0, savedProgress.percentage / 100));
    }

    // TTS 分段索引
    const ttsSegmentIndex = (savedProgress.textOffset != null && savedProgress.textOffset >= 0)
      ? savedProgress.textOffset
      : null;

    return {
      targetChapter,
      restoreRatio,
      cfi: savedProgress.cfi || null,
      ttsSegmentIndex,
      progressVersion: savedProgress.progressVersion ?? 0,
      deviceId: savedProgress.deviceId ?? null,
      updatedAt: savedProgress.updatedAt ?? null,
      rawProgress: savedProgress,
    };
  }, []);

  return { restore };
}
