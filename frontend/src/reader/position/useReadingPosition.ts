/**
 * useReadingPosition —— 阅读位置单一数据源
 *
 * 职责：
 *   1. 持有当前 ReadingPosition（响应式 state + 命令式 ref 双通道）
 *   2. 订阅 ReaderEngine.onPositionChange，引擎驱动位置更新
 *   3. 提供 setPosition（完整替换）和 updatePosition（部分合并）两种写入方式
 *   4. getPosition() 供 TTS / 手势等高频场景命令式读取，不触发重渲染
 *
 * 不负责：
 *   - 持久化（由 useProgressPersistence 订阅本 hook 的输出）
 *   - 引擎创建（由 useReaderEngine 负责）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReaderEngine } from '../engine/types';
import type { ReadingPosition, ReadingPositionInput, ReadingPositionUpdate } from './types';

export interface UseReadingPositionResult {
  /** 当前阅读位置（响应式，触发组件重渲染） */
  position: ReadingPosition | null;
  /** 设置完整位置（章节切换、初始加载） */
  setPosition: (input: ReadingPositionInput) => void;
  /** 部分更新（翻页、滚动等高频操作，自动合并到已有位置） */
  updatePosition: (update: ReadingPositionUpdate) => void;
  /** 命令式获取最新位置（不触发重渲染） */
  getPosition: () => ReadingPosition | null;
}

export function useReadingPosition(engine: ReaderEngine | null): UseReadingPositionResult {
  const [position, setPositionState] = useState<ReadingPosition | null>(null);
  const positionRef = useRef<ReadingPosition | null>(null);

  /** 内部提交：同时更新 ref 和 state */
  const commit = useCallback((pos: ReadingPosition) => {
    positionRef.current = pos;
    setPositionState(pos);
  }, []);

  /** 设置完整位置 */
  const setPosition = useCallback(
    (input: ReadingPositionInput) => {
      commit({
        ...input,
        timestamp: input.timestamp ?? Date.now(),
      });
    },
    [commit],
  );

  /** 部分更新（合并到已有位置，无已有位置时忽略） */
  const updatePosition = useCallback(
    (update: ReadingPositionUpdate) => {
      const prev = positionRef.current;
      if (!prev) return;
      commit({
        ...prev,
        ...update,
        timestamp: update.timestamp ?? Date.now(),
      });
    },
    [commit],
  );

  /** 命令式读取 */
  const getPosition = useCallback(() => positionRef.current, []);

  // 订阅引擎位置变化
  useEffect(() => {
    if (!engine) return;
    return engine.onPositionChange(commit);
  }, [engine, commit]);

  return { position, setPosition, updatePosition, getPosition };
}
