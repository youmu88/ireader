/**
 * useReaderNavigation —— 章节导航 hook（Phase 5.4）
 *
 * 职责：
 *   - 管理当前章节索引
 *   - 提供 goToChapter / goNext / goPrev
 *   - 章节边界事件处理（引擎触发 → 自动加载下/上一章）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderEngine } from '../engine/types';
import type { Chapter } from '../types';

export interface UseReaderNavigationOptions {
  chapters: Chapter[];
  engine: ReaderEngine | null;
  /** 章节加载回调（由外部实现实际内容加载） */
  onLoadChapter: (chapter: Chapter) => Promise<void>;
}

export interface UseReaderNavigationResult {
  currentChapter: Chapter | null;
  currentIndex: number;
  goToChapter: (chapter: Chapter) => Promise<void>;
  goNext: () => Promise<void>;
  goPrev: () => Promise<void>;
  hasNext: boolean;
  hasPrev: boolean;
}

export function useReaderNavigation(options: UseReaderNavigationOptions): UseReaderNavigationResult {
  const { chapters, engine, onLoadChapter } = options;
  const [currentIndex, setCurrentIndex] = useState(-1);
  const loadingRef = useRef(false);
  const onLoadRef = useRef(onLoadChapter);
  onLoadRef.current = onLoadChapter;

  const currentChapter = currentIndex >= 0 && currentIndex < chapters.length
    ? chapters[currentIndex]
    : null;

  const goToChapter = useCallback(async (chapter: Chapter) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      await onLoadRef.current(chapter);
      setCurrentIndex(chapter.order);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const goNext = useCallback(async () => {
    const nextIdx = currentIndex + 1;
    if (nextIdx >= chapters.length) return;
    await goToChapter(chapters[nextIdx]);
  }, [currentIndex, chapters, goToChapter]);

  const goPrev = useCallback(async () => {
    const prevIdx = currentIndex - 1;
    if (prevIdx < 0) return;
    await goToChapter(chapters[prevIdx]);
  }, [currentIndex, chapters, goToChapter]);

  // 订阅引擎章节边界事件
  useEffect(() => {
    if (!engine) return;
    const unsub = engine.onChapterBoundary((dir) => {
      if (dir === 'next') goNext();
      else goPrev();
    });
    return unsub;
  }, [engine, goNext, goPrev]);

  return {
    currentChapter,
    currentIndex,
    goToChapter,
    goNext,
    goPrev,
    hasNext: currentIndex < chapters.length - 1,
    hasPrev: currentIndex > 0,
  };
}
