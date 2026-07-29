import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  /** 显示时长 ms，默认按类型：success/info 2500、warning 3000、error 3500 */
  duration?: number;
}

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  leaving: boolean;
}

const DEFAULT_DURATIONS: Record<ToastType, number> = {
  success: 2500,
  info: 2500,
  warning: 3000,
  error: 3500,
};
const MAX_STACK = 4;
const LEAVE_MS = 200;

/* ── 模块级 store：命令式 API 可在 React 组件外调用 ── */
type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

function emit() {
  for (const l of listeners) l([...items]);
}

function dismiss(id: number) {
  if (!items.some((t) => t.id === id && !t.leaving)) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, LEAVE_MS);
}

function push(type: ToastType, message: string, opts?: ToastOptions) {
  const id = nextId++;
  // 堆叠上限：保留最新 MAX_STACK-1 条 + 本条
  items = [...items.filter((t) => !t.leaving).slice(-(MAX_STACK - 1)), { id, type, message, leaving: false }];
  emit();
  setTimeout(() => dismiss(id), opts?.duration ?? DEFAULT_DURATIONS[type]);
}

/** 命令式 Toast API：toast.success('已复制') */
export const toast = {
  success: (message: string, opts?: ToastOptions) => push('success', message, opts),
  error: (message: string, opts?: ToastOptions) => push('error', message, opts),
  info: (message: string, opts?: ToastOptions) => push('info', message, opts),
  warning: (message: string, opts?: ToastOptions) => push('warning', message, opts),
};

/* ── 渲染层 ── */

const TYPE_STYLES: Record<ToastType, string> = {
  success: 'bg-ios-success text-white',
  error: 'bg-ios-danger text-white',
  warning: 'bg-ios-warning text-[hsl(30,45%,14%)]',
  info: 'bg-ios-bg-card text-ios-text border border-ios-border',
};

function ToastIcon({ type }: { type: ToastType }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none' as const,
    stroke: 'currentColor',
    strokeWidth: 2.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (type) {
    case 'success':
      return (
        <svg {...common}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      );
  }
}

/**
 * Toast 渲染容器 — 挂载于应用根部（main.tsx）。
 * 顶部居中胶囊式堆叠，入场 slide-down，离场 shrink-fade。
 */
export function ToastProvider() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const listener: Listener = (next) => setToasts(next);
    listeners.add(listener);
    listener(items); // 同步挂载前已存在的 toast
    return () => {
      listeners.delete(listener);
    };
  }, []);

  if (toasts.length === 0) return null;

  return createPortal(
    <div
      data-testid="toast-stack"
      className="fixed left-1/2 -translate-x-1/2 z-toast flex w-full max-w-sm flex-col items-center gap-2 px-4 pointer-events-none"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium shadow-overlay transition-all duration-200 ${TYPE_STYLES[t.type]} ${
            t.leaving ? 'opacity-0 scale-90 -translate-y-2' : 'opacity-100 animate-slide-down'
          }`}
        >
          <ToastIcon type={t.type} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>,
    document.body,
  );
}
