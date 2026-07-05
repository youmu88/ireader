/**
 * Theme Service — 亮/暗主题管理 + 设备兼容性检测
 *
 * 使用 Tailwind CSS `dark:` class 模式
 * 通过 document.documentElement.classList 切换 'dark' 类
 * 持久化到 localStorage
 *
 * 兼容性策略：
 * - 检测设备性能等级（CPU核心数/内存），低性能设备自动禁用毛玻璃等重渲染效果
 * - 跟随系统 prefers-reduced-motion 设置
 * - 通过 @supports 检测 backdrop-filter 支持情况
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { detectCompatibility, type CompatibilityInfo } from './compatibilityService';

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
  /** 设备兼容性信息，组件可通过此判断是否启用高级特性 */
  compatibility: CompatibilityInfo;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  setTheme: () => {},
  toggleTheme: () => {},
  compatibility: {
    tier: 'high',
    disableGlass: false,
    reducedMotion: false,
    cpuCores: 0,
    deviceMemory: undefined,
    supportsBackdropFilter: true,
  },
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

  // ── 设备兼容性检测（初始化时执行一次） ──
  const [compatibility] = useState<CompatibilityInfo>(() => {
    const info = detectCompatibility();
    // 低性能设备在 documentElement 上添加 .low-perf 标记，CSS 据此降级
    if (info.tier === 'low') {
      document.documentElement.classList.add('low-perf');
    }
    return info;
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
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme, compatibility }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
