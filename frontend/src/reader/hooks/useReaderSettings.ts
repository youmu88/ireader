/**
 * useReaderSettings —— 阅读排版设置 hook（Phase 5.2, integrated in Phase 5.5）
 *
 * 职责：
 *   - 管理 fontSize / fontFamily / lineHeight / letterSpacing / readingMode
 *   - 自动持久化到 localStorage
 *   - 初始化时从 localStorage 恢复
 */
import { useCallback, useEffect, useState } from 'react';

const PREFS_KEY = 'ireader_reader_prefs';

export type FontFamily = 'sans' | 'serif' | 'mono';
export type ReadingMode = 'paginated' | 'scroll';

export interface ReaderSettings {
  fontSize: number;
  fontFamily: FontFamily;
  lineHeight: number;
  letterSpacing: number;
  readingMode: ReadingMode;
}

export interface UseReaderSettingsResult extends ReaderSettings {
  setFontSize: (v: number) => void;
  setFontFamily: (v: FontFamily) => void;
  setLineHeight: (v: number) => void;
  setLetterSpacing: (v: number) => void;
  setReadingMode: (v: ReadingMode) => void;
  /** 批量更新 */
  update: (partial: Partial<ReaderSettings>) => void;
}

function loadPrefs(): Partial<ReaderSettings> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function savePrefs(prefs: Partial<ReaderSettings>): void {
  try {
    const current = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch { /* ignore */ }
}

const DEFAULTS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'sans',
  lineHeight: 1.8,
  letterSpacing: 0.01,
  readingMode: 'paginated',
};

export function useReaderSettings(): UseReaderSettingsResult {
  const [settings, setSettings] = useState<ReaderSettings>(() => ({
    ...DEFAULTS,
    ...loadPrefs(),
  }));

  // 持久化
  useEffect(() => { savePrefs(settings); }, [settings]);

  const setFontSize = useCallback((v: number) => setSettings(s => ({ ...s, fontSize: v })), []);
  const setFontFamily = useCallback((v: FontFamily) => setSettings(s => ({ ...s, fontFamily: v })), []);
  const setLineHeight = useCallback((v: number) => setSettings(s => ({ ...s, lineHeight: v })), []);
  const setLetterSpacing = useCallback((v: number) => setSettings(s => ({ ...s, letterSpacing: v })), []);
  const setReadingMode = useCallback((v: ReadingMode) => setSettings(s => ({ ...s, readingMode: v })), []);
  const update = useCallback((partial: Partial<ReaderSettings>) => setSettings(s => ({ ...s, ...partial })), []);

  return {
    ...settings,
    setFontSize,
    setFontFamily,
    setLineHeight,
    setLetterSpacing,
    setReadingMode,
    update,
  };
}
