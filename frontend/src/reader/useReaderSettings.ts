/**
 * useReaderSettings — 阅读器设置状态 + localStorage 持久化
 *
 * 设置项：字号(百分比)/主题/行距，变更即写入 localStorage，跨书籍全局共享。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReaderSettings } from './types';
import {
  DEFAULT_READER_SETTINGS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  LINE_HEIGHT_OPTIONS,
  READER_THEMES,
} from './theme';

export const STORAGE_KEY = 'ireader_reader_settings';

/** 将外部输入钳制到合法范围（字号/主题/行距/滚动模式） */
export function clampSettings(s: ReaderSettings): ReaderSettings {
  const fontSize = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(s.fontSize)));
  const theme = s.theme in READER_THEMES ? s.theme : DEFAULT_READER_SETTINGS.theme;
  const lineHeight = (LINE_HEIGHT_OPTIONS as readonly number[]).includes(s.lineHeight)
    ? s.lineHeight
    : DEFAULT_READER_SETTINGS.lineHeight;
  return { fontSize, theme, lineHeight, scrollMode: s.scrollMode === true };
}

/** 从 localStorage 读取设置；缺失/损坏时返回默认值 */
export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_READER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<ReaderSettings>;
    return clampSettings({ ...DEFAULT_READER_SETTINGS, ...parsed });
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export interface UseReaderSettingsResult {
  settings: ReaderSettings;
  /** 合并补丁并自动 clamp + 持久化 */
  updateSettings: (patch: Partial<ReaderSettings>) => void;
}

export function useReaderSettings(): UseReaderSettingsResult {
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch { /* 存储不可用时静默 */ }
  }, [settings]);

  const updateSettings = useCallback((patch: Partial<ReaderSettings>) => {
    setSettings(prev => clampSettings({ ...prev, ...patch }));
  }, []);

  return { settings, updateSettings };
}
