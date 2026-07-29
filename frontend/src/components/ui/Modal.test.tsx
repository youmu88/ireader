import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Modal, ConfirmProvider, confirm } from './Modal';

describe('Modal', () => {
  it('open 时渲染 title 与 children', () => {
    render(
      <Modal open onClose={() => {}} title="弹窗标题">
        <p>弹窗内容</p>
      </Modal>,
    );
    expect(screen.getByText('弹窗标题')).toBeInTheDocument();
    expect(screen.getByText('弹窗内容')).toBeInTheDocument();
  });

  it('关闭时不渲染', () => {
    render(
      <Modal open={false} onClose={() => {}} title="隐藏标题">
        x
      </Modal>,
    );
    expect(screen.queryByText('隐藏标题')).not.toBeInTheDocument();
  });

  it('backdrop 点击触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="T">
        x
      </Modal>,
    );
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('panel 内点击不关闭', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="点我">
        x
      </Modal>,
    );
    fireEvent.click(screen.getByText('点我'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ESC 触发 onClose', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose}>
        x
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('打开时锁定 body 滚动，关闭后恢复', () => {
    const { rerender } = render(
      <Modal open onClose={() => {}}>
        x
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Modal open={false} onClose={() => {}}>
        x
      </Modal>,
    );
    expect(document.body.style.overflow).toBe('');
  });

  it('渲染 footer', () => {
    render(
      <Modal open onClose={() => {}} footer={<button>底部按钮</button>}>
        x
      </Modal>,
    );
    expect(screen.getByText('底部按钮')).toBeInTheDocument();
  });
});

describe('confirm()', () => {
  it('点击确认按钮 resolve true', async () => {
    render(<ConfirmProvider />);
    let result: boolean | undefined;
    act(() => {
      confirm({ title: '删除确认', message: '此操作不可恢复', danger: true }).then((ok) => {
        result = ok;
      });
    });
    expect(screen.getByText('此操作不可恢复')).toBeInTheDocument();
    fireEvent.click(screen.getByText('确定'));
    await act(async () => {});
    expect(result).toBe(true);
  });

  it('点击取消按钮 resolve false', async () => {
    render(<ConfirmProvider />);
    let result: boolean | undefined;
    act(() => {
      confirm({ title: 'T', message: 'M' }).then((ok) => {
        result = ok;
      });
    });
    fireEvent.click(screen.getByText('取消'));
    await act(async () => {});
    expect(result).toBe(false);
  });

  it('支持自定义按钮文案', async () => {
    render(<ConfirmProvider />);
    act(() => {
      confirm({ title: 'T', message: 'M', confirmText: '删除', cancelText: '再想想' });
    });
    expect(screen.getByText('删除')).toBeInTheDocument();
    expect(screen.getByText('再想想')).toBeInTheDocument();
  });
});
