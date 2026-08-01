import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderMenuBar } from './ReaderMenuBar';

function renderBar(over: Partial<Parameters<typeof ReaderMenuBar>[0]> = {}) {
  const props = {
    title: '测试书',
    chromeBackground: '#fff',
    chromeColor: '#000',
    onOpenToc: vi.fn(),
    onOpenFontSettings: vi.fn(),
    ...over,
  };
  return { props, ...render(<ReaderMenuBar {...props} />) };
}

describe('ReaderMenuBar', () => {
  it('渲染目录按钮并触发 onOpenToc', () => {
    const onOpenToc = vi.fn();
    renderBar({ onOpenToc });
    const btn = screen.getByLabelText('目录');
    fireEvent.click(btn);
    expect(onOpenToc).toHaveBeenCalledTimes(1);
  });

  it('渲染书名与 aA 按钮并触发 onOpenFontSettings', () => {
    const onOpenFontSettings = vi.fn();
    renderBar({ onOpenFontSettings });
    expect(screen.getByText('测试书')).toBeDefined();
    fireEvent.click(screen.getByLabelText('字体与主题'));
    expect(onOpenFontSettings).toHaveBeenCalledTimes(1);
  });

  it('不渲染返回书架/书签/全屏按钮（已移除）', () => {
    renderBar();
    expect(screen.queryByText('书库')).toBeNull();
    expect(screen.queryByLabelText('添加书签')).toBeNull();
    expect(screen.queryByLabelText('移除书签')).toBeNull();
    expect(screen.queryByLabelText('全屏')).toBeNull();
    expect(screen.queryByLabelText('退出全屏')).toBeNull();
  });

  it('未提供 onOpenSearch 时不渲染搜索按钮；提供时渲染并可点击', () => {
    renderBar();
    expect(screen.queryByLabelText('搜索')).toBeNull();
    const onOpenSearch = vi.fn();
    renderBar({ onOpenSearch });
    const btn = screen.getByLabelText('搜索');
    fireEvent.click(btn);
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });
});
