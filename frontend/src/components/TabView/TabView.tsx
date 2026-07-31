import { useRef, type ReactNode } from 'react';

export interface TabViewProps {
  /** 当前激活页索引 */
  activeIndex: number;
  /** 切换回调（传入目标页索引） */
  onChange: (index: number) => void;
  children: ReactNode[];
  /** 触发手势的最小水平位移 */
  threshold?: number;
}

const SWIPE_THRESHOLD = 60;

/** iOS 原生横向滑动页签容器：支持左右滑动手势切换，垂直位移被忽略 */
export function TabView({ activeIndex, onChange, children, threshold = SWIPE_THRESHOLD }: TabViewProps) {
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const count = children.length;

  const handleStart = (clientX: number, clientY: number) => {
    startRef.current = { x: clientX, y: clientY };
  };

  const handleEnd = (clientX: number, clientY: number) => {
    if (!startRef.current) return;
    const { x, y } = startRef.current;
    startRef.current = null;
    const dx = clientX - x;
    const dy = clientY - y;
    // 垂直滑动优先 → 忽略
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < threshold) return;
    // 向左滑 dx<0 → 下一个；向右滑 dx>0 → 上一个
    const next = dx < 0 ? activeIndex + 1 : activeIndex - 1;
    if (next >= 0 && next < count && next !== activeIndex) {
      onChange(next);
    }
  };

  return (
    <div
      className="tab-view h-full overflow-hidden"
      onTouchStart={(e) => {
        const t = e.touches?.[0];
        if (t) handleStart(t.clientX, t.clientY);
      }}
      onTouchEnd={(e) => {
        const t = e.changedTouches?.[0];
        if (t) handleEnd(t.clientX, t.clientY);
      }}
      onPointerDown={(e) => { if (e.pointerType === 'touch') handleStart(e.clientX, e.clientY); }}
      onPointerUp={(e) => { if (e.pointerType === 'touch') handleEnd(e.clientX, e.clientY); }}
    >
      {children[activeIndex] ?? null}
    </div>
  );
}

export default TabView;
