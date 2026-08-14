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
 *
 * 页面恢复兜底（v2.59.1）：iOS standalone 从主屏幕再次进入（快照恢复/bfcache/后台切回）时
 * 页面不重新加载，useEffect 不会重跑；若上次离开阅读时根背景已还原为书架白色，
 * 恢复后再次进入阅读会看到状态栏/顶部保持白色。因此挂载期间监听 pageshow 与
 * visibilitychange，页面恢复（visible）时立即重放当前主题背景，无需依赖组件生命周期。
 */
import { useEffect, useRef, type CSSProperties } from 'react';

export interface ReaderChromeThemeResult {
  /** 状态栏安全区覆盖层样式（声明式，由 React 渲染驱动） */
  statusBarStyle: CSSProperties;
}

/** 幂等应用主题背景到浏览器镀铬层（meta + html/body） */
function applyChromeBackground(bg: string) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
}

/** 还原为进入阅读前的初始值（meta 默认色 + html/body 原背景） */
function restoreChromeBackground(metaDefault: string, htmlBg: string, bodyBg: string) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', metaDefault);
  document.documentElement.style.background = htmlBg;
  document.body.style.background = bodyBg;
}

export function useReaderChromeTheme(background: string): ReaderChromeThemeResult {
  const themeMetaRef = useRef<string | null>(null);
  const htmlBgRef = useRef<string>('');
  const bodyBgRef = useRef<string>('');

  useEffect(() => {
    // 首次挂载：记录进入阅读前的初始值（还原目标）
    if (themeMetaRef.current === null) {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      themeMetaRef.current = meta?.getAttribute('content') ?? '#3b82f6';
      htmlBgRef.current = document.documentElement.style.background;
      bodyBgRef.current = document.body.style.background;
    }
    applyChromeBackground(background);

    // 页面恢复兜底：iOS standalone 快照恢复 / bfcache / 后台切回时 effect 不重跑，
    // 若离开阅读时根背景已还原为白，恢复后状态栏/顶部会停留白色 → 恢复即重放主题背景
    const onPageShow = () => applyChromeBackground(background);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') applyChromeBackground(background);
    };
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      restoreChromeBackground(themeMetaRef.current ?? '#3b82f6', htmlBgRef.current, bodyBgRef.current);
    };
  }, [background]);

  return {
    statusBarStyle: {
      height: 'env(safe-area-inset-top, 0px)',
      background,
    },
  };
}
