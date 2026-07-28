/**
 * useReaderEngine —— 阅读器引擎生命周期管理 hook（Phase 5.1, integrated in Phase 5.5）
 *
 * 职责：
 *   - 根据 book.format 创建 TxtEngine 或 EpubEngine
 *   - 管理 mount / unmount 生命周期
 *   - 同步排版设置到引擎
 *   - 暴露引擎实例供其他 hook 消费
 */
import { useEffect, useRef, useState } from 'react';
import type { ReaderEngine } from '../engine/types';
import type { BookFormat } from '../types';
import type { ReaderSettings } from './useReaderSettings';
import { TxtEngine } from '../engine/TxtEngine';

export interface UseReaderEngineOptions {
  bookId: string | undefined;
  format: BookFormat | undefined;
  settings: ReaderSettings;
}

export interface UseReaderEngineResult {
  engine: ReaderEngine | null;
  /** 挂载容器 ref callback */
  containerRef: (el: HTMLElement | null) => void;
}

export function useReaderEngine(options: UseReaderEngineOptions): UseReaderEngineResult {
  const { bookId, format, settings } = options;
  const [engine, setEngine] = useState<ReaderEngine | null>(null);
  const containerElRef = useRef<HTMLElement | null>(null);
  const engineRef = useRef<ReaderEngine | null>(null);

  // 创建/销毁引擎
  useEffect(() => {
    if (!bookId || !format) return;

    let eng: ReaderEngine | null = null;

    if (format === 'txt') {
      eng = new TxtEngine({
        bookId,
        mode: settings.readingMode,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        letterSpacing: settings.letterSpacing,
        fontFamily: settings.fontFamily,
      });
    }
    // EPUB 引擎由 EpubViewer 组件内部管理（Phase 3 已实现 EpubEngine 类，
    // 但 EpubViewer 组件仍在使用，待 Phase 6 集成时切换）

    if (eng && containerElRef.current) {
      eng.mount(containerElRef.current);
    }

    engineRef.current = eng;
    setEngine(eng);

    return () => {
      eng?.unmount();
      engineRef.current = null;
      setEngine(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, format]);

  // 同步排版设置
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng || eng.format !== 'txt') return;
    const txtEng = eng as TxtEngine;
    txtEng.setMode(settings.readingMode);
    txtEng.setTypography({
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
      fontFamily: settings.fontFamily,
    });
  }, [settings]);

  const containerRef = (el: HTMLElement | null) => {
    containerElRef.current = el;
    if (el && engineRef.current) {
      engineRef.current.mount(el);
    }
  };

  return { engine, containerRef };
}
