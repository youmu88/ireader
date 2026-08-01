/**
 * ThemeService 单元测试
 * 测试主题切换、持久化、系统偏好跟随
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../themeService';
import { Button } from '../../components/ui/Button';

// ── matchMedia mock 辅助 ──
function createMatchMediaMock(prefersDark: boolean) {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const mockFn = (query: string) => {
    const obj = {
      matches: prefersDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (type: string, listener: (e: any) => void) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(listener);
      },
      removeEventListener: (type: string, listener: (e: any) => void) => {
        if (listeners[type]) {
          listeners[type] = listeners[type].filter((l) => l !== listener);
        }
      },
      dispatchEvent: (e: any) => {
        const type = e.type;
        if (listeners[type]) {
          listeners[type].forEach((l) => l(e));
        }
        return true;
      },
    };
    return obj;
  };
  // 暴露 listeners 供测试触发
  (mockFn as any)._getListeners = () => listeners;
  return mockFn as any;
}

// ── Test component that uses useTheme ──
function ThemeTestConsumer() {
  const { theme, setTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <Button data-testid="btn-toggle" onClick={toggleTheme} variant="ghost" className="!w-auto !h-auto !px-2 !py-1">Toggle</Button>
      <Button data-testid="btn-light" onClick={() => setTheme('light')} variant="ghost" className="!w-auto !h-auto !px-2 !py-1">Light</Button>
      <Button data-testid="btn-dark" onClick={() => setTheme('dark')} variant="ghost" className="!w-auto !h-auto !px-2 !py-1">Dark</Button>
    </div>
  );
}

describe('ThemeService — 基础功能', () => {
  beforeEach(() => {
    // 清除 localStorage
    localStorage.clear();
    // 清除 document 上的 dark class
    document.documentElement.classList.remove('dark');
    // 设置默认 mock (light mode)
    window.matchMedia = createMatchMediaMock(false) as any;
  });

  it('should default to light theme', () => {
    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should toggle theme', () => {
    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('btn-toggle'));
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('should set theme explicitly', () => {
    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('btn-dark'));
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    fireEvent.click(screen.getByTestId('btn-light'));
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
  });

  it('should persist theme to localStorage', () => {
    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    fireEvent.click(screen.getByTestId('btn-dark'));
    expect(localStorage.getItem('ireader-theme')).toBe('dark');
    fireEvent.click(screen.getByTestId('btn-light'));
    expect(localStorage.getItem('ireader-theme')).toBe('light');
  });

  it('should restore theme from localStorage', () => {
    localStorage.setItem('ireader-theme', 'dark');
    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});

describe('ThemeService — 系统偏好跟随', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('should follow system preference when no stored theme', () => {
    // 模拟系统暗色模式
    const mock = createMatchMediaMock(true);
    window.matchMedia = mock as any;

    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    // 初始状态应跟随系统
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('should NOT follow system preference when user has stored theme', () => {
    // 先存一个用户选择
    localStorage.setItem('ireader-theme', 'light');
    // 系统是暗色
    const mock = createMatchMediaMock(true);
    window.matchMedia = mock as any;

    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    // 即使用户选择了亮色，系统暗色也不应覆盖
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
  });

  it('should react to system preference change when no stored theme', () => {
    // 初始为亮色
    const mock = createMatchMediaMock(false);
    window.matchMedia = mock as any;

    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('light');

    // 模拟系统主题变化 → 暗色
    act(() => {
      const listeners = (window.matchMedia as any)._getListeners?.();
      listeners?.change?.forEach((fn: any) => fn({ matches: true }));
    });

    // 没有存储主题时，应跟随系统变化
    expect(screen.getByTestId('theme-value').textContent).toBe('dark');
  });

  it('should NOT react to system preference change when user has stored theme', () => {
    localStorage.setItem('ireader-theme', 'light');
    const mock = createMatchMediaMock(false);
    window.matchMedia = mock as any;

    render(
      <ThemeProvider>
        <ThemeTestConsumer />
      </ThemeProvider>
    );
    expect(screen.getByTestId('theme-value').textContent).toBe('light');

    // 系统变暗
    act(() => {
      (mock as any)._listeners?.change?.forEach((fn: any) => fn({ matches: true }));
    });

    // 用户已存储过主题，不应跟随系统
    expect(screen.getByTestId('theme-value').textContent).toBe('light');
  });
});
