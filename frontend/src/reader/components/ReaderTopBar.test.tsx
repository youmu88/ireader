import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderTopBar } from './ReaderTopBar';

function renderBar(over: Partial<Parameters<typeof ReaderTopBar>[0]> = {}) {
  const props = {
    title: '测试书',
    chromeBackground: '#262628',
    chromeColor: '#d1d1d6',
    onBack: vi.fn(),
    onOpenFontSettings: vi.fn(),
    ...over,
  };
  return { props, ...render(<ReaderTopBar {...props} />) };
}

describe('ReaderTopBar', () => {
  it('渲染返回按钮并触发 onBack', () => {
    const onBack = vi.fn();
    renderBar({ onBack });
    const btn = screen.getByLabelText('返回书架');
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('渲染书名与 aA 按钮并触发 onOpenFontSettings', () => {
    const onOpenFontSettings = vi.fn();
    renderBar({ onOpenFontSettings });
    expect(screen.getByText('测试书')).toBeDefined();
    fireEvent.click(screen.getByLabelText('字体与主题'));
    expect(onOpenFontSettings).toHaveBeenCalledTimes(1);
  });

  it('默认不渲染沉浸式说明入口；showImmersiveTip 时渲染并可触发', () => {
    renderBar();
    expect(screen.queryByLabelText('沉浸式阅读说明')).toBeNull();
    const onShowImmersiveTip = vi.fn();
    renderBar({ showImmersiveTip: true, onShowImmersiveTip });
    const btn = screen.getByLabelText('沉浸式阅读说明');
    fireEvent.click(btn);
    expect(onShowImmersiveTip).toHaveBeenCalledTimes(1);
  });

  it('主题色注入到容器背景/文字色', () => {
    const { container } = renderBar({ chromeBackground: 'rgba(38,38,40,0.98)', chromeColor: '#d1d1d6' });
    const bar = container.querySelector('[data-testid="reader-top-bar"]') as HTMLElement;
    expect(bar.style.background).toBe('rgba(38, 38, 40, 0.98)');
    expect(bar.style.color).toBe('rgb(209, 209, 214)');
    // env(safe-area-inset-top) 由真实浏览器解析（jsdom 不支持 env()，不在此断言）
    expect(bar.style.borderColor).toBe('rgba(128, 128, 128, 0.25)');
  });
});
