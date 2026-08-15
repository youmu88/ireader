# 浏览器镀铬主题管理器设计（ChromeThemeManager）— v2.60.0

## 问题背景（三次迭代后的根因定位）

用户在 **iOS PWA standalone（black-translucent）** 下持续反馈：升级后首次进入阅读，顶部（系统状态栏区域）与主题一致；**返回后再进入，大概率恢复白色**。

### 根因

iOS standalone 状态栏是**透明**的，颜色 = 视口顶部区域的实际渲染内容。阅读页通过三层保证状态栏为主题色：
1. 阅读页根容器（`fixed inset-0` + `themeSpec.background`，首帧即渲染，声明式）；
2. 状态栏安全区覆盖层（`env(safe-area-inset-top)` 高度 + 主题色，声明式）；
3. html/body 根背景 + `theme-color` meta（**命令式 useEffect**）。

问题出在第 3 层：**React 18 的 `useEffect` 在浏览器 paint 之后异步执行**。SPA 导航（书架 → 阅读）时：
- 书架页 html/body 为白色；
- 切换瞬间 React commit → **浏览器先 paint 一帧**（此时 html/body 仍是白色）；
- useEffect 随后才把 html/body 改成主题色。

iOS 状态栏在 paint 时采样到白色，且**不会因页面背景后续变化而实时刷新** → 白色状态栏固化。
整页加载（升级后首次）时序恰好不同（加载期间多次 paint，最终采样到主题色）→ 正常。
"绝大部分概率"= 标准时序竞态特征。

### 为什么"补丁"不可行

- 在 useEffect 里加延迟/兜底 → 仍是竞态，只是窗口缩小；
- 只依赖声明式覆盖层 → 覆盖层高度依赖 `env(safe-area-inset-top)`，且 iOS 状态栏对"覆盖层背景变化"同样存在采样问题；
- 页面恢复监听（pageshow）→ 只覆盖"恢复"路径，不覆盖 SPA 导航路径。

## 正式方案：ChromeThemeManager（模块级单例 + useLayoutEffect）

### 架构

```
ReaderPage (挂载)
  └─ useReaderChromeTheme(bg)
       ├─ useLayoutEffect [mount]  → chromeThemeManager.enter(bg)   // paint 前应用
       ├─ useLayoutEffect [bg 变化] → chromeThemeManager.update(bg)  // 引用计数不变
       ├─ useLayoutEffect [unmount] → chromeThemeManager.exit()      // 归零才还原
       └─ statusBarStyle（声明式覆盖层，不变）
全局（模块加载时注册一次）
  └─ pageshow / visibilitychange → 若 active 则重放 apply(active)
```

### 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 应用时机 | `useLayoutEffect`（paint 前同步） | 首帧 paint 时 html/body 已是主题色，iOS 状态栏无白色可采样，消除竞态 |
| 状态归属 | 模块级单例 + 引用计数 | 脱离组件生命周期：SPA 导航、多实例并存、卸载顺序全部确定性 |
| 主题切换 | `update()`（不改引用计数、不还原） | 避免「cleanup 还原→再应用」的中间白色帧 |
| 还原目标 | 首次 `enter` 时记录的初始值 | 还原到书架/全局原状态，不污染 |
| 页面恢复 | 模块级全局监听 pageshow/visibilitychange | 覆盖 iOS 快照恢复/bfcache/后台切回路径，与组件生命周期解耦 |
| 覆盖层 | 保留声明式 statusBarStyle | 双保险：即使 html/body 被外部重置，状态栏区域仍有主题色覆盖层 |

### 不变式（验收标准）

1. **任何进入阅读的路径**，浏览器 paint 出的第一帧，html/body/theme-color/覆盖层**全部为主题色**；
2. 主题切换过程中**不出现**中间白色帧（update 原子应用）；
3. 退出阅读（引用计数归零）还原到进入前状态，不污染书架；
4. 页面恢复（快照/bfcache/后台切回）时若处于阅读态，自动重放主题色；
5. 阅读页根容器（fixed inset-0 + 主题背景）与覆盖层保持声明式渲染（已有）。

## 实施清单

- 新增 `frontend/src/reader/chromeThemeManager.ts`（单例 + 引用计数 + 全局恢复监听）
- 重写 `useReaderChromeTheme.ts`：useLayoutEffect 驱动管理器，接口（statusBarStyle）不变
- 更新/新增单测：管理器（enter/update/exit 计数、还原、恢复重放）、hook（paint 前同步断言）
- 版本 2.59.1 → 2.60.0

## 平台行为矩阵（不变）

| 平台 | 状态栏 | 机制 |
|---|---|---|
| iOS standalone（主屏幕图标） | 透出页面顶部 = 主题色 | viewport-fit=cover + 根容器/覆盖层 + 管理器 |
| Android Chrome/PWA | 地址栏/状态栏 = theme-color | 管理器同步 meta |
| iOS Safari（非 standalone） | 系统控制，无法变色 | 平台限制，保留沉浸引导提示 |
| 桌面浏览器 | 无系统状态栏 | 根背景一致即可 |
