/**
 * useReaderChromeTheme — 阅读主题 → 浏览器镀铬层（状态栏覆盖层 + html/body 根背景 + theme-color）
 *
 * v2.60.0 重构：html/body 根背景 + theme-color 的命令式同步从「组件 useEffect + ref 快照」
 * 迁移到模块级 ChromeThemeManager（引用计数 + 确定性还原 + 页面恢复兜底重放）。
 *
 * 关键差异：useEffect（paint 之后异步）→ useLayoutEffect（paint 之前同步）。
 * iOS PWA standalone 状态栏透明且不随页面背景变化实时刷新：SPA 导航进入阅读时若
 * 首帧 paint 的根背景是书架白色，状态栏即固化白色（「再次进入大概率白色顶栏」根因）。
 * useLayoutEffect 保证首帧 paint 前根背景已是主题色，状态栏无白色可采样。
 *
 * 状态栏安全区覆盖层保持声明式（React 渲染驱动）：切主题即时变、进入/退出一致、无时序竞态。
 */
import { useLayoutEffect, type CSSProperties } from 'react';
import { enterChromeTheme, exitChromeTheme, updateChromeTheme } from './chromeThemeManager';

export interface ReaderChromeThemeResult {
  /** 状态栏安全区覆盖层样式（声明式，由 React 渲染驱动） */
  statusBarStyle: CSSProperties;
}

export function useReaderChromeTheme(background: string): ReaderChromeThemeResult {
  // 生命周期：挂载 enter（记录初始值 + 应用主题背景，paint 前同步执行）
  useLayoutEffect(() => {
    enterChromeTheme(background);
    return () => exitChromeTheme();
    // 仅挂载/卸载时执行；主题切换由下方 update effect 处理（不触发中间还原）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主题切换：直接更新背景（引用计数不变）
  useLayoutEffect(() => {
    updateChromeTheme(background);
  }, [background]);

  return {
    statusBarStyle: {
      height: 'env(safe-area-inset-top, 0px)',
      background,
    },
  };
}
