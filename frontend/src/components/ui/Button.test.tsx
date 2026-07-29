import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Button } from './Button';

describe('Button', () => {
  it('渲染 children', () => {
    render(<Button>保存</Button>);
    expect(screen.getByText('保存')).toBeInTheDocument();
  });

  it('点击触发 onClick', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>提交</Button>);
    fireEvent.click(screen.getByText('提交'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled 阻断点击', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        禁用
      </Button>,
    );
    fireEvent.click(screen.getByText('禁用'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('loading 显示 spinner 并阻断点击', () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        加载中
      </Button>,
    );
    expect(screen.getByTestId('btn-spinner')).toBeInTheDocument();
    fireEvent.click(screen.getByText('加载中'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('variant 应用对应 token class', () => {
    const { container } = render(<Button variant="danger">删除</Button>);
    expect(container.querySelector('button')?.className).toContain('bg-ios-danger');
  });

  it('默认 variant 为 primary', () => {
    const { container } = render(<Button>默认</Button>);
    expect(container.querySelector('button')?.className).toContain('bg-ios-primary');
  });

  it('fullWidth 应用 w-full', () => {
    const { container } = render(<Button fullWidth>擑满</Button>);
    expect(container.querySelector('button')?.className).toContain('w-full');
  });

  it('size 应用对应尺寸 class', () => {
    const { container } = render(<Button size="sm">小</Button>);
    expect(container.querySelector('button')?.className).toContain('h-8');
  });
});
