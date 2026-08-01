import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TocPanel, isActiveTocItem } from './TocPanel';
import type { TocItem } from '../types';

const TOC: TocItem[] = [
  { id: 'c1', label: '第一章 开始', href: 'ch1.xhtml' },
  {
    id: 'c2',
    label: '第二章 深入',
    href: 'ch2.xhtml',
    subitems: [{ id: 'c2-1', label: '2.1 小节', href: 'ch2.xhtml#s1' }],
  },
];

const renderPanel = (props: Partial<Parameters<typeof TocPanel>[0]> = {}) => {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(
    <TocPanel
      open
      toc={TOC}
      chromeBackground="#fff"
      chromeColor="#000"
      onSelect={onSelect}
      onClose={onClose}
      {...props}
    />,
  );
  return { onSelect, onClose };
};

describe('isActiveTocItem', () => {
  it('href 精确匹配', () => {
    expect(isActiveTocItem('ch1.xhtml', 'ch1.xhtml')).toBe(true);
  });
  it('目录项带 fragment 时按章节部分匹配', () => {
    expect(isActiveTocItem('ch2.xhtml#s1', 'ch2.xhtml')).toBe(true);
  });
  it('不同章节不匹配 / 无 currentHref 不匹配', () => {
    expect(isActiveTocItem('ch1.xhtml', 'ch2.xhtml')).toBe(false);
    expect(isActiveTocItem('ch1.xhtml', undefined)).toBe(false);
  });
});

describe('TocPanel', () => {
  it('渲染章节树（含嵌套子章节）', () => {
    renderPanel();
    expect(screen.getByText('第一章 开始')).toBeDefined();
    expect(screen.getByText('第二章 深入')).toBeDefined();
    expect(screen.getByText('2.1 小节')).toBeDefined();
  });

  it('点击章节触发 onSelect 并携带 href', () => {
    const { onSelect } = renderPanel();
    fireEvent.click(screen.getByText('2.1 小节'));
    expect(onSelect).toHaveBeenCalledWith('ch2.xhtml#s1');
  });

  it('当前章节高亮（aria-current）', () => {
    renderPanel({ currentHref: 'ch2.xhtml' });
    expect(screen.getByText('第二章 深入').getAttribute('aria-current')).toBe('true');
    // 子章节 href 去 fragment 后同章，也高亮
    expect(screen.getByText('2.1 小节').getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('第一章 开始').getAttribute('aria-current')).toBeNull();
  });

  it('点击遮罩触发 onClose', () => {
    const { onClose } = renderPanel();
    fireEvent.click(screen.getByTestId('toc-panel').firstElementChild!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('open=false 时透明且不响应指针', () => {
    renderPanel({ open: false });
    const panel = screen.getByTestId('toc-panel');
    expect(panel.className).toContain('opacity-0');
    expect(panel.className).toContain('pointer-events-none');
  });

  it('空目录时显示占位文案', () => {
    renderPanel({ toc: [] });
    expect(screen.getByText('本书暂无目录')).toBeDefined();
  });
});
