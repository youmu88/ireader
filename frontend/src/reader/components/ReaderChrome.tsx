/**
 * ReaderChrome — 阅读器镀铬层（顶栏/底栏）显隐动画容器
 *
 * Apple Books 行为：默认隐藏，点按正文时滑入；
 * 隐藏时不响应指针（pointer-events-none），避免阻挡正文滚动。
 * side="top" 时自顶部滑出/滑入（顶栏书眉），与底栏共用同一 visible 状态源，显隐联动。
 */
import type { ReactNode } from 'react';

export interface ReaderChromeProps {
  visible: boolean;
  children: ReactNode;
  /** 容器方位：top=顶栏书眉（自顶滑入），bottom=底栏（自底滑入，默认） */
  side?: 'top' | 'bottom';
}

export function ReaderChrome({ visible, children, side = 'bottom' }: ReaderChromeProps) {
  const isTop = side === 'top';
  return (
    <div
      data-testid={isTop ? 'reader-chrome-top' : 'reader-chrome-bottom'}
      className={`fixed left-0 right-0 z-30 transition-transform duration-300 ease-out ${
        isTop ? 'top-0' : 'bottom-0'
      } ${visible ? 'translate-y-0' : isTop ? '-translate-y-full pointer-events-none' : 'translate-y-full pointer-events-none'}`}
    >
      {children}
    </div>
  );
}
