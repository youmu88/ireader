import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createGestureDetector, GESTURE_CONFIG } from './useGesture';

// 模拟 Touch 对象
function makeTouch(clientX: number, clientY: number): Touch {
  return { clientX, clientY } as unknown as Touch;
}

describe('createGestureDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('左滑（dx<-50, 水平>垂直1.5倍, <500ms）触发 onSwipe("left")', () => {
    const onSwipe = vi.fn();
    const d = createGestureDetector({ onSwipe });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(300, 200)] }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(200, 205)] }));
    expect(onSwipe).toHaveBeenCalledWith('left');
  });

  it('右滑（dx>50）触发 onSwipe("right")', () => {
    const onSwipe = vi.fn();
    const d = createGestureDetector({ onSwipe });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(200, 200)] }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(300, 202)] }));
    expect(onSwipe).toHaveBeenCalledWith('right');
  });

  it('垂直滑动不触发翻页（水平<垂直）', () => {
    const onSwipe = vi.fn();
    const d = createGestureDetector({ onSwipe });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(200, 200)] }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(210, 400)] }));
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('长按 ≥ LONG_PRESS_MS 且未移动触发 onLongPress', () => {
    const onLongPress = vi.fn();
    const d = createGestureDetector({ onLongPress });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(200, 200)] }));
    vi.advanceTimersByTime(GESTURE_CONFIG.LONG_PRESS_MS + 10);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('长按期间移动取消长按', () => {
    const onLongPress = vi.fn();
    const d = createGestureDetector({ onLongPress });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(200, 200)] }));
    el.dispatchEvent(new TouchEvent('touchmove', { touches: [makeTouch(220, 220)] }));
    vi.advanceTimersByTime(GESTURE_CONFIG.LONG_PRESS_MS + 10);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('短按未达阈值触发 onTap', () => {
    const onTap = vi.fn();
    const onLongPress = vi.fn();
    const d = createGestureDetector({ onTap, onLongPress });
    const el = document.createElement('div');
    d.attachToElement(el);
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(200, 200)] }));
    vi.advanceTimersByTime(100);
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(201, 200)] }));
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('EPUB iframe 中已有选区时不触发滑动翻页', () => {
    const onSwipe = vi.fn();
    const d = createGestureDetector({ onSwipe });
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const iframeDocument = iframe.contentDocument!;
    vi.spyOn(iframe.contentWindow!, 'getSelection').mockReturnValue({
      toString: () => '可选择的文字',
    } as Selection);

    d.attachToEpubContents({ document: iframeDocument });
    iframeDocument.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(300, 200)] }));
    iframeDocument.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(200, 205)] }));

    expect(onSwipe).not.toHaveBeenCalled();
    iframe.remove();
  });

  it('清理后允许同一 EPUB document 重新挂载', () => {
    const firstSwipe = vi.fn();
    const secondSwipe = vi.fn();
    const iframeDocument = document.implementation.createHTMLDocument('epub');
    const first = createGestureDetector({ onSwipe: firstSwipe });
    const detach = first.attachToEpubContents({ document: iframeDocument });
    detach();

    const second = createGestureDetector({ onSwipe: secondSwipe });
    second.attachToEpubContents({ document: iframeDocument });
    iframeDocument.dispatchEvent(new TouchEvent('touchstart', { touches: [makeTouch(300, 200)] }));
    iframeDocument.dispatchEvent(new TouchEvent('touchend', { changedTouches: [makeTouch(200, 205)] }));

    expect(firstSwipe).not.toHaveBeenCalled();
    expect(secondSwipe).toHaveBeenCalledWith('left');
  });

  it('GESTURE_CONFIG 阈值合理', () => {
    expect(GESTURE_CONFIG.LONG_PRESS_MS).toBe(1000);
    expect(GESTURE_CONFIG.SWIPE_MIN_DISTANCE).toBe(50);
  });
});
