/**
 * Theme Service — 亮/暗主题管理
 *
 * 使用 Tailwind CSS `dark:` class 模式
 * 通过 document.documentElement.classList 切换 'dark' 类
 * 持久化到 localStorage
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ireader-theme';
const DEFAULT_THEME: Theme = 'light';

// ── 底层 DOM 操作 ──

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch { /* localStorage 不可用时忽略 */ }
  return DEFAULT_THEME;
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* 静默 */ }
}

// ── React Context ──

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggleTheme: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    // 优先使用存储的主题
    const stored = readStoredTheme();
    // 如果没有存储过，跟随系统偏好
    if (!localStorage.getItem(STORAGE_KEY)) {
      try {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const systemTheme = prefersDark ? 'dark' : 'light';
        applyTheme(systemTheme);
        return systemTheme;
      } catch { /* fallback to stored */ }
    }
    applyTheme(stored);
    return stored;
  });

  const setTheme = (t: Theme) => {
    setThemeState(t);
    applyTheme(t);
    storeTheme(t);
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  // 系统主题变更监听（可选）
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      // 仅在用户没有手动存储过时跟随系统
      if (!localStorage.getItem(STORAGE_KEY)) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
