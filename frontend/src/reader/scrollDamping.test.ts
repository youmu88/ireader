import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCROLL_DAMPING_MIN,
  SCROLL_DAMPING_MAX,
  DEFAULT_SCROLL_DAMPING,
  clampScrollDamping,
  dampingMultiplier,
  frictionCoeff,
  loadScrollDamping,
  saveScrollDamping,
  attachScrollDamping,
} from './scrollDamping';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 触摸事件构造（jsdom TouchEvent 支持有限，用 Event + defineProperty 注入 touches） ──
const pt = (x: number, y: number) => ({ clientX: x, clientY: y, identifier: 0 });
function fireTouch(doc: Document, type: string, touches: { clientX: number; clientY: number }[]) {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  Object.defineProperty(ev, 'touches', { value: touches, configurable: true });
  Object.defineProperty(ev, 'changedTouches', { value: touches, configurable: true });
  doc.dispatchEvent(ev);
  return ev;
}

/**
 * 构造阻尼装配环境：eventDoc（iframe 内容文档，触摸/滚轮事件在此派发）+ scrollTarget
 * （父页面 .epub-container，真实滚动容器；jsdom scrollTop 受 scrollHeight=0 钳制，注入 setter 使位移可观测）。
 * 事件与滚动目标分离是本模块的核心语义（修复「滚动功能失效」根因）。
 */
function makeEnv() {
  const eventDoc = document.implementation.createHTMLDocument('iframe-content');
  const scrollTarget = document.createElement('div');
  let top = 0;
  Object.defineProperty(scrollTarget, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; },
  });
  return { eventDoc, scrollTarget, getTop: () => top };
}

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

describe('frictionCoeff', () => {
  it('级别越高摩擦越大（严格单调递增）', () => {
    let prev = frictionCoeff(SCROLL_DAMPING_MIN);
    for (let lv = SCROLL_DAMPING_MIN + 1; lv <= SCROLL_DAMPING_MAX; lv++) {
      const cur = frictionCoeff(lv);
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });
  it('系数恒为正', () => {
    for (let lv = SCROLL_DAMPING_MIN; lv <= SCROLL_DAMPING_MAX; lv++) {
      expect(frictionCoeff(lv)).toBeGreaterThan(0);
    }
  });
});

describe('load/saveScrollDamping（全局持久化）', () => {
  it('无存储返回默认 3', () => expect(loadScrollDamping()).toBe(DEFAULT_SCROLL_DAMPING));
  it('save 后 load 读回', () => {
    saveScrollDamping(7);
    expect(loadScrollDamping()).toBe(7);
  });
  it('save 自动 clamp（越界钳制）', () => {
    saveScrollDamping(99);
    expect(loadScrollDamping()).toBe(10);
    saveScrollDamping(-5);
    expect(loadScrollDamping()).toBe(1);
  });
  it('非法存储值回退默认', () => {
    localStorage.setItem('ireader_scroll_damping', 'abc');
    expect(loadScrollDamping()).toBe(DEFAULT_SCROLL_DAMPING);
  });
});

describe('attachScrollDamping — wheel', () => {
  it('wheel 按阻尼系数缩放滚动量并阻止默认行为', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 10); // 最重 0.25
    const ev = new WheelEvent('wheel', { deltaY: 100, deltaMode: 0, cancelable: true });
    eventDoc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(getTop()).toBeCloseTo(25, 5); // 100 * 0.25 滚在 scrollTarget
    cleanup();
  });

  it('级别实时生效（getLevel 动态读取，无需重挂）', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    let level = 1;
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => level);
    eventDoc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(getTop()).toBeCloseTo(90, 5); // level 1 → 0.9
    level = 10;
    eventDoc.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true }));
    expect(getTop() - 90).toBeCloseTo(25, 5); // level 10 → 0.25
    cleanup();
  });

  it('deltaMode=1（行）按行高归一化为像素', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 1); // 0.9
    eventDoc.dispatchEvent(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, cancelable: true }));
    expect(getTop()).toBeCloseTo(43.2, 5); // 3 行 * 16px * 0.9
    cleanup();
  });

  it('cleanup 后不再拦截 wheel', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 5);
    cleanup();
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true });
    eventDoc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(getTop()).toBe(0);
  });
});

describe('attachScrollDamping — 触摸（移动端主场景）', () => {
  it('垂直触摸拖动按阻尼系数缩放并 preventDefault（滚动落在 scrollTarget）', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 10); // mult 0.25
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    fireTouch(eventDoc, 'touchstart', [pt(50, 200)]);
    now = 1016;
    const ev = fireTouch(eventDoc, 'touchmove', [pt(50, 100)]); // dy = 200-100 = 100
    expect(ev.defaultPrevented).toBe(true);
    expect(getTop()).toBeCloseTo(25, 5); // 100 * 0.25
    cleanup();
  });

  it('连续拖动累加阻尼位移', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 1); // mult 0.9
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    fireTouch(eventDoc, 'touchstart', [pt(50, 300)]);
    now = 1016;
    fireTouch(eventDoc, 'touchmove', [pt(50, 200)]); // dy=100 → 90
    now = 1032;
    fireTouch(eventDoc, 'touchmove', [pt(50, 100)]); // dy=100 → 90
    expect(getTop()).toBeCloseTo(180, 5);
    cleanup();
  });

  it('水平手势不拦截（交还原生，如返回滑动）', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 5);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    fireTouch(eventDoc, 'touchstart', [pt(50, 200)]);
    const ev = fireTouch(eventDoc, 'touchmove', [pt(150, 200)]); // adx=100 > ady=0 → 水平
    expect(ev.defaultPrevented).toBe(false);
    expect(getTop()).toBe(0);
    cleanup();
  });

  it('多指手势不拦截（捏合缩放交还原生）', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 5);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    fireTouch(eventDoc, 'touchstart', [pt(50, 200), pt(150, 200)]); // 2 指 → active=false
    const ev = fireTouch(eventDoc, 'touchmove', [pt(50, 100), pt(150, 100)]);
    expect(ev.defaultPrevented).toBe(false);
    expect(getTop()).toBe(0);
    cleanup();
  });

  it('touchend 后启动惯性动量：rAF 步进继续滚动（惯性滚在 scrollTarget）', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 1); // 轻阻尼长滑行
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let rafCb: ((t: number) => void) | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { rafCb = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { rafCb = null; });

    fireTouch(eventDoc, 'touchstart', [pt(50, 300)]);
    now = 1016;
    fireTouch(eventDoc, 'touchmove', [pt(50, 100)]); // dy=200 → 产生速度
    fireTouch(eventDoc, 'touchend', []); // 启动惯性
    expect(rafCb).not.toBeNull(); // rAF 已调度

    const before = getTop();
    now = 1032;
    rafCb!(1032); // 步进一帧
    expect(getTop()).toBeGreaterThan(before); // 惯性继续滚动
    cleanup();
  });

  it('touchstart 取消进行中的惯性', () => {
    const { eventDoc, scrollTarget } = makeEnv();
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 1);
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let rafCb: ((t: number) => void) | null = null;
    let cancelled = false;
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => { rafCb = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { cancelled = true; rafCb = null; });

    fireTouch(eventDoc, 'touchstart', [pt(50, 300)]);
    now = 1016;
    fireTouch(eventDoc, 'touchmove', [pt(50, 100)]);
    fireTouch(eventDoc, 'touchend', []); // 启动惯性
    expect(rafCb).not.toBeNull();
    fireTouch(eventDoc, 'touchstart', [pt(50, 300)]); // 新触摸 → 取消惯性
    expect(cancelled).toBe(true);
    cleanup();
  });

  it('touch-action 设置在真实滚动容器（scrollTarget）上，cleanup 还原并移除触摸监听', () => {
    const { eventDoc, scrollTarget, getTop } = makeEnv();
    const initial = scrollTarget.style.touchAction; // jsdom 未设置时为 undefined，真机为 ''
    const cleanup = attachScrollDamping(eventDoc, scrollTarget, () => 5);
    expect(scrollTarget.style.touchAction).toBe('pan-x pinch-zoom');
    cleanup();
    expect(scrollTarget.style.touchAction).toBe(initial); // 还原为装配前的初始值（还原语义，不硬编码具体值）
    // 触摸不再被拦截
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    fireTouch(eventDoc, 'touchstart', [pt(50, 200)]);
    const ev = fireTouch(eventDoc, 'touchmove', [pt(50, 100)]);
    expect(ev.defaultPrevented).toBe(false);
    expect(getTop()).toBe(0);
  });

  it('多个 iframe 文档共享同一滚动容器：touch-action 引用计数，末次卸载才还原', () => {
    const { eventDoc, scrollTarget } = makeEnv();
    const doc2 = document.implementation.createHTMLDocument('iframe-2');
    const initial = scrollTarget.style.touchAction;
    const c1 = attachScrollDamping(eventDoc, scrollTarget, () => 3);
    const c2 = attachScrollDamping(doc2, scrollTarget, () => 3);
    expect(scrollTarget.style.touchAction).toBe('pan-x pinch-zoom');
    c1();
    expect(scrollTarget.style.touchAction).toBe('pan-x pinch-zoom'); // 仍有一个引用
    c2();
    expect(scrollTarget.style.touchAction).toBe(initial); // 全部卸载才还原
  });
});
