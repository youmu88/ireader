# ireader 前端 — 移动端优先 iOS 原生观感改造设计文档

## 1. 问题背景

当前前端为响应式 Web 应用（React + Vite + Tailwind + TS + Vitest），已有初步的 iOS 语义色 token 体系与统一组件库（Button/IconButton/Modal/Toast/ToggleSwitch），但整体布局仍是"桌面优先 + 顶部毛玻璃导航栏"形态，缺少移动端原生的 Tab 切换、底部 Dock、页面转场等体验。

用户目标：全面重构为 **移动端优先的 iOS 原生观感 SPA**，包含：
- 底部**透明 Dock**（iOS 玻璃拟态），图标：书架 / 图书管理 / 设置
- 图书管理页（新增）：上传队列、批量选择工具栏、预合成语音入口，全部打通现有 API
- 阅读器（ReaderPage）一并 iOS 化（顶栏/控制面板/目录抽屉视觉统一）
- 横向滑动页签切换（iOS 原生 Tab 手感）
- 所有界面高精度、高精美 iOS 风格
- 完整 dev TDD 工作流

## 2. 达成目标

| # | 目标 | 验收标准 |
|---|------|---------|
| G1 | 底部透明 Dock（书架/图书管理/设置） | 移动端固定底栏、毛玻璃、选中态高亮；阅读器态自动隐藏 |
| G2 | 新增图书管理页 | 上传队列 + 批量选择 + 预合成语音，API 打通 |
| G3 | 横向滑动页签切换 | 书架↔图书管理↔设置 手势滑切，路由同步 |
| G4 | 阅读器 iOS 化 | 顶栏/控制面板/目录抽屉统一 iOS 视觉 |
| G5 | 全量测试全绿 | vitest run 通过，新增组件测试覆盖 |

## 3. 需求规格表

| 需求ID | 类型 | 需求描述 | 优先级 | 关联模块 | 验收要点 |
|--------|------|---------|--------|---------|---------|
| R-001 | 功能 | 底部透明 Dock 组件（三 Tab：书架/图书管理/设置） | P0 | 新增 Dock | 固定底栏、毛玻璃、阅读器态隐藏 |
| R-002 | 功能 | 图书管理页面（上传/批量选择/预合成语音） | P0 | 新增 LibraryPage | 三功能区可操作、API 打通 |
| R-003 | 功能 | 横向滑动页签切换（iOS Tab 手势） | P0 | App/布局 | 滑切 + 路由同步 + 线性动量 |
| R-004 | 功能 | 阅读器 iOS 视觉统一 | P0 | Reader*组件 | 顶栏/控制面板/目录抽屉 iOS 化 |
| R-005 | 非功能 | 移动端优先自适应 + iOS 触摸反馈 | P1 | 全局 | 触屏 tap 反馈、安全区适配 |
| R-006 | 约束 | 复用现有 token/组件库/API | P0 | 全局 | 不重复造轮子，接入现有 services |

## 4. 实现方案

### 4.1 架构总览

新增/改造文件：
```
frontend/src/components/Dock/Dock.tsx          ← 新增：底部透明 Dock
frontend/src/components/Dock/Dock.test.tsx     ← 新增：Dock 测试
frontend/src/components/TabView/TabView.tsx     ← 新增：横向滑动页签容器
frontend/src/components/TabView/TabView.test.tsx← 新增：TabView 测试
frontend/src/pages/LibraryPage.tsx             ← 新增：图书管理页
frontend/src/pages/LibraryPage.test.tsx        ← 新增：图书管理页测试
frontend/src/App.tsx                           ← 改造：接入 Dock + TabView + LibraryPage 路由
frontend/src/components/Layout.tsx             ← 改造：去除旧顶部导航，底部预留 Dock
```

### 4.2 Dock 组件设计

iOS 原生 Dock 视觉：
- 固定底部，`backdrop-blur` 毛玻璃 + 半透明背景
- 三个图标按钮，选中态用「图标上浮 + 主色高亮 + 底部指示条」
- 阅读器路径（`/reader/*`）自动隐藏（不渲染）
- 图标集：书架（图书图标）、图书管理（网格/文件夹图标）、设置（齿轮图标）
- 使用现有 `IconButton`/Button 观感，颜色走 iOS token

### 4.3 TabView 设计

移动端优先的横向滑动页签：
- 三个面板按固定宽度 `100%` 横向排列在一个滚动容器内
- 触控滚动 + 路由同步（滚动结束后 `navigate`）
- 带线性动量（`scroll-snap` 或触摸惯性）+ 过渡缓动
- 桌面端降级为分段切换（避免破坏桌面体验）

### 4.4 图书管理页功能

复用现有 API/components：
- **上传**：复用 `UploadQueue` 组件（完整队列上传）
- **批量选择**：复用 `BatchActionBar` + 书架去重/删除/预生成语音 action
- **预合成语音**：调用 `/api/books/:id/tts-generate`，`TtsQueuePanel` 展示进度
- 依赖现有 `services/ttsService`、`axios` 等

### 4.5 阅读器 iOS 化

- ReaderTopBar：透明毛玻璃顶栏 + 返回/标题/操作按钮 iOS 视觉
- ReaderControlPanel：底部 iOS 面板圆角 + 毛玻璃
- TocDrawer：侧滑毛玻璃抽屉

## 5. 开发执行计划（todolist）

### 迭代 1：Dock + TabView 基石组件（TDD）
1. 写 `Dock.test.tsx`（断言三 Tab 渲染、阅读器态隐藏、选中高亮）→ 红灯
2. 实现 `Dock.tsx`
3. 写 `TabView.test.tsx`（断言横向排列、路由同步）→ 红灯
4. 实现 `TabView.tsx`
5. `tsc --noEmit` + `vitest run` 全绿

### 迭代 2：图书管理页 LibraryPage（TDD）
1. 写 `LibraryPage.test.tsx`（断言三功能区渲染）→ 红灯
2. 实现 `LibraryPage.tsx`（复用 UploadQueue/BatchActionBar/TtsQueuePanel）
3. 检查通过

### 迭代 3：App 接入 + 阅读器 iOS 化
1. 改造 App.tsx/Layout.tsx 接入 Dock + TabView + LibraryPage 路由
2. ReaderTopBar/ReaderControlPanel/TocDrawer iOS 视觉改造
3. 全量 `vitest run` + `tsc --noEmit` 全绿

### 迭代 4：验收 + 归档 + 部署
1. 复核 G1–G5 验收标准
2. 更新版本号（feature → b+1）
3. `git add && commit && push`，`bash deploy.sh`
