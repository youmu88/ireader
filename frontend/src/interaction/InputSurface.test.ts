import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractionController } from './InteractionController';
import { InputSurface } from './InputSurface';

function touchEvent(
  type: string,
  x: number,
  y: number,
  options: { cancelable?: boolean; end?: boolean } = {},
): Event {
  const event = new Event(type, { bubbles: true, cancelable: options.cancelable ?? true });
  const touch = { clientX: x, clientY: y };
  Object.defineProperty(event, 'touches', { value: options.end ? [] : [touch] });
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  return event;
}

describe('InputSurface', () => {
  afterEach(() => document.getSelection()?.removeAllRanges());

  it('只在确认横滑后阻止浏览器默认行为并触发翻页', () => {
    const navigate = vi.fn();
    const element = document.createElement('div');
    document.body.appendChild(element);
    const surface = new InputSurface(element, new InteractionController({ navigate }));
    surface.mount();

    const start = touchEvent('touchstart', 300, 100);
    const move = touchEvent('touchmove', 220, 103);
    const end = touchEvent('touchend', 180, 104, { end: true });
    element.dispatchEvent(start);
    element.dispatchEvent(move);
    element.dispatchEvent(end);

    expect(start.defaultPrevented).toBe(false);
    expect(move.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith('next');
    surface.destroy();
    element.remove();
  });

  it('已有文字选区时不阻止默认行为且不翻页', () => {
    const navigate = vi.fn();
    const element = document.createElement('div');
    element.textContent = '可以选择和复制的正文';
    document.body.appendChild(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    document.getSelection()?.addRange(range);
    const surface = new InputSurface(element, new InteractionController({ navigate }));
    surface.mount();

    const move = touchEvent('touchmove', 220, 100);
    element.dispatchEvent(touchEvent('touchstart', 300, 100));
    element.dispatchEvent(move);
    element.dispatchEvent(touchEvent('touchend', 180, 100, { end: true }));

    expect(move.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    surface.destroy();
    element.remove();
  });
});
