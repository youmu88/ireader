/**
 * scrollDamping — 阅读界面滚动阻尼（1-10 级，默认 3）
 *
 * 阻尼 = 滚动阻力：级别越高，单次滚轮滚动距离越短（内容越「沉」）。
 * 实现为 wheel 事件拦截器：阻止浏览器原生滚动，按阻尼系数缩放 deltaY 后手动滚动。
 *
 * ⚠️ 作用域限定 wheel（鼠标滚轮 / 触控板）：epub.js 连续滚动栈的原生触摸惯性滚动历经多次精修、
 * 极脆弱；自定义触摸惯性引擎风险高（会破坏连续章节加载 / relocated 事件 / 点按桥接），故触摸滚动
 * 保持原生，阻尼仅作用于 wheel。这是对工作系统的边界保护，非遗漏。
 *
 * 纯函数（clampScrollDamping / dampingMultiplier）与 DOM 装配（attachScrollDamping）分离便于单测；
 * getLevel 以闭包动态读取当前级别，设置变更无需重挂监听。
 */

export const SCROLL_DAMPING_MIN = 1;
export const SCROLL_DAMPING_MAX = 10;
export const DEFAULT_SCROLL_DAMPING = 3;

/** 1 级（最轻）滚动系数：接近原生 */
const MULT_AT_MIN = 0.9;
/** 10 级（最重）滚动系数：明显减速 */
const MULT_AT_MAX = 0.25;
/** deltaMode=1（行）时的行高像素近似（归一化为像素） */
const LINE_HEIGHT_PX = 16;
/** deltaMode=2（页）且 clientHeight 为 0 时的兜底页高 */
const FALLBACK_PAGE_PX = 800;

/** 钳制阻尼级别到 [1,10] 并取整；非有限值回退默认 3 */
export function clampScrollDamping(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_SCROLL_DAMPING;
  return Math.min(SCROLL_DAMPING_MAX, Math.max(SCROLL_DAMPING_MIN, Math.round(level)));
}

/**
 * 阻尼级别 → 滚动系数（线性映射，单调递减）。
 * 1 级 → 0.9（最轻），3 级 → ≈0.76（默认舒适），10 级 → 0.25（最重）。
 */
export function dampingMultiplier(level: number): number {
  const lv = clampScrollDamping(level);
  const t = (lv - SCROLL_DAMPING_MIN) / (SCROLL_DAMPING_MAX - SCROLL_DAMPING_MIN);
  return Math.round((MULT_AT_MIN + t * (MULT_AT_MAX - MULT_AT_MIN)) * 100) / 100;
}

/**
 * 为内容文档装配滚动阻尼。返回卸载函数。
 * @param doc 目标文档（epub.js iframe 内容文档）
 * @param getLevel 动态读取当前阻尼级别（设置变更即时生效，无需重挂）
 */
export function attachScrollDamping(doc: Document, getLevel: () => number): () => void {
  const onWheel = (e: WheelEvent): void => {
    const scroller = doc.scrollingElement ?? doc.documentElement;
    if (!scroller) return;
    // deltaMode 归一化为像素：0=像素，1=行，2=页
    let delta = e.deltaY;
    if (e.deltaMode === 1) delta *= LINE_HEIGHT_PX;
    else if (e.deltaMode === 2) delta *= scroller.clientHeight || FALLBACK_PAGE_PX;
    e.preventDefault();
    scroller.scrollTop += delta * dampingMultiplier(getLevel());
  };
  doc.addEventListener('wheel', onWheel, { passive: false, capture: true });
  return () => doc.removeEventListener('wheel', onWheel, { capture: true });
}
