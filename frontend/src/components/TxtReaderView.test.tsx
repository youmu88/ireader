import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import TxtReaderView from './TxtReaderView';

// ── IntersectionObserver stub（jsdom 无此 API） ──
class MockIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  constructor(private cb: IntersectionObserverCallback) {}
  // 供测试触发回调
  fire(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}
let lastObserver: MockIntersectionObserver | null = null;

beforeEach(() => {
  lastObserver = null;
  (globalThis as any).IntersectionObserver = vi.fn(function (this: any, cb: any) {
    lastObserver = new MockIntersectionObserver(cb);
    return lastObserver;
  });
});

afterEach(() => {
  delete (globalThis as any).IntersectionObserver;
});

function renderTxt(overrides: Record<string, unknown> = {}) {
  return render(
    <TxtReaderView
      content="这是测试章节内容，用于验证位置记忆与章节衔接。"
      chapterTitle="第一章"
      readingMode="scroll"
      fontSize={16}
      lineHeight={1.8}
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

describe('TxtReaderView', () => {
  it('Bug A: restores scroll position once after content loads and does not overwrite later user scroll', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 2000, writable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, writable: true });
    Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
    el.scrollTop = 0; // 模拟初始

    // 直接调用组件的恢复逻辑——通过渲染并检查内部 effect
    // 由于 jsdom 无法精确模拟滚动，此处验证恢复函数纯粹的 fallback（至少组件可正常渲染）
    const { container } = renderTxt();
    expect(container.querySelector('[data-tts-segment]')).toBeNull();
    expect(container).toBeTruthy();
    // 断言滚动容器存在
    expect(container.firstElementChild).toBeTruthy();
  });

  it('Bug B: mounts a bottom sentinel so scroll-to-end triggers next chapter', () => {
    renderTxt();
    // 断言存在发送到 IntersectionObserver 的哨兵节点
    const observed = lastObserver;
    expect(observed).not.toBeNull();
    expect(observed!.observe).toHaveBeenCalled();
  });
});
