import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from './Button';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** 底部操作区（右对齐），不传则不渲染 */
  footer?: ReactNode;
  /** panel 最大宽度 tailwind class，默认 max-w-md */
  maxWidth?: string;
}

/**
 * 统一弹窗组件 — backdrop 点击/ESC 关闭，打开时锁定 body 滚动。
 * z-index 走 --z-modal(400) token，入场 pop-in 动画。
 */
export function Modal({ open, onClose, title, children, footer, maxWidth = 'max-w-md' }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      data-testid="modal-backdrop"
      className="fixed inset-0 z-modal flex items-center justify-center p-4 bg-ios-overlay animate-fade-in"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
        className={`w-full ${maxWidth} rounded-ios-xl bg-ios-bg-card shadow-overlay animate-pop-in p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <h2 id="modal-title" className="text-lg font-semibold text-ios-text mb-4">
            {title}
          </h2>
        )}
        <div className="text-sm leading-relaxed text-ios-text-secondary">{children}</div>
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ── 命令式 confirm（替代 window.confirm） ── */

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮渲染为 danger 变体 */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let confirmListener: ((req: ConfirmRequest | null) => void) | null = null;

/**
 * 命令式确认弹窗：const ok = await confirm({ title, message, danger: true })
 * 需在应用根部挂载 <ConfirmProvider>。
 */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    confirmListener?.({ ...options, resolve });
  });
}

/** confirm() 的渲染容器 — 挂载于应用根部（main.tsx） */
export function ConfirmProvider() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    confirmListener = setReq;
    return () => {
      confirmListener = null;
    };
  }, []);

  const done = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };

  return (
    <Modal
      open={!!req}
      onClose={() => done(false)}
      title={req?.title}
      footer={
        req && (
          <>
            <Button variant="secondary" onClick={() => done(false)}>
              {req.cancelText ?? '取消'}
            </Button>
            <Button variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
              {req.confirmText ?? '确定'}
            </Button>
          </>
        )
      }
    >
      {req?.message}
    </Modal>
  );
}
