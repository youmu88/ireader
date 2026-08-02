/**
 * scrollDamping — 全局滚动阻尼（1-10 级，默认 3）
 *
 * 阻尼 = 滚动阻力：级别越高，滚动越「沉」（单次位移更短、惯性更快衰减）。
 * 同时作用于触摸（移动端主场景）与 wheel（鼠标 / 触控板）：
 *  - 触摸：自定义滚动引擎——touchmove 拦截原生滚动并按阻尼系数缩放位移，touchend 后以随级别
 *    递增的摩擦系数做惯性动量（rAF 驱动）。手动 scrollTop 仍触发原生 scroll 事件，epub.js 连续
 *    章节加载 / relocated / 点按桥接均不受影响（与 wheel 路径同机制）。方向锁定仅接管垂直手势，
 *    水平滑动（返回手势）与多指捏合缩放交还原生。
 *  - wheel：拦截原生滚动，按阻尼系数缩放 deltaY 后手动滚动。
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

/** 取文档滚动元素（epub.js iframe 内容文档：scrollingElement 脱离上下文时为 null，回退 documentElement） */
function scrollerOf(doc: Document): Element | null {
  return doc.scrollingElement ?? doc.documentElement;
}

/**
 * 为内容文档装配滚动阻尼（触摸 + wheel）。返回卸载函数（移除全部监听、取消惯性、还原 touch-action）。
 * @param doc 目标文档（epub.js iframe 内容文档）
 * @param getLevel 动态读取当前阻尼级别
 */
export function attachScrollDamping(doc: Document, getLevel: () => number): () => void {
  // ── wheel（鼠标 / 触控板） ──
  const onWheel = (e: WheelEvent): void => {
    const scroller = scrollerOf(doc);
    if (!scroller) return;
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT_PX;
    else if (e.deltaMode === 2) delta *= scroller.clientHeight || FALLBACK_PAGE_PX;
    e.preventDefault();
    scroller.scrollTop += delta * dampingMultiplier(getLevel());
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
      const scroller = scrollerOf(doc);
      if (scroller) scroller.scrollTop += v * dt;
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
    const scroller = scrollerOf(doc);
    if (scroller) scroller.scrollTop += dampedDy;
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

  // touch-action：仅保留水平 pan 与捏合缩放，垂直滚动由本引擎接管
  // （确保 touchmove preventDefault 在真机 iOS Safari / Android Chrome 可靠生效）
  const root = doc.documentElement;
  const prevTouchAction = root.style.touchAction;
  root.style.touchAction = 'pan-x pinch-zoom';

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
    root.style.touchAction = prevTouchAction;
  };
}
