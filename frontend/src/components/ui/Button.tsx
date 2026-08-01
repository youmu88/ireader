import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'success' | 'accent' | 'text' | 'pill' | 'row';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 视觉变体，默认 primary */
  variant?: ButtonVariant;
  /** 尺寸，默认 md */
  size?: ButtonSize;
  /** 加载中：显示 spinner 并禁用交互 */
  loading?: boolean;
  /** 擑满父容器宽度 */
  fullWidth?: boolean;
  /** 激活态（pill / row 变体专用，切换为 primary-subtle 高亮） */
  active?: boolean;
  /** 内容水平对齐，默认 center；row 等全宽场景用 start；between 用于两端对齐 */
  justify?: 'center' | 'start' | 'between';
  children?: ReactNode;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-ios-primary text-white hover:bg-ios-primary-hover active:bg-ios-primary-active shadow-ios-sm ripple-btn',
  secondary: 'bg-ios-bg-alt text-ios-text hover:bg-ios-border',
  ghost: 'bg-transparent text-ios-primary hover:bg-ios-primary-subtle',
  danger: 'bg-ios-danger text-white hover:bg-ios-danger-hover active:bg-ios-danger-hover shadow-ios-sm ripple-btn',
  warning: 'bg-ios-warning text-white hover:bg-ios-warning-hover active:bg-ios-warning-hover shadow-ios-sm ripple-btn',
  success: 'bg-ios-success text-white hover:bg-ios-success-hover active:bg-ios-success-hover shadow-ios-sm ripple-btn',
  accent: 'bg-ios-accent-1 text-white hover:bg-ios-accent-1-hover active:bg-ios-accent-1-hover shadow-ios-sm ripple-btn',
  text: 'bg-transparent text-ios-primary hover:bg-ios-primary-subtle',
  pill: 'bg-ios-bg-alt text-ios-text-secondary hover:bg-ios-border dark:hover:bg-ios-bg-elevated rounded-full',
  row: 'bg-transparent text-ios-text-secondary hover:bg-ios-bg-alt',
};

/** pill / row 变体的激活态高亮（active 属性触发） */
const ACTIVE_CLASSES: Partial<Record<ButtonVariant, string>> = {
  pill: 'bg-ios-primary-subtle text-ios-primary hover:bg-ios-primary-subtle',
  row: 'bg-ios-primary-subtle text-ios-primary hover:bg-ios-primary-subtle',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'h-7 px-2.5 text-xs gap-1 rounded-full',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-ios-md',
  md: 'h-10 px-4 text-[15px] gap-2 rounded-ios-lg',
  lg: 'h-12 px-5 text-[17px] gap-2 rounded-ios-xl',
};

/**
 * 统一按钮组件 — 全部样式走 design tokens，自动适配 dark 主题。
 * 继承 index.css 全局按压反馈（scale + transition）。
 * 变体：primary / secondary / ghost / danger / warning / success / accent / text / pill / row
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    active = false,
    justify = 'center',
    disabled,
    className = '',
    children,
    ...rest
  },
  ref,
) {
  const variantCls = (active && ACTIVE_CLASSES[variant]) || VARIANT_CLASSES[variant];
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center ${justify === 'start' ? 'justify-start' : justify === 'between' ? 'justify-between' : 'justify-center'} font-medium select-none whitespace-nowrap ${variantCls} ${SIZE_CLASSES[size]}${fullWidth ? ' w-full' : ''}${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {loading && (
        <svg
          data-testid="btn-spinner"
          className="animate-spin"
          width="1em"
          height="1em"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
          <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
      {children}
    </button>
  );
});
