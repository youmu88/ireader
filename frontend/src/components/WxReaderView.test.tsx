import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import WxReaderView from './WxReaderView';

function renderWx(overrides: Record<string, unknown> = {}) {
  return render(
    <WxReaderView
      content={'这是微信读书风格阅读正文，用于验证沉浸式视觉骨架。\n\n第二段内容。'}
      chapterTitle="第一章 微信读书"
      readingMode="scroll"
      fontSize={18}
      lineHeight={1.9}
      letterSpacing={0}
      fontFamily="sans"
      ttsSegments={null}
      activeSegmentIndex={-1}
      searchResults={[]}
      onProgress={() => {}}
      onBoundary={() => {}}
      onPageInfo={() => {}}
      {...overrides}
    />
  );
}

describe('WxReaderView 微信读书沉浸式视觉骨架', () => {
  it('R-001: renders immersive full-height reading body', () => {
    renderWx();
    // 正文渲染
    expect(screen.getByText(/这是微信读书风格阅读正文/)).toBeDefined();
  });

  it('R-003: shows top chapter title bar (visible by default)', () => {
    renderWx();
    expect(screen.getByText('第一章 微信读书')).toBeDefined();
  });

  it('R-003: shows bottom progress bar', () => {
    renderWx();
    // 进度条区域存在
    expect(document.querySelector('[data-testid="wx-progress"]')).toBeTruthy();
  });

  it('R-002: tapping body center toggles toolbar visibility', () => {
    renderWx();
    // 初始可见
    const body = document.querySelector('[data-testid="wx-body"]')!;
    // 模拟点击正文中间区域（jsdom clientHeight=0，用窗口高度；clientY 取中间）
    fireEvent.click(body, { clientY: 300 });
    // 点击后工具栏应隐藏（top/bottom 加 hidden 类）
    const topBar = document.querySelector('[data-testid="wx-topbar"]');
    const bottomBar = document.querySelector('[data-testid="wx-bottombar"]');
    expect(topBar?.className).toContain('opacity-0');
    expect(bottomBar?.className).toContain('opacity-0');
    // 再点恢复
    fireEvent.click(body, { clientY: 300 });
    expect(document.querySelector('[data-testid="wx-topbar"]')?.className).not.toContain('opacity-0');
  });

  it('R-004: renders chapter-end placeholder/sentinel at scroll end', () => {
    renderWx();
    // 章末衔接视觉占位
    expect(document.querySelector('[data-testid="wx-chapter-end"]')).toBeTruthy();
  });

  it('R-006: uses iOS token colors on body', () => {
    renderWx();
    const body = document.querySelector('[data-testid="wx-body"]') as HTMLElement;
    expect(body).toBeTruthy();
    // 正文配色使用 iOS token
    expect(body.style.color).toContain('var(--color-text)');
  });

  it('R-007: clicking top chapter bar triggers onOpenToc (chapter-end/toc interaction)', () => {
    const onOpenToc = vi.fn();
    renderWx({ onOpenToc });
    // 点击顶栏章节名（章节条）→ 触发目录打开
    fireEvent.click(screen.getByText('第一章 微信读书'));
    expect(onOpenToc).toHaveBeenCalled();
  });
});
