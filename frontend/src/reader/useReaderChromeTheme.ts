/**
 * useReaderChromeTheme — 阅读主题 → 浏览器镀铬层（状态栏覆盖层 + html/body 根背景 + theme-color）统一收敛
 *
 * 三处同步收敛为单一 hook，降低维护面：
 * 1. 状态栏安全区覆盖层 style（声明式渲染：切主题即时变、进入/退出一致、无时序竞态）
 *    —— 由调用方渲染到 reader 顶层，高度 env(safe-area-inset-top) 覆盖 iOS standalone 状态栏区域；
 * 2. html/body 根背景（命令式 useEffect：iOS 橡皮筋回弹 / PWA 状态栏透明区 / 地址栏动画透出的根背景随主题）；
 * 3. theme-color meta（Android Chrome 地址栏 / PWA 顶栏跟随阅读主题背景）。
 *
 * 还原策略：用 ref 记录【首次挂载时】初始值，退出时还原初始值而非每次 effect 捕获值。
 * 历史 bug：若还原用 effect 内捕获的 prevBody，多次切主题后 prevBody 是上一次设置的主题色，
 *           退出会把 html/body 还原成「倒数第二次」主题色 → 污染书架背景、进入退出不一致。
 */
import { useEffect, useRef, type CSSProperties } from 'react';

export interface ReaderChromeThemeResult {
  /** 状态栏安全区覆盖层样式（声明式，由 React 渲染驱动） */
  statusBarStyle: CSSProperties;
}

export function useReaderChromeTheme(background: string): ReaderChromeThemeResult {
  const themeMetaRef = useRef<string | null>(null);
  const htmlBgRef = useRef<string>('');
  const bodyBgRef = useRef<string>('');

  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (themeMetaRef.current === null) {
      themeMetaRef.current = meta?.getAttribute('content') ?? '#3b82f6';
      htmlBgRef.current = document.documentElement.style.background;
      bodyBgRef.current = document.body.style.background;
    }
    if (meta) meta.setAttribute('content', background);
    document.documentElement.style.background = background;
    document.body.style.background = background;
    return () => {
      if (meta) meta.setAttribute('content', themeMetaRef.current ?? '#3b82f6');
      document.documentElement.style.background = htmlBgRef.current;
      document.body.style.background = bodyBgRef.current;
    };
  }, [background]);

  return {
    statusBarStyle: {
      height: 'env(safe-area-inset-top, 0px)',
      background,
    },
  };
}
