# iReader 手势交互系统升级方案

## 背景

调研业界主流 Web 阅读器（epub.js、Readium、NYPL Web Reader、Kindle Web、Apple Books、Foliate、Calibre Web），
对比分析其技术方案后，为 iReader 制定 3 类核心功能的升级方案。

## 业界主流方案对比

### 技术架构

| 阅读器 | 渲染方式 | 手势方案 | 文字选择 | 菜单策略 |
|--------|---------|---------|---------|---------|
| epub.js Reader | iframe | iframe document 注入 touch | 原生 Selection | rendition.on('click') |
| Readium | iframe(多document) | Readium 内部事件系统 | Readium 内建 | 自定义浮动面板 |
| NYPL Web Reader | Readium + React | Readium 手势层 | Readium 内建 | 自定义浮动面板 |
| Kindle Web | Canvas/HTML | Pointer Events | Kindle 自研 | 长按弹出菜单 |
| Apple Books | WebKit 私有 | WebKit touch | 原生 + 自定义 | 长按/点击 |
| Foliate | WebView | WebView touch | 原生 Selection | 右键菜单 |
| Calibre Web | 纯 HTML 分页 | CSS column + touch | 原生 user-select | 自定义按钮栏 |

### 3 类功能的实现方案

#### 1. 左右滑动翻页

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A: CSS column + transform | column-width 分页 + translateX 切换 | 纯 CSS，无框架依赖 | 不支持 epub.js iframe |
| B: iframe document 注入 touch | 在 iframe document 上监听 touch 事件 | 官方通道，不 hack | 依赖 getContents() 时序 |
| C: 外层透明遮罩 | iframe 上覆盖透明 button 捕获触摸 | 100% 可靠 | 阻断文字选择和书内跳转 |
| D: Pointer Events + touch-action | PointerEvents 统一 touch/mouse | 现代标准，跨设备 | iframe 跨域限制 |

**iReader 采用方案 B**（epub.js 官方 iframe 注入）+ 方案 A 的 fallback（TXT 模式外层 DOM）。

#### 2. 点击/长按菜单

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A: 手势系统检测 | useGesture 检测长按/点击 | 统一入口，逻辑清晰 | 依赖手势系统先正常工作 |
| B: ContextMenu API | 浏览器 contextmenu 事件 | 系统级体验 | 移动端不触发 |
| C: selectionchange 事件 | 选中文字后显示菜单 | 与选择自然结合 | 无选中时无法触发 |

**iReader 采用 A + C 组合**。

#### 3. 选择和复制文字

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| A: CSS user-select + 原生 Selection | 允许 user-select: text | 最轻量，原生体验 | iframe 内需确保 CSS |
| B: Range + execCommand | 程序化选择 + execCommand('copy') | 可定制 | DOM 定位精确度要求高 |
| C: Clipboard API | navigator.clipboard.writeText() | 异步，现代标准 | 需 HTTPS/localhost |

**iReader 采用 A + C**。

## 实现方案

### P0（必须实现）：滑动翻页 + 长按菜单 稳定可用

| 子项 | 文件 | 改动 | 复杂度 |
|------|------|------|--------|
| P0-1: 移除 rendered 事件的冗余绑定 | EpubViewer.tsx | 只保留 relocated + display() 保底 | 低 |
| P0-2: 长按触觉反馈 | useGesture.ts | 长按触发 navigator.vibrate(15) | 低 |
| P0-3: 确保 txt 模式手势 attachToElement 正常 | ReaderPage.tsx | 验证现有逻辑 | 低 |
| P0-4: 添加手势挂载状态诊断端点 | EpubViewer.tsx | 暴露 window.__ireaderGestureStatus 全局变量 | 低 |

### P1（建议实现）：文字选择 + 复制

| 子项 | 文件 | 改动 | 复杂度 |
|------|------|------|--------|
| P1-1: 允许 epub iframe 内文字选择 | EpubViewer.tsx | themes 中设置 user-select: text | 低 |
| P1-2: 选择不误触手势 | useGesture.ts | 检测 getSelection().isCollapsed 跳过滑动判定 | 中 |
| P1-3: 选中后显示复制按钮 | ReaderPage.tsx | 监听 selectionchange，在选区附近显示复制按钮 | 中 |
| P1-4: 复制功能 | ReaderPage.tsx | navigator.clipboard.writeText() + Toast | 低 |

### P2（可选优化）：菜单位置跟随 + 更多操作

| 子项 | 文件 | 改动 | 复杂度 |
|------|------|------|--------|
| P2-1: 长按菜单跟随触摸点 | ReaderPage.tsx | 记录触摸坐标，菜单定位到手指附近 | 低 |
| P2-2: epub iframe 内文字选择 CSS | EpubViewer.tsx | themes 中加 user-select 控制 | 低 |

## 开发执行计划

### 迭代 1（本轮 P0 + P1 部分）✅ 已完成

- [x] 创建设计文档
- [x] P0-2: EpubViewer.tsx 滑动翻页视觉反馈箭头指示器（600ms 自动消失）
- [x] P0-3: useGesture.ts 长按触觉反馈（navigator.vibrate(15ms)）
- [x] P1-1/P1-2: useGesture.ts 选择文字时跳过滑动翻页（检测 window.getSelection().isCollapsed）
- [x] P1-3: ReaderPage.tsx 选中文字复制按钮（浮动面板中"复制"按钮 + Clipboard API）
- [x] P1-4: ReaderPage.tsx 复制功能 + Toast 反馈（绿色对勾 Toast，2秒自动消失）
- [x] 可选优化: deploy.sh 内置 chmod -R u+w + 残留 node_modules 清理防御
- [x] 类型检查（tsc --noEmit frontend + backend 通过）
- [x] 构建（vite build 成功）
- [x] 部署（deploy.sh 成功，HTTP 200）

**commit**: ab63694 — `fix: deploy.sh 增强 node_modules 残留清理 + 文字选择复制功能 (2.11.6→2.12.0)`

### 迭代 2（后续 P2）✅ 已完成

- [x] P2-1: 长按菜单跟随触摸点（useGesture 传坐标 → ReaderPage 浮动面板 style 按坐标偏移）
- [x] P2-2: epub iframe 内文字选择 CSS 增强（themes.register 中 body/p 显式 user-select: text + -webkit-user-select: text）

**commit**: <TBD> — `feat: P2 长按菜单跟随触摸点 + epub iframe 文字选择 CSS 增强 (2.12.0→2.13.0)`
