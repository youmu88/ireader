import { describe, expect, it, vi } from 'vitest';
import { InteractionController, SWIPE_CONFIG } from './InteractionController';

const p = (x: number, y: number, time: number) => ({ x, y, time });

describe('InteractionController', () => {
  it('识别达到距离阈值的左右滑动', () => {
    const navigate = vi.fn();
    const controller = new InteractionController({ navigate });
    controller.start(p(300, 200, 0));
    controller.move(p(240, 203, 100));
    controller.end(p(220, 205, 160));
    expect(navigate).toHaveBeenCalledWith('next');

    controller.start(p(200, 200, 200));
    controller.end(p(280, 202, 360));
    expect(navigate).toHaveBeenLastCalledWith('previous');
  });

  it('快速短甩可翻页，慢速短拖不翻页', () => {
    const navigate = vi.fn();
    const controller = new InteractionController({ navigate });
    controller.start(p(300, 200, 0));
    controller.end(p(260, 202, 60));
    expect(navigate).toHaveBeenCalledWith('next');

    navigate.mockClear();
    controller.start(p(300, 200, 0));
    controller.end(p(260, 202, 500));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('纵向意图、多指取消后的结束都不翻页', () => {
    const navigate = vi.fn();
    const controller = new InteractionController({ navigate });
    controller.start(p(200, 200, 0));
    controller.move(p(230, 320, 100));
    controller.end(p(240, 400, 200));
    expect(navigate).not.toHaveBeenCalled();

    controller.start(p(300, 200, 0));
    controller.cancel();
    controller.end(p(200, 200, 100));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('选择模式等禁用状态下不跟踪、不翻页', () => {
    let enabled = false;
    const navigate = vi.fn();
    const controller = new InteractionController({ navigate, enabled: () => enabled });
    controller.start(p(300, 200, 0));
    controller.end(p(200, 200, 100));
    expect(navigate).not.toHaveBeenCalled();

    enabled = true;
    controller.start(p(300, 200, 200));
    enabled = false;
    controller.end(p(200, 200, 300));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('无移动时触发 tap，轻微移动不误触 swipe', () => {
    const tap = vi.fn();
    const navigate = vi.fn();
    const controller = new InteractionController({ navigate, tap });
    controller.start(p(100, 100, 0));
    controller.end(p(102, 101, 100));
    expect(tap).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('阈值集中且方向比值大于 1', () => {
    expect(SWIPE_CONFIG.minDistance).toBe(56);
    expect(SWIPE_CONFIG.minVelocity).toBe(0.45);
    expect(SWIPE_CONFIG.horizontalRatio).toBeGreaterThan(1);
  });
});
