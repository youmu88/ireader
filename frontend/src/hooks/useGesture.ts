import { useCallback, useEffect, useRef } from 'react';

/** 阅读器手势的唯一配置来源。 */
export const GESTURE_CONFIG = {
  SWIPE_MIN_DISTANCE: 50,
  SWIPE_MAX_VERTICAL_RATIO: 1.5,
  SWIPE_MAX_DURATION: 500,
  TAP_MOVE_TOLERANCE: 10,
} as const;

export interface GestureHandlers {
  onSwipe?: (direction: 'left' | 'right') => void;
  onTap?: () => void;
}

interface PointerState {
  active: boolean;
  input: 'touch' | 'mouse' | null;
  startX: number;
  startY: number;
  startedAt: number;
  moved: boolean;
}

type GestureTarget = HTMLElement | Document;

function getSelectedText(doc: Document): string {
  try {
    return doc.defaultView?.getSelection()?.toString().trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * 与 React 无关的手势状态机，普通 DOM 和 EPUB iframe 共用同一行为。
 * 监听器全部是被动监听，不阻止浏览器原生文字选择。
 */
export function createGestureDetector(handlers: GestureHandlers) {
  const handlersRef = { current: handlers };
  const mountedTargets = new Map<GestureTarget, () => void>();
  const state: PointerState = {
    active: false,
    input: null,
    startX: 0,
    startY: 0,
    startedAt: 0,
    moved: false,
  };
  let ignoreMouseUntil = 0;

  const cancel = () => {
    state.active = false;
    state.input = null;
  };

  const start = (clientX: number, clientY: number, input: 'touch' | 'mouse') => {
    state.active = true;
    state.input = input;
    state.startX = clientX;
    state.startY = clientY;
    state.startedAt = Date.now();
    state.moved = false;
  };

  const move = (clientX: number, clientY: number) => {
    if (!state.active) return;
    const dx = Math.abs(clientX - state.startX);
    const dy = Math.abs(clientY - state.startY);
    if (dx > GESTURE_CONFIG.TAP_MOVE_TOLERANCE || dy > GESTURE_CONFIG.TAP_MOVE_TOLERANCE) {
      state.moved = true;
    }
  };

  const end = (clientX: number, clientY: number, doc: Document) => {
    if (!state.active) return;
    state.active = false;
    state.input = null;

    const dx = clientX - state.startX;
    const dy = clientY - state.startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const duration = Date.now() - state.startedAt;

    if (getSelectedText(doc)) return;

    if (
      absDx >= GESTURE_CONFIG.SWIPE_MIN_DISTANCE &&
      absDx > absDy * GESTURE_CONFIG.SWIPE_MAX_VERTICAL_RATIO &&
      duration <= GESTURE_CONFIG.SWIPE_MAX_DURATION
    ) {
      handlersRef.current.onSwipe?.(dx < 0 ? 'left' : 'right');
      return;
    }

    if (!state.moved) {
      handlersRef.current.onTap?.();
    }
  };

  const attach = (target: GestureTarget, doc: Document) => {
    const existingCleanup = mountedTargets.get(target);
    if (existingCleanup) return existingCleanup;

    const onTouchStart = (event: Event) => {
      const touchEvent = event as TouchEvent;
      if (touchEvent.touches.length !== 1) {
        cancel();
        return;
      }
      const touch = touchEvent.touches[0];
      ignoreMouseUntil = Date.now() + 700;
      start(touch.clientX, touch.clientY, 'touch');
    };
    const onTouchMove = (event: Event) => {
      const touchEvent = event as TouchEvent;
      if (touchEvent.touches.length !== 1) {
        cancel();
        return;
      }
      const touch = touchEvent.touches[0];
      move(touch.clientX, touch.clientY);
    };
    const onTouchEnd = (event: Event) => {
      const touch = (event as TouchEvent).changedTouches[0];
      if (touch) end(touch.clientX, touch.clientY, doc);
      else cancel();
    };
    const onMouseDown = (event: Event) => {
      const mouseEvent = event as MouseEvent;
      if (mouseEvent.button !== 0 || Date.now() < ignoreMouseUntil) return;
      start(mouseEvent.clientX, mouseEvent.clientY, 'mouse');
    };
    const onMouseMove = (event: Event) => {
      if (state.input !== 'mouse') return;
      const mouseEvent = event as MouseEvent;
      move(mouseEvent.clientX, mouseEvent.clientY);
    };
    const onMouseUp = (event: Event) => {
      if (state.input !== 'mouse') return;
      const mouseEvent = event as MouseEvent;
      end(mouseEvent.clientX, mouseEvent.clientY, doc);
    };

    target.addEventListener('touchstart', onTouchStart, { passive: false });
    target.addEventListener('touchmove', onTouchMove, { passive: false });
    target.addEventListener('touchend', onTouchEnd, { passive: false });
    target.addEventListener('touchcancel', cancel, { passive: false });
    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('mousemove', onMouseMove);
    target.addEventListener('mouseup', onMouseUp);
    target.addEventListener('mouseleave', cancel);

    const cleanup = () => {
      target.removeEventListener('touchstart', onTouchStart);
      target.removeEventListener('touchmove', onTouchMove);
      target.removeEventListener('touchend', onTouchEnd);
      target.removeEventListener('touchcancel', cancel);
      target.removeEventListener('mousedown', onMouseDown);
      target.removeEventListener('mousemove', onMouseMove);
      target.removeEventListener('mouseup', onMouseUp);
      target.removeEventListener('mouseleave', cancel);
      if (mountedTargets.get(target) === cleanup) mountedTargets.delete(target);
      cancel();
    };
    mountedTargets.set(target, cleanup);
    return cleanup;
  };

  const attachToElement = (element: HTMLElement) => attach(element, element.ownerDocument);

  const attachToEpubContents = (contents: { document: Document } | Array<{ document: Document }>) => {
    const list = Array.isArray(contents) ? contents : [contents];
    const cleanups = list
      .map((content) => content?.document)
      .filter((doc): doc is Document => Boolean(doc))
      .map((doc) => attach(doc, doc));
    return () => cleanups.forEach((cleanup) => cleanup());
  };

  const destroy = () => {
    Array.from(mountedTargets.values()).forEach((cleanup) => cleanup());
    cancel();
  };

  return { attachToElement, attachToEpubContents, destroy };
}

export function useGesture(handlers: GestureHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const detectorRef = useRef<ReturnType<typeof createGestureDetector> | null>(null);

  if (!detectorRef.current) {
    detectorRef.current = createGestureDetector({
      onSwipe: (direction) => handlersRef.current.onSwipe?.(direction),
      onTap: () => handlersRef.current.onTap?.(),
    });
  }

  useEffect(() => () => detectorRef.current?.destroy(), []);

  const attachToElement = useCallback(
    (element: HTMLElement) => detectorRef.current!.attachToElement(element),
    [],
  );
  const attachToEpubContents = useCallback(
    (contents: { document: Document } | Array<{ document: Document }>) =>
      detectorRef.current!.attachToEpubContents(contents),
    [],
  );

  return { attachToElement, attachToEpubContents };
}
