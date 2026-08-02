/**
 * scrollDamping — 全局滚动阻尼（1-10 级，默认 3）
 *
 * 阻尼 = 滚动阻力：级别越高，滚动越「沉」（单次位移更短、惯性更快衰减）。
 * 同时作用于触摸（移动端主场景）与 wheel（鼠标 / 触控板）：
 *  - 触摸：自定义滚动引擎——touchmove 拦截原生滚动并按阻尼系数缩放位移，touchend 后以随级别
 *    递增的摩擦系数做惯性动量（rAF 驱动）。方向锁定仅接管垂直手势，水平滑动（返回手势）与
 *    多指捏合缩放交还原生。
 *  - wheel：拦截原生滚动，按阻尼系数缩放 deltaY 后手动滚动。
 *
 * ⚠️ 事件与滚动目标分离（修复「滚动功能失效」根因）：
 * epub.js scrolled-continuous（renderTo 目标是普通 div → fullsize=false）的真实滚动容器是父页面
 * stage 创建的 div.epub-container（overflow-y: scroll，default/index.js:90,120-121），而触摸/滚轮
 * 事件发生在 iframe 内容文档中（iframe scrolling="no" 不滚动）。故事件监听挂在 iframe 内容文档
 * （doc），手动滚动必须落在父页面 .epub-container（scrollTarget）——历史版本错误地滚动 iframe 内容
 * 文档 documentElement（不滚动），配合 preventDefault 导致垂直滚动彻底失效。
 *
 * 设置经 localStorage 全局持久化（load/saveScrollDamping），由「设置」页调节；阅读器装配时经
 * getLevel 闭包（loadScrollDamping）动态读取，始终反映最新全局值。
 * 纯函数（clamp/multiplier/friction）与 DOM 装配（attachScrollDamping）分离便于单测。
 */

export const SCROLL_DAMPING_MIN = 1;
export const SCROLL_DAMPING_MAX = 10;
export const DEFAULT_SCROLL_DAMPING = 3;

/** 全局设置 localStorage 键 */
const STORAGE_KEY = 'ireader_scroll_damping';

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
/** deltaMode=1（行）行高像素近似 */
const LINE_HEIGHT_PX = 16;
/** deltaMode=2（页）且 clientHeight 为 0 时兜底页高 */
const FALLBACK_PAGE_PX = 800;

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

/** 读取全局滚动阻尼级别（缺失 / 损坏回退默认 3） */
export function loadScrollDamping(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SCROLL_DAMPING : clampScrollDamping(Number(raw));
  } catch {
    return DEFAULT_SCROLL_DAMPING;
  }
}

/** 持久化全局滚动阻尼级别（自动 clamp） */
export function saveScrollDamping(level: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clampScrollDamping(level)));
  } catch { /* 存储不可用时静默 */ }
}

/**
 * touch-action 引用计数：多个 iframe 内容文档共享同一滚动容器（.epub-container）时，
 * 首次装配设置 pan-x pinch-zoom、末次卸载才还原——避免简单 save/restore 在共享容器上
 * 因装配顺序导致还原污染（中途还原成中间态）。
 */
const touchActionState = new WeakMap<HTMLElement, { refs: number; prev: string }>();

function claimTouchAction(el: HTMLElement): void {
  const state = touchActionState.get(el);
  if (state) {
    state.refs += 1;
    return;
  }
  touchActionState.set(el, { refs: 1, prev: el.style.touchAction });
  el.style.touchAction = 'pan-x pinch-zoom';
}

function releaseTouchAction(el: HTMLElement): void {
  const state = touchActionState.get(el);
  if (!state) return;
  state.refs -= 1;
  if (state.refs <= 0) {
    el.style.touchAction = state.prev;
    touchActionState.delete(el);
  }
}

/**
 * 为 iframe 内容文档装配滚动阻尼（触摸 + wheel）。返回卸载函数（移除全部监听、取消惯性、释放 touch-action）。
 *
 * @param doc 事件监听文档（epub.js iframe 内容文档；触摸/滚轮事件在此派发）
 * @param scrollTarget 真实滚动容器（父页面 div.epub-container；手动滚动落在此处）
 * @param getLevel 动态读取当前阻尼级别
 */
export function attachScrollDamping(doc: Document, scrollTarget: HTMLElement, getLevel: () => number): () => void {
  // ── wheel（鼠标 / 触控板） ──
  const onWheel = (e: WheelEvent): void => {
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT_PX;
    else if (e.deltaMode === 2) delta *= scrollTarget.clientHeight || FALLBACK_PAGE_PX;
    e.preventDefault();
    scrollTarget.scrollTop += delta * dampingMultiplier(getLevel());
  };

  // ── 触摸惯性引擎（移动端主场景） ──
  let active = false;                 // 当前手势是否由阻尼接管
  let axis: '' | 'v' | 'h' = '';      // 方向锁定：''=未定 / 'v'=垂直 / 'h'=水平
  let startX = 0, startY = 0, lastY = 0, lastT = 0;
  let velocity = 0;                   // 内容速度 px/ms（已含阻尼）
  let momentumRaf = 0;

  const cancelMomentum = (): void => {
    if (momentumRaf) {
      cancelAnimationFrame(momentumRaf);
      momentumRaf = 0;
    }
  };

  const startMomentum = (): void => {
    let v = Math.max(-MOMENTUM_MAX_V, Math.min(MOMENTUM_MAX_V, velocity));
    if (Math.abs(v) < MOMENTUM_STOP_V) return;
    const k = frictionCoeff(getLevel());
    let last = performance.now();
    const step = (now: number): void => {
      const dt = now - last;
      last = now;
      v *= Math.exp(-k * dt);
      scrollTarget.scrollTop += v * dt;
      if (Math.abs(v) > MOMENTUM_STOP_V) momentumRaf = requestAnimationFrame(step);
      else momentumRaf = 0;
    };
    momentumRaf = requestAnimationFrame(step);
  };

  const onTouchStart = (e: TouchEvent): void => {
    cancelMomentum();
    if (e.touches.length !== 1) { active = false; return; } // 多指（捏合缩放等）交还原生
    const t = e.touches[0];
    startX = t.clientX;
    startY = lastY = t.clientY;
    lastT = performance.now();
    velocity = 0;
    axis = '';
    active = true;
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (!active || e.touches.length !== 1) { active = false; return; }
    const t = e.touches[0];
    if (axis === '') {
      const adx = Math.abs(t.clientX - startX);
      const ady = Math.abs(t.clientY - startY);
      if (adx + ady < DIR_LOCK_THRESHOLD) return;      // 位移过小，等待方向明确
      axis = adx > ady ? 'h' : 'v';
      if (axis === 'h') { active = false; return; }    // 水平手势（返回 / 横滑）交还原生
    }
    if (axis !== 'v') return;
    const now = performance.now();
    const dy = lastY - t.clientY;                      // 正 = 向下滚（内容上移）
    const dt = now - lastT || 16;
    const dampedDy = dy * dampingMultiplier(getLevel());
    velocity = dampedDy / dt;
    scrollTarget.scrollTop += dampedDy;
    e.preventDefault();
    lastY = t.clientY;
    lastT = now;
  };

  const onTouchEnd = (e: TouchEvent): void => {
    if (!active) return;
    if (e.touches.length > 0) return;                  // 仍有手指（多指切换），不启动惯性
    const wasVertical = axis === 'v';
    active = false;
    if (wasVertical) startMomentum();
  };

  const onTouchCancel = (): void => {
    active = false;
    axis = '';
  };

  // touch-action：在真实滚动容器上设置（而非 iframe 文档），仅保留水平 pan 与捏合缩放，
  // 垂直滚动由本引擎接管（确保 touchmove preventDefault 在真机可靠生效）
  claimTouchAction(scrollTarget);

  doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
  doc.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  doc.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
  doc.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  doc.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });

  return () => {
    cancelMomentum();
    doc.removeEventListener('wheel', onWheel, { capture: true });
    doc.removeEventListener('touchstart', onTouchStart, { capture: true });
    doc.removeEventListener('touchmove', onTouchMove, { capture: true });
    doc.removeEventListener('touchend', onTouchEnd, { capture: true });
    doc.removeEventListener('touchcancel', onTouchCancel, { capture: true });
    releaseTouchAction(scrollTarget);
  };
}
