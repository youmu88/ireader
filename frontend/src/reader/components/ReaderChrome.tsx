/**
 * ReaderChrome — 阅读器镀铬层（底栏）显隐动画容器
 *
 * Apple Books 行为：默认隐藏，点按正文时自底部滑入；
 * 隐藏时不响应指针（pointer-events-none），避免阻挡正文滚动。
 */
import type { ReactNode } from 'react';

export interface ReaderChromeProps {
  visible: boolean;
  children: ReactNode;
}

export function ReaderChrome({ visible, children }: ReaderChromeProps) {
  return (
    <div
      data-testid="reader-chrome-bottom"
      className={`fixed bottom-0 left-0 right-0 z-30 transition-transform duration-300 ease-out ${
        visible ? 'translate-y-0' : 'translate-y-full pointer-events-none'
      }`}
    >
      {children}
    </div>
  );
}
