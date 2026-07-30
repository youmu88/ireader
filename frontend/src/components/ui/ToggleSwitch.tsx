import { forwardRef, type ButtonHTMLAttributes } from 'react';

export interface ToggleSwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** 开关状态 */
  checked: boolean;
  /** 状态变更回调，参数为新状态 */
  onChange: (checked: boolean) => void;
  /** 无障碍标签（必填） */
  'aria-label': string;
}

/**
 * iOS 风格开关组件 — 48×28 圆角轨道 + 22px 滑块。
 * 全部样式走 design tokens，自动适配 dark 主题。
 */
export const ToggleSwitch = forwardRef<HTMLButtonElement, ToggleSwitchProps>(function ToggleSwitch(
  { checked, onChange, disabled, className = '', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative w-[48px] h-[28px] rounded-full transition-all duration-200 shrink-0 select-none tap-icon disabled:opacity-40 disabled:cursor-not-allowed ${checked ? '' : 'opacity-50'}${className ? ` ${className}` : ''}`}
      style={{ background: checked ? 'var(--color-primary)' : 'var(--color-border)' }}
      {...rest}
    >
      <div
        className={`absolute top-[3px] w-[22px] h-[22px] rounded-full bg-white shadow-sm transition-all duration-200 ${checked ? 'left-[23px]' : 'left-[3px]'}`}
      />
    </button>
  );
});
