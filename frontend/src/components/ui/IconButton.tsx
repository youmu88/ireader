import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type IconButtonVariant = 'subtle' | 'primary' | 'ghost' | 'danger';
export type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体，默认 subtle */
  variant?: IconButtonVariant;
  /** 尺寸，默认 sm */
  size?: IconButtonSize;
  /** 无障碍标签（纯图标按钮必填） */
  'aria-label'?: string;
  children: ReactNode;
}

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  subtle: 'bg-ios-bg-alt text-ios-text-secondary hover:bg-ios-border active:scale-90',
  primary: 'bg-ios-primary text-white hover:bg-ios-primary-hover active:scale-90',
  ghost: 'bg-transparent text-ios-text-muted hover:bg-ios-bg-alt',
  danger: 'bg-ios-danger text-white hover:bg-ios-danger-hover active:scale-90',
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  xs: 'w-6 h-6 rounded-full text-xs',
  sm: 'w-9 h-9 rounded-full text-sm',
  md: 'w-10 h-10 rounded-full text-sm',
  lg: 'w-11 h-11 rounded-full',
  xl: 'w-12 h-12 rounded-full text-[10px]',
};

/**
 * 圆形图标按钮 — 用于播放器控件、导航箭头、缓存操作等纯图标场景。
 * 全部样式走 design tokens，自动适配 dark 主题。
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    variant = 'subtle',
    size = 'sm',
    disabled,
    className = '',
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={`inline-flex items-center justify-center shrink-0 select-none transition-all duration-200 tap-icon disabled:opacity-40 disabled:cursor-not-allowed ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
});
