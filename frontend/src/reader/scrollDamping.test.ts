import { describe, expect, it } from 'vitest';
import {
  SCROLL_DAMPING_MIN,
  SCROLL_DAMPING_MAX,
  DEFAULT_SCROLL_DAMPING,
  clampScrollDamping,
  dampingMultiplier,
  attachScrollDamping,
} from './scrollDamping';

describe('clampScrollDamping', () => {
  it('合法值原样返回（四舍五入取整）', () => {
    expect(clampScrollDamping(3)).toBe(3);
    expect(clampScrollDamping(3.6)).toBe(4);
  });
  it('低于下限钳到 1', () => expect(clampScrollDamping(0)).toBe(SCROLL_DAMPING_MIN));
  it('高于上限钳到 10', () => expect(clampScrollDamping(99)).toBe(SCROLL_DAMPING_MAX));
  it('非有限值回退默认 3', () => {
    expect(clampScrollDamping(NaN)).toBe(DEFAULT_SCROLL_DAMPING);
    expect(clampScrollDamping(undefined as never)).toBe(DEFAULT_SCROLL_DAMPING);
  });
});

describe('dampingMultiplier', () => {
  it('级别越高阻尼越大（系数严格单调递减）', () => {
    let prev = dampingMultiplier(SCROLL_DAMPING_MIN);
    for (let lv = SCROLL_DAMPING_MIN + 1; lv <= SCROLL_DAMPING_MAX; lv++) {
      const cur = dampingMultiplier(lv);
      expect(cur).toBeLessThan(prev);
      prev = cur;
    }
  });
  it('端点：1 级最轻 0.9、10 级最重 0.25', () => {
    expect(dampingMultiplier(1)).toBeCloseTo(0.9, 5);
    expect(dampingMultiplier(10)).toBeCloseTo(0.25, 5);
  });
  it('默认 3 级为舒适阻尼（明显减速但不过沉）', () => {
    const m = dampingMultiplier(DEFAULT_SCROLL_DAMPING);
    expect(m).toBeLessThan(1);
    expect(m).toBeGreaterThan(0.5);
  });
});

describe('attachScrollDamping', () => {
  /** 构造可观测滚动位置的内容文档（jsdom scrollTop 受 scrollHeight=0 钳制，注入 setter） */
  function makeDoc() {
    const doc = document.implementation.createHTMLDocument('t');
    // 脱离浏览上下文的 jsdom 文档 scrollingElement 为 null，与实现一致回退 documentElement
    const scroller = doc.scrollingElement ?? doc.documentElement;
    let top = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => { top = v; },
    });
    return { doc, getTop: () => top };
  }

  it('wheel 按阻尼系数缩放滚动量并阻止默认行为', () => {
    const { doc, getTop } = makeDoc();
    const cleanup = attachScrollDamping(doc, () => 10); // 最重 0.25
    const ev = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
    doc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(getTop()).toBeCloseTo(25, 5); // 100 * 0.25
    cleanup();
  });

  it('级别实时生效（getLevel 动态读取，无需重挂）', () => {
    const { doc, getTop } = makeDoc();
    let level = 1;
    const cleanup = attachScrollDamping(doc, () => level);
    doc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(getTop()).toBeCloseTo(90, 5); // level 1 → 0.9
    level = 10;
    doc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(getTop() - 90).toBeCloseTo(25, 5); // level 10 → 0.25
    cleanup();
  });

  it('deltaMode=1（行）按行高归一化为像素', () => {
    const { doc, getTop } = makeDoc();
    const cleanup = attachScrollDamping(doc, () => 1); // 0.9
    doc.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(getTop()).toBeCloseTo(43.2, 5); // 3 行 * 16px * 0.9
    cleanup();
  });

  it('cleanup 后不再拦截 wheel', () => {
    const { doc, getTop } = makeDoc();
    const cleanup = attachScrollDamping(doc, () => 5);
    cleanup();
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    doc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(getTop()).toBe(0);
  });
});
