import { useRef, useCallback } from 'react';

/**
 * 统一手势识别入口（gesture hub）
 * --------------------------------------------------
 * 集中定义阅读器常见手势：左右滑动翻页、长按浮窗、点击、文字选择穿透。
 * 解决历史痛点：手势逻辑曾散落在 ReaderPage（外层 DOM）与 EpubViewer（iframe 内）两处，
 * 且因 epub 内容在 iframe 内、外层 touch 事件无法穿透，导致 epub 模式滑动翻页/长按双双失效。
 *
 * 本模块提供两种挂载方式：
 *  1. attachToElement(el)：外层普通 DOM（txt 模式 / 桌面端），直接绑原生事件。
 *  2. attachToEpubContents(contents[])：epub 模式，遍历 rendition.getContents() 在
 *     iframe 的 document 上注入 touch 监听（epub.js 官方注入通道，非 hack）。
 *
 * 设计护栏：
 *  - 不拦截文字选择：识别为 longpress 后才阻止后续 click 误触发，否则一律放行原生行为。
 *  - 阈值全为常量，调参只改一处。
 */

// ── 统一手势常量（全应用唯一来源，消除历史 600/1000ms 不一致）──
export const GESTURE_CONFIG = {
  /** 长按触发阈值（ms）：取原 txt 1000 / epub 600 中值，体验均衡 */
  LONG_PRESS_MS: 800,
  /** 滑动最小水平位移（px） */
  SWIPE_MIN_DISTANCE: 50,
  /** 滑动水平位移需 > 垂直位移 * 该倍数，才判定为横向滑动 */
  SWIPE_MAX_VERTICAL_RATIO: 1.5,
  /** 滑动最大允许耗时（ms），超过视为拖动而非滑动 */
  SWIPE_MAX_DURATION: 500,
  /** 长按容忍的最大位移（px）：超过则判定为滚动/滑动，取消长按 */
  LONG_PRESS_MOVE_TOLERANCE: 10,
} as const;

export interface GestureHandlers {
  /** 左右滑动：dir='left' 向左滑（下一页），dir='right' 向右滑（上一页） */
  onSwipe?: (dir: 'left' | 'right') => void;
  /** 长按（≥LONG_PRESS_MS 且未移动） */
  onLongPress?: () => void;
  /** 点击（短按、无位移、未触发长按） */
  onTap?: () => void;
}

interface PointerState {
  x: number;
  y: number;
  time: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressFired: boolean;
  moved: boolean;
  active: boolean;
}

/**
 * 创建手势识别器。返回 attach 方法，供不同挂载点复用同一套识别逻辑。
 */
export function createGestureDetector(handlers: GestureHandlers) {
  const handlersRef = { current: handlers };
  handlersRef.current = handlers;

  const state: PointerState = {
    x: 0, y: 0, time: 0,
    longPressTimer: null,
    longPressFired: false,
    moved: false,
    active: false,
  };

  const clearLongPress = () => {
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
  };

  const start = (clientX: number, clientY: number) => {
    state.x = clientX;
    state.y = clientY;
    state.time = Date.now();
    state.longPressFired = false;
    state.moved = false;
    state.active = true;
    clearLongPress();
    state.longPressTimer = setTimeout(() => {
      if (!state.active || state.moved) return;
      state.longPressFired = true;
      handlersRef.current.onLongPress?.();
    }, GESTURE_CONFIG.LONG_PRESS_MS);
  };

  const move = (clientX: number, clientY: number) => {
    if (!state.active) return;
    const dx = Math.abs(clientX - state.x);
    const dy = Math.abs(clientY - state.y);
    if (dx > GESTURE_CONFIG.LONG_PRESS_MOVE_TOLERANCE || dy > GESTURE_CONFIG.LONG_PRESS_MOVE_TOLERANCE) {
      state.moved = true;
      clearLongPress(); // 移动即取消长按（可能是滚动/滑动）
    }
  };

  const end = (clientX: number, clientY: number) => {
    if (!state.active) return;
    state.active = false;
    clearLongPress();
    const dx = clientX - state.x;
    const dy = clientY - state.y;
    const dt = Date.now() - state.time;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // 已触发长按 → 本次手势结束，不再触发 click/tap（由调用方处理 preventDefault 更佳）
    if (state.longPressFired) return;

    // 横向滑动翻页判定
    if (
      absDx > GESTURE_CONFIG.SWIPE_MIN_DISTANCE &&
      absDx > absDy * GESTURE_CONFIG.SWIPE_MAX_VERTICAL_RATIO &&
      dt < GESTURE_CONFIG.SWIPE_MAX_DURATION
    ) {
      handlersRef.current.onSwipe?.(dx < 0 ? 'left' : 'right');
      return;
    }

    // 点击（无显著位移、未触发长按）
    if (absDx < GESTURE_CONFIG.LONG_PRESS_MOVE_TOLERANCE && absDy < GESTURE_CONFIG.LONG_PRESS_MOVE_TOLERANCE) {
      handlersRef.current.onTap?.();
    }
  };

  // ── 外层 DOM 挂载 ──
  const attachToElement = (el: HTMLElement) => {
    const onTs = (e: TouchEvent) => { const t = e.touches[0]; if (t) start(t.clientX, t.clientY); };
    const onTm = (e: TouchEvent) => { const t = e.touches[0]; if (t) move(t.clientX, t.clientY); };
    const onTe = (e: TouchEvent) => { const t = e.changedTouches[0]; if (t) end(t.clientX, t.clientY); };
    const onMd = (e: MouseEvent) => start(e.clientX, e.clientY);
    const onMm = (e: MouseEvent) => move(e.clientX, e.clientY);
    const onMu = (e: MouseEvent) => end(e.clientX, e.clientY);
    const onMl = () => { state.active = false; clearLongPress(); };
    el.addEventListener('touchstart', onTs, { passive: true });
    el.addEventListener('touchmove', onTm, { passive: true });
    el.addEventListener('touchend', onTe, { passive: true });
    el.addEventListener('mousedown', onMd);
    el.addEventListener('mousemove', onMm);
    el.addEventListener('mouseup', onMu);
    el.addEventListener('mouseleave', onMl);
    return () => {
      el.removeEventListener('touchstart', onTs);
      el.removeEventListener('touchmove', onTm);
      el.removeEventListener('touchend', onTe);
      el.removeEventListener('mousedown', onMd);
      el.removeEventListener('mousemove', onMm);
      el.removeEventListener('mouseup', onMu);
      el.removeEventListener('mouseleave', onMl);
      clearLongPress();
    };
  };

  // ── epub iframe 挂载：在 iframe document 上注入，解决外层 touch 进不去 iframe 的根因 ──
  const attachToEpubContents = (contents: { document: Document } | Array<{ document: Document }>) => {
    const list = Array.isArray(contents) ? contents : [contents];
    const cleanups: Array<() => void> = [];
    for (const c of list) {
      const doc = c.document;
      if (!doc) continue;
      const onTs = (e: Event) => { const t = (e as TouchEvent).touches[0]; if (t) start(t.clientX, t.clientY); };
      const onTm = (e: Event) => { const t = (e as TouchEvent).touches[0]; if (t) move(t.clientX, t.clientY); };
      const onTe = (e: Event) => { const t = (e as TouchEvent).changedTouches[0]; if (t) end(t.clientX, t.clientY); };
      const onMd = (e: Event) => { const me = e as MouseEvent; start(me.clientX, me.clientY); };
      const onMm = (e: Event) => { const me = e as MouseEvent; move(me.clientX, me.clientY); };
      const onMu = (e: Event) => { const me = e as MouseEvent; end(me.clientX, me.clientY); };
      const onMl = () => { state.active = false; clearLongPress(); };
      doc.addEventListener('touchstart', onTs, { passive: true });
      doc.addEventListener('touchmove', onTm, { passive: true });
      doc.addEventListener('touchend', onTe, { passive: true });
      doc.addEventListener('mousedown', onMd);
      doc.addEventListener('mousemove', onMm);
      doc.addEventListener('mouseup', onMu);
      doc.addEventListener('mouseleave', onMl);
      cleanups.push(() => {
        doc.removeEventListener('touchstart', onTs);
        doc.removeEventListener('touchmove', onTm);
        doc.removeEventListener('touchend', onTe);
        doc.removeEventListener('mousedown', onMd);
        doc.removeEventListener('mousemove', onMm);
        doc.removeEventListener('mouseup', onMu);
        doc.removeEventListener('mouseleave', onMl);
      });
    }
    return () => { cleanups.forEach((fn) => fn()); clearLongPress(); };
  };

  return { attachToElement, attachToEpubContents, destroy: clearLongPress };
}

/**
 * React Hook 包装：传入手势回调，返回 attach 方法供组件在 ref/effect 中调用。
 */
export function useGesture(handlers: GestureHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const detectorRef = useRef<ReturnType<typeof createGestureDetector> | null>(null);
  if (!detectorRef.current) {
    detectorRef.current = createGestureDetector({
      onSwipe: (d) => handlersRef.current.onSwipe?.(d),
      onLongPress: () => handlersRef.current.onLongPress?.(),
      onTap: () => handlersRef.current.onTap?.(),
    });
  }
  const attachToElement = useCallback((el: HTMLElement) => detectorRef.current!.attachToElement(el), []);
  const attachToEpubContents = useCallback(
    (contents: { document: Document } | Array<{ document: Document }>) =>
      detectorRef.current!.attachToEpubContents(contents),
    [],
  );
  return { attachToElement, attachToEpubContents };
}
