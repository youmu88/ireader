/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // iOS 风格颜色体系
      colors: {
        ios: {
          primary: 'var(--color-primary)',
          'primary-hover': 'var(--color-primary-hover)',
          'primary-active': 'var(--color-primary-active)',
          'primary-muted': 'var(--color-primary-muted)',
          'primary-subtle': 'var(--color-primary-subtle)',
          bg: 'var(--color-bg)',
          'bg-alt': 'var(--color-bg-alt)',
          'bg-card': 'var(--color-bg-card)',
          text: 'var(--color-text)',
          'text-secondary': 'var(--color-text-secondary)',
          'text-muted': 'var(--color-text-muted)',
          border: 'var(--color-border)',
          'border-hover': 'var(--color-border-hover)',
          'accent-1': 'var(--color-accent-1)',
          'accent-1-hover': 'var(--color-accent-1-hover)',
          'accent-2': 'var(--color-accent-2)',
          success: 'var(--color-success)',
          'success-hover': 'var(--color-success-hover)',
          'success-subtle': 'var(--color-success-subtle)',
          warning: 'var(--color-warning)',
          'warning-hover': 'var(--color-warning-hover)',
          'warning-subtle': 'var(--color-warning-subtle)',
          danger: 'var(--color-danger)',
          'danger-hover': 'var(--color-danger-hover)',
          'danger-subtle': 'var(--color-danger-subtle)',
          overlay: 'var(--color-overlay)',
        },
      },
      // Design tokens z-index 层级
      zIndex: {
        dropdown: 'var(--z-dropdown)',
        sticky: 'var(--z-sticky)',
        drawer: 'var(--z-drawer)',
        modal: 'var(--z-modal)',
        toast: 'var(--z-toast)',
      },
      // iOS 风格毛玻璃
      backdropBlur: {
        xs: '2px',
        sm: '4px',
        md: '8px',
        lg: '16px',
        xl: '24px',
        '2xl': '40px',
        '3xl': '64px',
      },
      // iOS 风格阴影
      boxShadow: {
        'ios-xs': '0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.02)',
        'ios-sm': '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.03)',
        'ios-md': '0 2px 8px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)',
        'ios-lg': '0 4px 16px rgba(0,0,0,0.10), 0 2px 6px rgba(0,0,0,0.04)',
        'ios-xl': '0 8px 32px rgba(0,0,0,0.12), 0 4px 12px rgba(0,0,0,0.05)',
        'ios-card': '0 1px 3px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)',
        'dark-ios-xs': '0 1px 2px rgba(0,0,0,0.2)',
        'dark-ios-sm': '0 1px 3px rgba(0,0,0,0.3)',
        'dark-ios-md': '0 2px 8px rgba(0,0,0,0.4)',
        'dark-ios-lg': '0 4px 16px rgba(0,0,0,0.5)',
        'dark-ios-xl': '0 8px 32px rgba(0,0,0,0.6)',
      },
      // iOS 风格圆角
      borderRadius: {
        'ios-sm': '8px',
        'ios-md': '10px',
        'ios-lg': '12px',
        'ios-xl': '16px',
        'ios-2xl': '20px',
        'ios-full': '9999px',
      },
      // iOS 风格间距
      spacing: {
        'ios-xs': '4px',
        'ios-sm': '8px',
        'ios-md': '12px',
        'ios-lg': '16px',
        'ios-xl': '20px',
        'ios-2xl': '24px',
        'ios-3xl': '32px',
      },
      // SF Pro 字体权重
      fontWeight: {
        'sf-regular': '400',
        'sf-medium': '500',
        'sf-semibold': '600',
        'sf-bold': '700',
        'sf-heavy': '800',
      },
      keyframes: {
        'tap-ripple': {
          '0%': { transform: 'scale(0)', opacity: '0.6' },
          '100%': { transform: 'scale(4)', opacity: '0' },
        },
        'slide-up': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'slide-down': {
          '0%': { transform: 'translateY(-8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'pop-in': {
          '0%': { transform: 'scale(0.9)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'scale-in': {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        'spring-up': {
          '0%': { transform: 'translateY(12px) scale(0.96)', opacity: '0' },
          '60%': { transform: 'translateY(-2px) scale(1.01)', opacity: '1' },
          '100%': { transform: 'translateY(0) scale(1)', opacity: '1' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.7' },
        },
        'sheet-up': {
          '0%': { transform: 'translateY(100%)' },
          '100%': { transform: 'translateY(0)' },
        },
        'ios-spin': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
      },
      animation: {
        'slide-up': 'slide-up 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'slide-down': 'slide-down 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'fade-in': 'fade-in 0.2s ease-out',
        'pop-in': 'pop-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'scale-in': 'scale-in 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'spring-up': 'spring-up 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'pulse-soft': 'pulse-soft 2s ease-in-out infinite',
        'sheet-up': 'sheet-up 0.35s cubic-bezier(0.34, 1.56, 0.64, 1)',
        'ios-spin': 'ios-spin 0.8s linear infinite',
      },
    },
  },
  plugins: [],
};
