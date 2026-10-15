/**
 * scrollDamping — 滚动阻尼（1-10 级，默认 3）+ Phase 1 手势底座
 *
 * 三层管线（scroll-damping-refactor-design.md §4，v1.0 落地）：
 *   ① 输入层  WheelInput（deltaMode 归一化） / TouchGesture（手势状态机：垂直接管·横滑翻页·多指放行）
 *   ② 阻尼核心（纯函数）  dampingMultiplier / frictionCoeff / scaleDelta
 *   ③ 输出层  scrollTarget.scrollTop += Δ（真实滚动容器，与事件文档分离——epub.js 架构刚需）
 *
 * 两类装配：
 *   - attachScrollDamping：scrolled 模式。垂直滚动阻尼（触摸+wheel）+ 横滑翻页回调。
 *   - attachPagedGestures：paged 模式。无滚动容器，仅横滑翻页 + wheel deltaX 翻页。
 *
 * ⚠️ 行为等价红线（重构约束，任何偏差即回归）：
 *   阻尼 1-10 级默认 3、全局 localStorage、事件挂 iframe 内容文档（capture）、滚动落
 *   .epub-container、触摸方向锁定/多指放行/惯性、wheel deltaMode 归一化——全部保留。
 *   friction 插值保留原公式（设计稿 §4.3 决策 1 的派生式与现状曲线端点不一致，按红线取舍）。
 *
 * touch-action 为容器属性：生命周期由容器持有者（EpubBookController.load/destroy）经
 * claimContainerTouchAction / releaseContainerTouchAction 管理，装配函数不再触碰。
 * 横滑翻页：|dx| ≥ 48px 且垂直分量 ≤ 48px 触发（每次手势一次）；屏幕边缘 28px 内起手不触发
 * （保留 iOS 系统返回手势）。
 */

export const SCROLL_DAMPING_MIN = 1;
export const SCROLL_DAMPING_MAX = 10;
export const DEFAULT_SCROLL_DAMPING = 3;

/** 全局设置 localStorage 键 */
const STORAGE_KEY = 'ireader_scroll_damping';

/** 阻尼变更广播事件名（save 时派发，供 UI/装配方订阅即时生效） */
export const SCROLL_DAMPING_CHANGED_EVENT = 'ireader:damping-changed';

/** 1 级（最轻）拖动系数：接近原生 */
const MULT_AT_MIN = 0.9;
/** 10 级（最重）拖动系数：明显减速 */
const MULT_AT_MAX = 0.25;
/** 1 级惯性摩擦系数（每 ms，越小滑行越远） */
const FRICTION_AT_MIN = 0.0012;
/** 10 级惯性摩擦系数（每 ms，越大越快停） */
const FRICTION_AT_MAX = 0.006;
/** 惯性停止阈值（px/ms，约 1.2px/帧 @60fps） */
const MOMENTUM_STOP_V = 0.02;
/** 惯性初速度上限（px/ms，防极端甩动） */
const MOMENTUM_MAX_V = 6;
/** 方向锁定最小位移（px，小于此值不判定方向） */
const DIR_LOCK_THRESHOLD = 6;
/** 横滑翻页位移阈值（px，Phase 1） */
export const SWIPE_PAGE_THRESHOLD = 48;
/** 横滑翻页垂直分量上限（px，斜向大位移不误触发） */
export const SWIPE_VERTICAL_SLOP = 48;
/** 屏幕边缘保护（px：边缘起手的横滑交还系统返回手势） */
export const EDGE_GUARD_PX = 28;
/** paged 模式 wheel deltaX 翻页累计阈值（px） */
const PAGED_WHEEL_PAGE_PX = 40;
/** paged 模式 wheel 翻页节流（ms，防触控板惯性连翻） */
const PAGED_WHEEL_THROTTLE_MS = 250;
/** deltaMode=1（行）行高像素近似 */
const LINE_HEIGHT_PX = 16;
/** deltaMode=2（页）且 clientHeight 为 0 时兜底页高 */
const FALLBACK_PAGE_PX = 800;

// ═══════════ ① 阻尼核心（纯函数，无 DOM，可单测） ═══════════

/** 钳制阻尼级别到 [1,10] 并取整；非有限值回退默认 3 */
export function clampScrollDamping(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_SCROLL_DAMPING;
  return Math.min(SCROLL_DAMPING_MAX, Math.max(SCROLL_DAMPING_MIN, Math.round(level)));
}

/** 级别比例 t∈[0,1]（线性插值基准） */
function levelT(level: number): number {
  return (clampScrollDamping(level) - SCROLL_DAMPING_MIN) / (SCROLL_DAMPING_MAX - SCROLL_DAMPING_MIN);
}

/**
 * 阻尼级别 → 拖动系数（线性单调递减）。
 * 1 级 → 0.9（最轻），3 级 → ≈0.76（默认舒适），10 级 → 0.25（最重）。
 */
export function dampingMultiplier(level: number): number {
  return Math.round((MULT_AT_MIN + levelT(level) * (MULT_AT_MAX - MULT_AT_MIN)) * 100) / 100;
}

/**
 * 阻尼级别 → 惯性摩擦系数（每 ms，线性单调递增）。
 * 级别越高摩擦越大，惯性越快停止（1 级滑行远，10 级几乎无滑行）。
 */
export function frictionCoeff(level: number): number {
  return FRICTION_AT_MIN + levelT(level) * (FRICTION_AT_MAX - FRICTION_AT_MIN);
}

/** 统一增量缩放入口：wheel 与 touch 共享（消重复缩放逻辑，refactor §4.3 决策 6） */
export function scaleDelta(delta: number, level: number): number {
  return delta * dampingMultiplier(level);
}

// ═══════════ 设置持久化 ═══════════

/** 读取全局滚动阻尼级别（缺失 / 损坏回退默认 3） */
export function loadScrollDamping(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SCROLL_DAMPING : clampScrollDamping(Number(raw));
  } catch {
    return DEFAULT_SCROLL_DAMPING;
  }
}

/** 持久化全局滚动阻尼级别（自动 clamp）并广播变更（订阅方经 subscribeScrollDamping 即时生效） */
export function saveScrollDamping(level: number): void {
  const clamped = clampScrollDamping(level);
  try {
    localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch { /* 存储不可用时静默 */ }
  try {
    window.dispatchEvent(new CustomEvent(SCROLL_DAMPING_CHANGED_EVENT, { detail: clamped }));
  } catch { /* 无 window 环境（SSR/测试）静默 */ }
}

/** 订阅阻尼变更广播。返回退订函数。 */
export function subscribeScrollDamping(cb: (level: number) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<number>).detail);
  try {
    window.addEventListener(SCROLL_DAMPING_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SCROLL_DAMPING_CHANGED_EVENT, handler);
  } catch {
    return () => {};
  }
}

// ═══════════ touch-action 容器生命周期（refactor §4.3 决策 2） ═══════════

/**
 * touch-action 是容器属性，生命周期 = 容器生命周期：由容器持有者（Controller.load / destroy）
 * 各调用一次；多 iframe 内容文档共享同一容器时天然无共享计数问题。
 * 实现保留引用计数（幂等、防持有者顺序边缘），但语义收敛为「容器声明」。
 */
const touchActionState = new WeakMap<HTMLElement, { refs: number; prev: string }>();

export function claimContainerTouchAction(el: HTMLElement): void {
  const state = touchActionState.get(el);
  if (state) {
    state.refs += 1;
    return;
  }
  touchActionState.set(el, { refs: 1, prev: el.style.touchAction });
  el.style.touchAction = 'pan-x pinch-zoom';
}

export function releaseContainerTouchAction(el: HTMLElement): void {
  const state = touchActionState.get(el);
  if (!state) return;
  state.refs -= 1;
  if (state.refs <= 0) {
    el.style.touchAction = state.prev;
    touchActionState.delete(el);
  }
}

// ═══════════ ② 输入层：TouchGesture 手势状态机 ═══════════

export type HorizontalSwipeDir = 'prev' | 'next';

export interface TouchGestureCallbacks {
  /** 横滑翻页：|dx|≥SWIPE_PAGE_THRESHOLD 且 |dy|≤SWIPE_VERTICAL_SLOP；每次手势至多一次；边缘起手不触发 */
  onHorizontalSwipe?(dir: HorizontalSwipeDir): void;
}

/**
 * 单指手势状态机（输入层）：
 *   - swipeOnly=false（scrolled 装配）：垂直接管（阻尼增量 + preventDefault）+ 横滑翻页回调
 *   - swipeOnly=true（paged 装配）：仅横滑翻页回调（垂直事件完全不接管，paged 无滚动容器）
 * 多指（捏合缩放）与边缘起手横滑始终放行。
 * 可喂合成 TouchEvent 序列独立单测（onStart/onMove/onEnd/onCancel）。
 */
export class TouchGesture {
  private active = false;
  private swipeOnly = false;
  private axis: '' | 'v' | 'h' = '';
  private startX = 0;
  private startY = 0;
  private lastY = 0;
  private lastT = 0;
  private velocity = 0;
  private swipeFired = false;
  private edgeGuard = false;

  constructor(
    private readonly getLevel: () => number,
    private readonly callbacks: TouchGestureCallbacks = {},
  ) {}

  /** paged 装配模式：垂直事件完全不接管 */
  startSwipeOnly(): this {
    this.swipeOnly = true;
    return this;
  }

  onStart(e: TouchEvent): void {
    if (e.touches.length !== 1) { this.active = false; return; } // 多指（捏合缩放等）交还原生
    const t = e.touches[0];
    this.startX = t.clientX;
    this.startY = this.lastY = t.clientY;
    this.lastT = performance.now();
    this.velocity = 0;
    this.axis = '';
    this.active = !this.swipeOnly || true; // 两种模式都跟踪手势，差异在 onMove 的接管范围
    this.swipeFired = false;
    const viewWidth = (t as Touch & { view?: Window }).view?.innerWidth
      ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
    this.edgeGuard = t.clientX < EDGE_GUARD_PX || t.clientX > viewWidth - EDGE_GUARD_PX;
  }

  /**
   * @returns 垂直接管时的阻尼增量（px，调用方落 scrollTop）；null = 本次不接管
   *（未定方向 / 水平手势 / 多指取消 / swipeOnly 垂直）。横滑达标时内部触发回调并 preventDefault。
   */
  onMove(e: TouchEvent): number | null {
    if (!this.active || e.touches.length !== 1) { this.active = false; return null; }
    const t = e.touches[0];
    const dx = t.clientX - this.startX;
    const dy = t.clientY - this.startY;
    if (this.axis === '') {
      if (Math.abs(dx) + Math.abs(dy) < DIR_LOCK_THRESHOLD) return null; // 位移过小，等待方向明确
      this.axis = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (this.axis === 'h') {
      // 横滑翻页（Phase 1）：阈值判定 + 边缘保护 + 单次触发
      if (!this.swipeFired && !this.edgeGuard
        && Math.abs(dx) >= SWIPE_PAGE_THRESHOLD && Math.abs(dy) <= SWIPE_VERTICAL_SLOP) {
        this.swipeFired = true;
        e.preventDefault();
        this.callbacks.onHorizontalSwipe?.(dx < 0 ? 'next' : 'prev'); // 左滑下一页，右滑上一页
      }
      return null;
    }
    if (this.swipeOnly) return null; // paged：垂直不接管（无滚动容器）
    const now = performance.now();
    const step = this.lastY - t.clientY;               // 正 = 向下滚（内容上移）
    const dt = now - this.lastT || 16;
    const damped = scaleDelta(step, this.getLevel());
    this.velocity = damped / dt;
    e.preventDefault();
    this.lastY = t.clientY;
    this.lastT = now;
    return damped;
  }

  /** @returns 惯性初速（px/ms）；null = 不启动惯性 */
  onEnd(e: TouchEvent): number | null {
    if (!this.active) return null;
    if (e.touches.length > 0) return null;             // 仍有手指（多指切换），不启动惯性
    const wasVertical = this.axis === 'v' && !this.swipeOnly;
    this.active = false;
    if (!wasVertical) return null;
    const v = Math.max(-MOMENTUM_MAX_V, Math.min(MOMENTUM_MAX_V, this.velocity));
    return Math.abs(v) >= MOMENTUM_STOP_V ? v : null;
  }

  onCancel(): void {
    this.active = false;
    this.axis = '';
  }
}

/** 惯性引擎（输出层）：rAF 指数衰减，滚动落在真实滚动容器 */
export class Momentum {
  private raf = 0;

  constructor(private readonly scrollTarget: HTMLElement) {}

  start(v: number, level: number): void {
    this.cancel();
    const k = frictionCoeff(level);
    let last = performance.now();
    const step = (now: number): void => {
      const dt = now - last;
      last = now;
      v *= Math.exp(-k * dt);
      this.scrollTarget.scrollTop += v * dt;
      if (Math.abs(v) > MOMENTUM_STOP_V) this.raf = requestAnimationFrame(step);
      else this.raf = 0;
    };
    this.raf = requestAnimationFrame(step);
  }

  cancel(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }
}

// ═══════════ ③ 装配层 ═══════════

/**
 * scrolled 模式装配：垂直滚动阻尼（触摸 + wheel）+ 横滑翻页回调。
 *
 * ⚠️ 事件与滚动目标分离（epub.js 架构刚需）：事件监听挂 iframe 内容文档（doc），
 * 手动滚动落在父页面 .epub-container（scrollTarget）——iframe 事件不跨文档冒泡。
 *
 * @param doc 事件监听文档
 * @param scrollTarget 真实滚动容器
 * @param getLevel 动态读取当前阻尼级别
 * @param callbacks 横滑翻页回调（Phase 1）
 */
export function attachScrollDamping(
  doc: Document,
  scrollTarget: HTMLElement,
  getLevel: () => number,
  callbacks?: TouchGestureCallbacks,
): () => void {
  const gesture = new TouchGesture(getLevel, callbacks ?? {});
  const momentum = new Momentum(scrollTarget);

  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 触控板横扫不参与垂直阻尼（paged 模式另行翻页）
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT_PX;
    else if (e.deltaMode === 2) delta *= scrollTarget.clientHeight || FALLBACK_PAGE_PX;
    e.preventDefault();
    scrollTarget.scrollTop += scaleDelta(delta, getLevel());
  };
  const onTouchStart = (e: TouchEvent): void => {
    momentum.cancel();
    gesture.onStart(e);
  };
  const onTouchMove = (e: TouchEvent): void => {
    const delta = gesture.onMove(e);
    if (delta !== null) scrollTarget.scrollTop += delta;
  };
  const onTouchEnd = (e: TouchEvent): void => {
    const v = gesture.onEnd(e);
    if (v !== null) momentum.start(v, getLevel());
  };
  const onTouchCancel = (): void => gesture.onCancel();

  doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
  doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  doc.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });

  return () => {
    momentum.cancel();
    doc.removeEventListener('wheel', onWheel, { capture: true });
    doc.removeEventListener('touchstart', onTouchStart, { capture: true });
    doc.removeEventListener('touchmove', onTouchMove, { capture: true });
    doc.removeEventListener('touchend', onTouchEnd, { capture: true });
    doc.removeEventListener('touchcancel', onTouchCancel, { capture: true });
  };
}

/**
 * paged 模式装配：横滑翻页（触摸）+ wheel deltaX 翻页（触控板，节流防惯性连翻）。
 * paged 无滚动容器：垂直事件完全不接管（交还浏览器，默认无滚动效果）。
 */
export function attachPagedGestures(
  doc: Document,
  callbacks: TouchGestureCallbacks & {
    /** wheel deltaX 累计达阈值翻页（dir 同横滑语义：deltaX>0 → prev） */
    onWheelPage?(dir: HorizontalSwipeDir): void;
  },
): () => void {
  const gesture = new TouchGesture(() => DEFAULT_SCROLL_DAMPING, callbacks);
  gesture.startSwipeOnly();

  let wheelAccum = 0;
  let lastWheelPageAt = 0;
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheelPageAt < PAGED_WHEEL_THROTTLE_MS) return;
    wheelAccum += e.deltaX;
    if (Math.abs(wheelAccum) >= PAGED_WHEEL_PAGE_PX) {
      // 方向语义与 TouchGesture 横滑统一：deltaX < 0（手指左滑/内容左移）= next
      const dir: HorizontalSwipeDir = wheelAccum < 0 ? 'next' : 'prev';
      wheelAccum = 0;
      lastWheelPageAt = now;
      callbacks.onWheelPage?.(dir);
    }
  };

  const onTouchStart = (e: TouchEvent): void => gesture.onStart(e);
  const onTouchMove = (e: TouchEvent): void => { gesture.onMove(e); };
  const onTouchEnd = (e: TouchEvent): void => { gesture.onEnd(e); };
  const onTouchCancel = (): void => gesture.onCancel();

  doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
  doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  doc.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });

  return () => {
    doc.removeEventListener('wheel', onWheel, { capture: true });
    doc.removeEventListener('touchstart', onTouchStart, { capture: true });
    doc.removeEventListener('touchmove', onTouchMove, { capture: true });
    doc.removeEventListener('touchend', onTouchEnd, { capture: true });
    doc.removeEventListener('touchcancel', onTouchCancel, { capture: true });
  };
}
