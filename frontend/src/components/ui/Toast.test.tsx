import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToastProvider, toast } from './Toast';

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    // 清空残留 toast，避免跨用例污染（模块级 store）
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    vi.useRealTimers();
  });

  it('toast.success 显示消息', () => {
    render(<ToastProvider />);
    act(() => {
      toast.success('已复制');
    });
    expect(screen.getByText('已复制')).toBeInTheDocument();
  });

  it('toast.error 显示消息', () => {
    render(<ToastProvider />);
    act(() => {
      toast.error('操作失败');
    });
    expect(screen.getByText('操作失败')).toBeInTheDocument();
  });

  it('默认时长后自动消失', () => {
    render(<ToastProvider />);
    act(() => {
      toast.success('临时消息', { duration: 1000 });
    });
    expect(screen.getByText('临时消息')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(1000); // 触发 dismiss → leaving
    });
    act(() => {
      vi.advanceTimersByTime(250); // LEAVE_MS 后移除
    });
    expect(screen.queryByText('临时消息')).not.toBeInTheDocument();
  });

  it('多条 toast 堆叠显示', () => {
    render(<ToastProvider />);
    act(() => {
      toast.info('消息A');
      toast.warning('消息B');
    });
    expect(screen.getByText('消息A')).toBeInTheDocument();
    expect(screen.getByText('消息B')).toBeInTheDocument();
  });

  it('堆叠上限 4 条，超出移除最旧', () => {
    render(<ToastProvider />);
    act(() => {
      toast.info('t1', { duration: 99999 });
      toast.info('t2', { duration: 99999 });
      toast.info('t3', { duration: 99999 });
      toast.info('t4', { duration: 99999 });
      toast.info('t5', { duration: 99999 });
    });
    expect(screen.queryByText('t1')).not.toBeInTheDocument();
    expect(screen.getByText('t5')).toBeInTheDocument();
  });
});
