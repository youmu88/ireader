/**
 * useGestures —— 手势集成 hook（Phase 5.3）
 *
 * 职责：
 *   - 将 useReaderInteraction 的导航事件映射到引擎操作
 *   - 翻页模式：next/prev → engine.nextPage/prevPage
 *   - 滚动模式：仅在章节边界时触发跨章
 *   - 点击：切换工具栏显示
 */
import { useCallback } from 'react';
import { useReaderInteraction } from '../../interaction/useReaderInteraction';
import type { ReaderEngine } from '../engine/types';
import type { ReadingMode } from './useReaderSettings';

export interface UseGesturesOptions {
  engine: ReaderEngine | null;
  readingMode: ReadingMode;
  /** 点击回调（切换工具栏） */
  onTap?: () => void;
  /** 是否启用手势 */
  enabled?: boolean;
}

export interface UseGesturesResult {
  /** 挂载到阅读区域的 ref callback */
  attachElement: (el: HTMLElement | null) => void;
}

export function useGestures(options: UseGesturesOptions): UseGesturesResult {
  const { engine, readingMode, onTap, enabled = true } = options;

  const navigate = useCallback((direction: 'next' | 'previous') => {
    if (!engine) return;
    if (readingMode === 'paginated') {
      if (direction === 'next') engine.nextPage();
      else engine.prevPage();
    }
    // 滚动模式下翻页由引擎的 onChapterBoundary 事件处理
  }, [engine, readingMode]);

  const { attachElement } = useReaderInteraction({
    navigate,
    tap: onTap,
    enabled: () => enabled,
  });

  return { attachElement };
}
