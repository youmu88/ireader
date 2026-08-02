import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampSettings,
  loadSettings,
  useReaderSettings,
  STORAGE_KEY,
} from './useReaderSettings';
import { DEFAULT_READER_SETTINGS } from './theme';
import { DEFAULT_SCROLL_DAMPING } from './scrollDamping';

afterEach(() => {
  localStorage.clear();
});

describe('loadSettings', () => {
  it('无存储时返回默认设置', () => {
    expect(loadSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });

  it('读取并合并已存储设置', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 120, theme: 'sepia' }));
    const s = loadSettings();
    expect(s.fontSize).toBe(120);
    expect(s.theme).toBe('sepia');
    expect(s.lineHeight).toBe(DEFAULT_READER_SETTINGS.lineHeight);
  });

  it('旧存储无 scrollDamping 字段时回退默认 3 级（向后兼容）', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 100, theme: 'white', lineHeight: 1.75 }));
    expect(loadSettings().scrollDamping).toBe(DEFAULT_SCROLL_DAMPING);
  });

  it('JSON 损坏时回退默认值', () => {
    localStorage.setItem(STORAGE_KEY, '{broken json');
    expect(loadSettings()).toEqual(DEFAULT_READER_SETTINGS);
  });
});

describe('clampSettings', () => {
  it('字号超出上限钳到 200', () => {
    expect(clampSettings({ fontSize: 250, theme: 'white', lineHeight: 1.75, scrollDamping: 3 }).fontSize).toBe(200);
  });

  it('字号低于下限钳到 60', () => {
    expect(clampSettings({ fontSize: 30, theme: 'white', lineHeight: 1.75, scrollDamping: 3 }).fontSize).toBe(60);
  });

  it('非法主题回退默认主题', () => {
    const s = clampSettings({ fontSize: 100, theme: 'neon' as never, lineHeight: 1.75, scrollDamping: 3 });
    expect(s.theme).toBe(DEFAULT_READER_SETTINGS.theme);
  });

  it('非法行距回退默认行距', () => {
    const s = clampSettings({ fontSize: 100, theme: 'white', lineHeight: 3.3, scrollDamping: 3 });
    expect(s.lineHeight).toBe(DEFAULT_READER_SETTINGS.lineHeight);
  });

  it('滚动阻尼超出上限钳到 10、低于下限钳到 1', () => {
    expect(clampSettings({ fontSize: 100, theme: 'white', lineHeight: 1.75, scrollDamping: 99 }).scrollDamping).toBe(10);
    expect(clampSettings({ fontSize: 100, theme: 'white', lineHeight: 1.75, scrollDamping: 0 }).scrollDamping).toBe(1);
  });
});

describe('useReaderSettings', () => {
  it('初始值来自 localStorage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fontSize: 140, theme: 'black', lineHeight: 2.0, scrollDamping: 6 }));
    const { result } = renderHook(() => useReaderSettings());
    expect(result.current.settings).toEqual({ fontSize: 140, theme: 'black', lineHeight: 2.0, scrollDamping: 6 });
  });

  it('updateSettings 合并补丁、clamp 并持久化', () => {
    const { result } = renderHook(() => useReaderSettings());
    act(() => {
      result.current.updateSettings({ fontSize: 500, theme: 'gray' });
    });
    expect(result.current.settings.fontSize).toBe(200);
    expect(result.current.settings.theme).toBe('gray');
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.fontSize).toBe(200);
    expect(stored.theme).toBe('gray');
  });

  it('updateSettings 设置滚动阻尼并持久化', () => {
    const { result } = renderHook(() => useReaderSettings());
    act(() => {
      result.current.updateSettings({ scrollDamping: 8 });
    });
    expect(result.current.settings.scrollDamping).toBe(8);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).scrollDamping).toBe(8);
  });
});
