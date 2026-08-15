/**
 * useReaderChromeTheme — 阅读主题 → 浏览器镀铬层（状态栏覆盖层 + html/body 根背景 + theme-color）收敛测试
 *
 * 覆盖：
 * 1. 返回声明式状态栏覆盖层样式（背景跟随传入主题色，高度为安全区）；
 * 2. 挂载时同步 theme-color meta 与 html/body 根背景；
 * 3. 主题切换时三处同步更新（不再依赖退出重进）；
 * 4. 卸载时还原【首次挂载初始值】而非捕获值（多次切换后退出不污染书架背景）。
 */
import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useReaderChromeTheme } from './useReaderChromeTheme';
import { resetChromeThemeManagerForTests } from './chromeThemeManager';

const DEFAULT_META = '#3b82f6';

beforeEach(() => {
  resetChromeThemeManagerForTests();
  document.documentElement.style.background = '';
  document.body.style.background = '';
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.setAttribute('content', DEFAULT_META);
  document.head.appendChild(meta);
});

describe('useReaderChromeTheme', () => {
  it('返回声明式状态栏覆盖层样式：高度为安全区、背景跟随主题色', () => {
    const { result } = renderHook(() => useReaderChromeTheme('#000000'));
    expect(result.current.statusBarStyle).toEqual({
      height: 'env(safe-area-inset-top, 0px)',
      background: '#000000',
    });
  });

  it('挂载时同步 theme-color meta 与 html/body 根背景为主题色', () => {
    renderHook(() => useReaderChromeTheme('#000000'));
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe('#000000');
    // jsdom 将 hex 规范化为 rgb()
    expect(document.documentElement.style.background).toBe('rgb(0, 0, 0)');
    expect(document.body.style.background).toBe('rgb(0, 0, 0)');
  });

  it('主题切换时三处同步更新（不依赖退出重进）', () => {
    const { rerender } = renderHook(({ bg }) => useReaderChromeTheme(bg), {
      initialProps: { bg: '#ffffff' },
    });
    expect(document.body.style.background).toBe('rgb(255, 255, 255)');
    rerender({ bg: '#000000' });
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe('#000000');
    expect(document.documentElement.style.background).toBe('rgb(0, 0, 0)');
    expect(document.body.style.background).toBe('rgb(0, 0, 0)');
  });

  it('卸载时还原首次挂载初始值（而非捕获值）：多次切换后退出不污染根背景', () => {
    const { rerender, unmount } = renderHook(({ bg }) => useReaderChromeTheme(bg), {
      initialProps: { bg: '#ffffff' },
    });
    rerender({ bg: '#000000' });
    rerender({ bg: '#2c2c2e' });
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    unmount();
    // 还原为挂载前状态（html/body 空、meta 默认色），而不是「倒数第二次」的 #000000
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe(DEFAULT_META);
    expect(document.documentElement.style.background).toBe('');
    expect(document.body.style.background).toBe('');
  });

  it('挂载前已存在的根背景在卸载后原样还原', () => {
    document.documentElement.style.background = 'rgb(10, 20, 30)';
    document.body.style.background = 'rgb(40, 50, 60)';
    const { unmount } = renderHook(() => useReaderChromeTheme('#000000'));
    expect(document.documentElement.style.background).toBe('rgb(0, 0, 0)');
    expect(document.body.style.background).toBe('rgb(0, 0, 0)');
    act(() => unmount());
    expect(document.documentElement.style.background).toBe('rgb(10, 20, 30)');
    expect(document.body.style.background).toBe('rgb(40, 50, 60)');
  });

  it('页面恢复兑底：根背景被外部还原为白后，pageshow 重新应用主题色（再次进入不变白）', () => {
    const { unmount } = renderHook(() => useReaderChromeTheme('#2c2c2e'));
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    // 模拟 iOS standalone 快照恢复：根背景被还原为书架白色，且 effect 不重跑
    document.documentElement.style.background = 'rgb(255, 255, 255)';
    document.body.style.background = 'rgb(255, 255, 255)';
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(document.documentElement.style.background).toBe('rgb(44, 44, 46)');
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    expect(meta?.getAttribute('content')).toBe('#2c2c2e');
    act(() => unmount());
  });

  it('页面从后台切回（visibilitychange→visible）时重新应用主题背景', () => {
    const { unmount } = renderHook(() => useReaderChromeTheme('#2c2c2e'));
    document.body.style.background = 'rgb(255, 255, 255)';
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    act(() => unmount());
  });

  it('paint 前同步应用：useLayoutEffect 语义（挂载即应用，无需等待异步 effect）', () => {
    const { result } = renderHook(() => useReaderChromeTheme('#2c2c2e'));
    // useLayoutEffect 在 commit 阶段同步执行——渲染后立即可见根背景已为主题色
    expect(document.body.style.background).toBe('rgb(44, 44, 46)');
    expect(result.current.statusBarStyle.background).toBe('#2c2c2e');
  });
});
