/**
 * reader/hooks 模块公共 API（Phase 5.1-5.5）
 */
export { useReaderSettings } from './useReaderSettings';
export type { ReaderSettings, UseReaderSettingsResult, FontFamily, ReadingMode } from './useReaderSettings';

export { useReaderEngine } from './useReaderEngine';
export type { UseReaderEngineOptions, UseReaderEngineResult } from './useReaderEngine';

export { useReaderNavigation } from './useReaderNavigation';
export type { UseReaderNavigationOptions, UseReaderNavigationResult } from './useReaderNavigation';

export { useGestures } from './useGestures';
export type { UseGesturesOptions, UseGesturesResult } from './useGestures';
