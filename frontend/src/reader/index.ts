/**
 * reader 模块公共 API
 */

// 共享类型
export type { BookFormat, Chapter } from './types';

// 引擎接口
export type { ReaderEngine } from './engine/types';

// TXT 引擎
export { TxtEngine } from './engine/TxtEngine';
export type { TxtEngineOptions, TxtReadingMode } from './engine/TxtEngine';

// 进度模型
export type {
  ReadingPosition,
  ReadingPositionInput,
  ReadingPositionUpdate,
} from './position/types';

// Hooks
export { useReadingPosition } from './position/useReadingPosition';
export type { UseReadingPositionResult } from './position/useReadingPosition';

export { useProgressPersistence, loadLocalPosition } from './position/useProgressPersistence';
export type {
  ProgressPayload,
  UseProgressPersistenceOptions,
  UseProgressPersistenceResult,
} from './position/useProgressPersistence';

// 导航器（已有）
export { SerialReaderNavigator } from './ReaderNavigator';
export type { ReaderNavigator } from './ReaderNavigator';
