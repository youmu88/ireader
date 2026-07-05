/**
 * Progressive Components — 组件级渐进增强容器
 *
 * 根据设备兼容性信息（useTheme().compatibility）在组件层面做条件渲染：
 * - 低性能设备：纯色/简化 UI，禁用毛玻璃、弹性动效、复杂阴影
 * - 高性能设备：全量现代特性，毛玻璃、弹性动画、丰富阴影
 *
 * 与 CSS 层（@supports + .low-perf）形成双层防护，确保：
 * 1. CSS 层兜底（当 JS 未加载或失败时仍能降级）
 * 2. 组件层精确控制（避免低性能设备渲染不必要的 DOM/CSS 计算）
 *
 * 使用方式：
 * ```tsx
 * import { SafeGlass, SafeMotion, ProgressiveCard } from '../services/progressiveComponents';
 *
 * <SafeGlass compatibility={compatibility}>
 *   <YourGlassContent />
 * </SafeGlass>
 * ```
 */

import { type ReactNode } from 'react';
import { type CompatibilityInfo } from './compatibilityService';

// ── SafeGlass：兼容毛玻璃容器 ──

interface SafeGlassProps {
  children: ReactNode;
  compatibility: CompatibilityInfo;
  /** 低性能设备时使用的备选 className（不含 glass 相关类） */
  fallbackClassName?: string;
  /** 额外 className（始终添加） */
  className?: string;
}

/**
 * 毛玻璃兼容容器。
 * - 高性能设备：正常渲染 glass 效果
 * - 低性能设备：使用纯色背景替代毛玻璃，避免 GPU 开销
 *
 * 与 CSS @supports 降级的区别：
 * - CSS 降级是渲染后的兜底（浏览器不支持 backdrop-filter 时生效）
 * - 组件级降级是渲染前的控制（低性能设备直接渲染纯色，减少 GPU 合成层）
 */
export function SafeGlass({ children, compatibility, fallbackClassName = '', className = '' }: SafeGlassProps) {
  if (compatibility.disableGlass) {
    return (
      <div className={`bg-[var(--color-bg-card)] ${fallbackClassName} ${className}`}>
        {children}
      </div>
    );
  }
  return <div className={`glass ${className}`}>{children}</div>;
}

// ── SafeMotion：兼容动效包装器 ──

interface SafeMotionProps {
  children: ReactNode;
  compatibility: CompatibilityInfo;
  /** 默认动效类（高性能设备使用） */
  motionClass?: string;
  /** 备选类（低性能设备使用） */
  stillClass?: string;
}

/**
 * 动效兼容包装器。
 * - 高性能设备：保留动画/过渡类
 * - 低性能设备或 prefers-reduced-motion：替换为静态类
 *
 * 示例：
 * ```tsx
 * <SafeMotion compatibility={compatibility} motionClass="animate-fade-in" stillClass="opacity-100">
 *   <YourAnimatedContent />
 * </SafeMotion>
 * ```
 */
export function SafeMotion({ children, compatibility, motionClass = '', stillClass = '' }: SafeMotionProps) {
  const effectiveClass = compatibility.reducedMotion ? stillClass : motionClass;
  return <div className={effectiveClass}>{children}</div>;
}

// ── ProgressiveCard：兼容卡片容器 ──

interface ProgressiveCardProps {
  children: ReactNode;
  compatibility: CompatibilityInfo;
  className?: string;
  /** 是否启用 hover 缩放效果 */
  enableHover?: boolean;
}

/**
 * 渐进增强卡片容器。
 * - 高性能设备：阴影 + 可选 hover 缩放效果
 * - 低性能设备：无阴影 + 禁用 hover 缩放，减少重绘
 */
export function ProgressiveCard({ children, compatibility, className = '', enableHover = true }: ProgressiveCardProps) {
  const isLowPerf = compatibility.tier === 'low';

  const baseStyle: React.CSSProperties = {
    background: 'var(--color-bg-card)',
    borderRadius: '16px',
    overflow: 'hidden',
  };

  // 低性能设备：无阴影，无动效
  if (isLowPerf) {
    return (
      <div style={baseStyle} className={className}>
        {children}
      </div>
    );
  }

  // 高性能设备（含中性能）：iOS 风格阴影 + hover 效果
  const shadowStyle: React.CSSProperties = enableHover
    ? {
        ...baseStyle,
        boxShadow: '0 2px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        transition: 'transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease-out',
      }
    : {
        ...baseStyle,
        boxShadow: '0 2px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
      };

  return (
    <div
      style={shadowStyle}
      className={`tap-row ${className}`}
      onMouseEnter={enableHover ? (e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)';
      } : undefined}
      onMouseLeave={enableHover ? (e) => {
        (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
        (e.currentTarget as HTMLElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)';
      } : undefined}
    >
      {children}
    </div>
  );
}

// ── ProgressiveTappable：兼容按压反馈包装器 ──

interface ProgressiveTappableProps {
  children: ReactNode;
  compatibility: CompatibilityInfo;
  onClick?: () => void;
  className?: string;
  role?: string;
  tabIndex?: number;
  ariaLabel?: string;
}

/**
 * 按压反馈兼容包装器。
 * - 高性能设备：iOS 风格弹性按压缩放（scale 0.96）
 * - 低性能设备：仅透明度变化（无缩放，减少重排）
 */
export function ProgressiveTappable({
  children,
  compatibility,
  onClick,
  className = '',
  role,
  tabIndex,
  ariaLabel,
}: ProgressiveTappableProps) {
  const isLowPerf = compatibility.tier === 'low';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      role={role || 'button'}
      tabIndex={tabIndex ?? 0}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={`${isLowPerf ? 'tap-dim' : 'tap-icon'} ${className}`}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </div>
  );
}
