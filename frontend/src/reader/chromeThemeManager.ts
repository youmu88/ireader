/**
 * chromeThemeManager — 浏览器镀铬主题管理器（模块级单例，不依赖 React 生命周期）
 *
 * 职责：管理阅读主题 → 浏览器镀铬层（html/body 根背景 + theme-color meta）的确定性应用与还原。
 *
 * 为什么存在（v2.60.0 重构）：iOS PWA standalone（black-translucent）状态栏透明，
 * 颜色 = 视口顶部实际渲染内容。此前由组件 useEffect（paint 之后异步）设置根背景，
 * SPA 导航进入阅读时浏览器先 paint 一帧白色（书架根背景），iOS 状态栏采样到白色后
 * 不随页面背景变化刷新 → 「再次进入大概率白色顶栏」。本管理器把根背景应用提前到
 * paint 之前（配合 useLayoutEffect），并用模块级状态保证任何进入路径/时序下行为确定。
 *
 * 机制：
 * - 引用计数：多个阅读器实例并存/嵌套安全；计数归零才还原，还原到首次进入时记录的初始值
 *   （而非「倒数第二次主题色」，避免历史污染竞态）；
 * - 确定性还原：enter/update/exit 显式三态，主题切换走 update（不触发中间还原）；
 * - 全局兜底重放：pageshow（快照恢复/bfcache）+ visibilitychange（后台切回）时若仍有
 *   活跃阅读器（activeBackground 非空），立即重放当前主题背景——页面不重载、effect 不重跑
 *   时根背景不再停留白色。
 */

/** 当前生效的阅读主题背景；null = 无活跃阅读器（书架/全局外观） */
let activeBackground: string | null = null;
/** 首次 enter 时记录的还原目标（theme-color 默认值 + html/body 原背景） */
let initialThemeColor = '#3b82f6';
let initialHtmlBg = '';
let initialBodyBg = '';
/** 活跃阅读器计数 */
let readerCount = 0;

function apply(bg: string) {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', bg);
  document.documentElement.style.background = bg;
  document.body.style.background = bg;
}

function restore() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', initialThemeColor);
  document.documentElement.style.background = initialHtmlBg;
  document.body.style.background = initialBodyBg;
}

/** 进入阅读（引用计数 +1，首次进入记录初始值并应用主题背景） */
export function enterChromeTheme(bg: string) {
  if (readerCount === 0) {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    initialThemeColor = meta?.getAttribute('content') ?? '#3b82f6';
    initialHtmlBg = document.documentElement.style.background;
    initialBodyBg = document.body.style.background;
  }
  readerCount += 1;
  activeBackground = bg;
  apply(bg);
}

/** 主题切换（引用计数不变，直接更新背景；不触发中间还原） */
export function updateChromeTheme(bg: string) {
  if (readerCount === 0) return;
  activeBackground = bg;
  apply(bg);
}

/** 退出阅读（引用计数 -1，归零还原初始值） */
export function exitChromeTheme() {
  if (readerCount > 0) readerCount -= 1;
  if (readerCount === 0) {
    activeBackground = null;
    restore();
  }
}

/** 页面恢复兜底：快照恢复/后台切回时重放当前主题背景（activeBackground 非空才重放，不污染书架） */
export function replayChromeTheme() {
  if (activeBackground) apply(activeBackground);
}

/**
 * 重置管理器内部状态（仅测试用：vitest 同文件测试共享模块实例，避免引用计数跨用例泄漏）。
 * 生产代码不调用。
 */
export function resetChromeThemeManagerForTests() {
  activeBackground = null;
  initialThemeColor = '#3b82f6';
  initialHtmlBg = '';
  initialBodyBg = '';
  readerCount = 0;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', initialThemeColor);
  document.documentElement.style.background = '';
  document.body.style.background = '';
}

// 模块级全局监听（注册一次，不随组件卸载移除——页面生命周期级）
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('pageshow', replayChromeTheme);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') replayChromeTheme();
  });
}
