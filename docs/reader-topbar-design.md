# 阅读页顶栏主题化设计（Reader TopBar）— v2.59.0

## 背景与问题

阅读页（`/reader/:bookId`）自 2.48.0 菜单迁到底部、2.51.0 移除返回/书签/全屏后，**顶部没有任何应用级 UI**。
用户在浏览器（典型：iOS Safari 非 standalone）打开深色主题阅读时，顶部只有一条**系统状态栏**：
- iOS Safari（非 standalone）：状态栏**白底黑字**，由 iOS 系统控制，**网页无法改色**（平台限制）；
- Android Chrome：`theme-color` meta 可控制地址栏（已随阅读主题同步）；
- iOS standalone（主屏幕图标进入）：`black-translucent` 下状态栏透明，应用已有主题色覆盖层（`useReaderChromeTheme`）。

因此「顶部白色顶栏与深色读书主题割裂」的直接观感来源是：**应用顶栏缺失 + 系统状态栏白条**。

## 设计目标

1. 阅读页拥有与读书主题一致的**应用级顶栏**（Apple Books 风格书眉）；
2. 顶栏与底栏同一视觉语言（`chromeBackground`/`chromeColor` 注入 + backdrop-blur + 细分隔线），
   切主题即时同步，不引入第二套配色体系；
3. 顶栏区域（应用可控部分）在**所有平台**下均为主题色；
4. iOS Safari 系统状态栏白条为平台硬限制，通过顶栏内「沉浸式阅读」说明入口告知用户
   （从主屏幕图标进入 → standalone → 状态栏透明，顶栏与页面完全一体）。

## 设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 顶栏形态 | 应用级书眉（返回｜书名｜aA） | 补回 2.51.0 移除的返回入口；书眉是阅读器标准结构 |
| 主题接入 | 复用 `chromeBackground`/`chromeColor` 注入 | 与底栏/面板同源，零新增色值，切主题即时同步 |
| 显隐行为 | 与底栏共用 `chromeVisible` 单状态源，**进入即显示** | Apple Books 行为；点正文联动隐藏进入沉浸 |
| 安全区 | 容器 `padding-top: env(safe-area-inset-top)` | standalone 从屏幕顶开始一体沉浸；Safari 自然落在系统栏下方 |
| 沉浸引导 | 悬浮胶囊 → 顶栏内「沉浸式阅读」图标 + 浮层说明 | 胶囊遮挡正文且文案过时（现在顶栏已是主题色）；按钮不打扰、可随时唤起 |
| 状态栏覆盖层 | 保留 `useReaderChromeTheme`（覆盖层/根背景/theme-color）不动 | 既有架构正确，Standalone 沉浸与 Android 地址栏由它保证 |

## 实现

- `ReaderChrome`：新增 `side?: 'top' | 'bottom'`，顶部容器 `top-0` 隐藏时 `-translate-y-full`；
- `ReaderTopBar`（新组件）：书眉布局 + 沉浸说明入口（`showImmersiveTip` 由页面按
  `!isStandalone && themeSpec.dark` 注入）；
- `ReaderPage`：顶栏/底栏双 Chrome 同源联动；`chromeVisible` 初始 `true`；
  悬浮引导胶囊与 `IMMERSIVE_TIP_KEY` 删除；新增 `immersiveTipOpen` 浮层状态。

## 平台行为矩阵

| 平台 | 系统状态栏 | 应用顶栏 | 沉浸说明入口 |
|---|---|---|---|
| iOS standalone | 透明（主题色覆盖层） | 主题色、从屏幕顶开始 | 无 |
| iOS Safari（非 standalone） | 白条（系统控制，无法改） | 主题色书眉在系统栏下方 | 显示（深色主题时） |
| Android Chrome | 地址栏随 theme-color | 主题色书眉 | 无（地址栏已同步） |
| 桌面浏览器 | 无状态栏 | 主题色书眉 | 无 |

## 遗留说明

- iOS Safari 非 standalone 的系统状态栏白条是苹果平台限制，任何 Web 阅读器（微信读书网页版等）均无法规避；
  已通过「沉浸式阅读」浮层向用户说明 standalone 进入方式。
