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

// EPUB 引擎
export { EpubEngine } from './engine/EpubEngine';
export type { EpubEngineOptions } from './engine/EpubEngine';

// 进度模型
export type {
  ReadingPosition,
  ReadingPositionInput,
  ReadingPositionUpdate,
} from './position/types';

// TTS 控制器
export type { TtsController, TtsState } from './tts/types';
export { SequentialPlayer } from './tts/SequentialPlayer';
export { DefaultTtsController } from './tts/DefaultTtsController';
export type { DefaultTtsControllerOptions } from './tts/DefaultTtsController';
export { useTts } from './tts/useTts';
export type { UseTtsOptions, UseTtsResult } from './tts/useTts';

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
