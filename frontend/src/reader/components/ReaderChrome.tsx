/**
 * ReaderChrome — 阅读器镀铬层（顶栏+底栏）显隐动画容器
 *
 * Apple Books 行为：默认隐藏，点按阅读区中央时顶栏自下滑入、底栏自上滑入；
 * 隐藏时不响应指针（pointer-events-none），避免阻挡翻页点按层。
 */
import type { ReactNode } from 'react';

export interface ReaderChromeProps {
  visible: boolean;
  top: ReactNode;
  bottom: ReactNode;
}

export function ReaderChrome({ visible, top, bottom }: ReaderChromeProps) {
  return (
    <>
      <div
        data-testid="reader-chrome-top"
        className={`fixed top-0 left-0 right-0 z-30 transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : '-translate-y-full pointer-events-none'
        }`}
      >
        {top}
      </div>
      <div
        data-testid="reader-chrome-bottom"
        className={`fixed bottom-0 left-0 right-0 z-30 transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full pointer-events-none'
        }`}
      >
        {bottom}
      </div>
    </>
  );
}
