import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReaderMenuBar } from './ReaderMenuBar';

function renderBar(over: Partial<Parameters<typeof ReaderMenuBar>[0]> = {}) {
  const props = {
    title: '测试书',
    chromeBackground: '#fff',
    chromeColor: '#000',
    onBack: vi.fn(),
    onOpenToc: vi.fn(),
    onOpenFontSettings: vi.fn(),
    ...over,
  };
  return { props, ...render(<ReaderMenuBar {...props} />) };
}

describe('ReaderMenuBar', () => {
  it('默认不渲染全屏按钮（未提供回调时保持向后兼容）', () => {
    renderBar();
    expect(screen.queryByLabelText('全屏')).toBeNull();
    expect(screen.queryByLabelText('退出全屏')).toBeNull();
  });

  it('提供 onToggleFullscreen 时渲染全屏按钮并可点击', () => {
    const onToggleFullscreen = vi.fn();
    renderBar({ onToggleFullscreen });
    const btn = screen.getByLabelText('全屏');
    fireEvent.click(btn);
    expect(onToggleFullscreen).toHaveBeenCalledTimes(1);
  });

  it('fullscreenActive 时按钮切换为退出全屏图标', () => {
    renderBar({ fullscreenActive: true, onToggleFullscreen: vi.fn() });
    expect(screen.getByLabelText('退出全屏')).toBeDefined();
  });
});
