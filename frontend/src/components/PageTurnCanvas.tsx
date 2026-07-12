/**
 * PageTurnCanvas — Canvas 驱动的翻页动画引擎
 *
 * 架构：
 *   翻页动画期间，创建一个覆盖全屏的 Canvas 层，在上面逐帧渲染
 *   旧页（当前页内容）和新页（目标页内容）的过渡动画。
 *   动画结束 → Canvas 隐藏 → React 切换到新页内容。
 *
 * 渲染原理（CSS 3D 翻页）：
 *   创建两个独立的 DOM 层（旧页 + 新页），通过 JS requestAnimationFrame
 *   精确控制每一帧的 CSS transform，模拟纸质书的 3D 卷页效果。
 *
 *   旧页层：transform-origin: left center，rotateY 从 0° → -90°
 *   新页层：transform-origin: right center，rotateY 从 90° → 0°
 *   配合 backface-visibility: hidden 实现自然的翻页过渡。
 */

import { useEffect, useRef, useCallback, useState } from 'react';

export interface PageTurnSnapshot {
  /** 旧页（当前页）渲染用的 React 节点 */
  currentPage: React.ReactNode;
  /** 新页（目标页）渲染用的 React 节点 */
  nextPage: React.ReactNode;
}

interface PageTurnCanvasProps {
  /** 翻页方向 */
  direction: 'next' | 'prev';
  /** 页面快照数据 */
  snapshot: PageTurnSnapshot;
  /** 动画持续时间（ms） */
  duration?: number;
  /** 动画完成回调 */
  onComplete: () => void;
  /** 自定义缓动函数 */
  easing?: (t: number) => number;
}

/** 默认缓动：ease-in-out 风格 */
const defaultEasing = (t: number): number => {
  // cubic-bezier(0.42, 0, 0.58, 1) — 标准的 ease-in-out
  // 更改为自定义曲线让翻页感觉更自然
  if (t < 0.5) {
    return 2 * t * t * (3 - 2 * t); // 前半段加速
  }
  return 1 - Math.pow(-2 * t + 2, 2) / 2; // 后半段减速
};

export default function PageTurnCanvas({
  direction,
  snapshot,
  duration = 600,
  onComplete,
  easing = defaultEasing,
}: PageTurnCanvasProps) {
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const completedRef = useRef(false);

  const animate = useCallback(
    (timestamp: number) => {
      if (!startTimeRef.current) {
        startTimeRef.current = timestamp;
      }
      const elapsed = timestamp - startTimeRef.current;
      const rawProgress = Math.min(elapsed / duration, 1);
      const easedProgress = easing(rawProgress);

      setProgress(easedProgress);

      if (rawProgress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        // 动画完成
        completedRef.current = true;
        // 短暂延迟确保最后一帧渲染完毕
        setTimeout(() => {
          onComplete();
        }, 50);
      }
    },
    [duration, easing, onComplete]
  );

  useEffect(() => {
    // 使用双层 RAF 确保初始帧布局完成后再开始动画
    const initRaf = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(animate);
    });

    return () => {
      cancelAnimationFrame(initRaf);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [animate]);

  // 计算旧页和新页的 CSS transform
  // 翻到下一页（next）：旧页从左向左翻出，新页从右翻入
  // 翻到上一页（prev）：旧的当前页（即视觉上的"右侧页"）向右翻出
  //
  // 关键洞察：无论 direction 是什么，我们始终有两个层：
  //   - "离开层"（当前可见的页面 → 翻走）
  //   - "进入层"（目标页面 → 翻入）

  // 进入层旋转角度：从 90°（翻入起点）到 0°（正面）
  const enterAngle = (1 - progress) * 90;
  // 离开层旋转角度：从 0°（正面）到 -90°（翻走）
  const leaveAngle = -progress * 90;

  // 透明度：离开层逐渐变透明，进入层逐渐不透明
  const leaveOpacity = 1 - progress * 0.4;
  const enterOpacity = 0.6 + progress * 0.4;

  // 离开层的 origin 和方向取决于翻页方向
  const leaveOrigin = direction === 'next' ? 'left center' : 'right center';
  const enterOrigin = direction === 'next' ? 'right center' : 'left center';

  // 对于 prev 方向，角度符号翻转
  const leaveAngleFinal = direction === 'next' ? leaveAngle : -leaveAngle;
  const enterAngleFinal = direction === 'next' ? enterAngle : -enterAngle;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        perspective: '1500px',
        perspectiveOrigin: 'center center',
        overflow: 'hidden',
        background: 'var(--color-bg)',
      }}
    >
      {/* 阴影层：书脊折痕效果 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: '60px',
          left: direction === 'next'
            ? `${(1 - progress) * 60}%`
            : `${progress * 40}%`,
          background: direction === 'next'
            ? 'linear-gradient(to right, rgba(0,0,0,0.15), transparent)'
            : 'linear-gradient(to left, rgba(0,0,0,0.15), transparent)',
          zIndex: 3,
          pointerEvents: 'none',
          transition: 'none',
          transform: direction === 'next'
            ? `translateX(-${(1 - progress) * 30}px)`
            : `translateX(${(1 - progress) * 30}px)`,
        }}
      />

      {/* 进入层（新页内容） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backfaceVisibility: 'hidden',
          transformOrigin: enterOrigin,
          transform: `rotateY(${enterAngleFinal}deg)`,
          opacity: enterOpacity,
          zIndex: 1,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
          {snapshot.nextPage}
        </div>
      </div>

      {/* 离开层（旧页内容） */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backfaceVisibility: 'hidden',
          transformOrigin: leaveOrigin,
          transform: `rotateY(${leaveAngleFinal}deg)`,
          opacity: leaveOpacity,
          zIndex: 2,
          overflow: 'hidden',
        }}
      >
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
          {snapshot.currentPage}
        </div>
      </div>
    </div>
  );
}
