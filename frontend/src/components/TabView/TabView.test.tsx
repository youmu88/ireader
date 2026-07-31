import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabView } from './TabView';

describe('TabView 横向滑动页签容器', () => {

  it('renders active content', () => {
    render(
      <TabView activeIndex={0} onChange={vi.fn()}>
        <div>A</div><div>B</div><div>C</div>
      </TabView>
    );
    expect(screen.getByText('A')).toBeDefined();
  });

  it('navigates forward on left swipe', () => {
    const onChange = vi.fn();
    render(
      <TabView activeIndex={0} onChange={onChange}>
        <div>A</div><div>B</div><div>C</div>
      </TabView>
    );
    // 向左滑 → 下一个
    const el = screen.getByText('A').parentElement!;
    fireEvent.touchStart(el, { touches: [{ clientX: 300, clientY: 0 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 60, clientY: 0 }] });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('navigates backward on right swipe', () => {
    const onChange = vi.fn();
    render(
      <TabView activeIndex={1} onChange={onChange}>
        <div>A</div><div>B</div><div>C</div>
      </TabView>
    );
    const el = screen.getByText('B').parentElement!;
    fireEvent.touchStart(el, { touches: [{ clientX: 60, clientY: 0 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 300, clientY: 0 }] });
    expect(onChange).toHaveBeenCalledWith(0);
  });

  it('does not go beyond first tab', () => {
    const onChange = vi.fn();
    render(
      <TabView activeIndex={0} onChange={onChange}>
        <div>A</div><div>B</div><div>C</div>
      </TabView>
    );
    const el = screen.getByText('A').parentElement!;
    fireEvent.touchStart(el, { touches: [{ clientX: 60, clientY: 0 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 300, clientY: 0 }] });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores vertical swipes', () => {
    const onChange = vi.fn();
    render(
      <TabView activeIndex={0} onChange={onChange}>
        <div>A</div><div>B</div>
      </TabView>
    );
    const el = screen.getByText('A').parentElement!;
    fireEvent.touchStart(el, { touches: [{ clientX: 150, clientY: 150 }] });
    fireEvent.touchEnd(el, { changedTouches: [{ clientX: 150, clientY: 500 }] });
    expect(onChange).not.toHaveBeenCalled();
  });
});
