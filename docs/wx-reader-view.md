# ireader 微信读书风格阅读器 WxReaderView 设计文档

## 1. 背景与问题

用户确认现有阅读器（ReaderPage 顶部工具栏 + 底部控制面板）**并非微信读书式沉浸布局**，且此前"阅读器微信读书重构"仅做零散 bug 修补，未落地真正的微信读书视觉。用户明确要求：

- **净新建 WxReaderView 组件替换**，彻底微信读书沉浸体感
- 本轮**先出微信读书视觉骨架**（布局/视觉先行），功能联调随后续轮次
- 需修复的已知缺陷（后续联调）：阅读位置记忆、章节自动加载、书架最近阅读排序

## 2. 达成目标（本轮：视觉骨架）

| # | 目标 | 验收标准 |
|---|------|---------|
| G1 | WxReaderView 微信读书沉浸式视觉骨架 | 纯滚动沉浸阅读、无顶部常驻工具栏、章末衔接视觉 |
| G2 | 轻触唤出/隐去顶栏与底部控制条 | 点击正文中间区域切换工具栏显隐（微信读书式） |
| G3 | 顶部章节目录条 + 底部进度条 | 顶部显示章节名下拉，底部显示滚动进度 |
| G4 | props 与 TxtReaderView 对齐 | 便于后续与 ReaderPage 联调、替换 |

## 3. 需求规格表

| 需求ID | 类型 | 需求描述 | 优先级 | 关联模块 | 验收要点 |
|--------|------|---------|--------|---------|---------|
| R-001 | 功能 | 全屏沉浸式正文滚动区（无常驻工具栏） | P0 | WxReaderView | 正文占满可视区 |
| R-002 | 功能 | 轻触正文中间唤出/隐去工具栏 | P0 | WxReaderView | 点击切换 visible 态 |
| R-003 | 功能 | 顶部章节名 + 底部进度条 | P0 | WxReaderView | 章节名渲染、进度随滚动更新 |
| R-004 | 功能 | 章末衔接视觉（滚动到底显示） | P1 | WxReaderView | 底部哨兵/章末占位 |
| R-005 | 约束 | props 与 TxtReaderView 对齐 | P0 | WxReaderView | 复用同一 props 契约 |
| R-006 | 约束 | iOS 视觉 token | P0 | WxReaderView | 复用 color-bg/color-text 等 token |

## 4. 实现方案

### 4.1 架构

新建 `frontend/src/components/WxReaderView.tsx`：
- **props**：与 TxtReaderViewProps 对齐（content/chapterTitle/readingMode/onProgress/onBoundary/onPageInfo/initialScrollRatio 等）
- **沉浸骨架**：
  - 外层全屏，背景用 `var(--color-bg)`（沉浸阅读底色）
  - 正文滚动容器占满可视区，字体/行高/字距可调
  - 轻触正文空白区页可切换 `menuVisible`（顶部章节条 + 底部进度条显隐）
  - 顶部章节名条（透明，可见时显示章节名+目录入口占位）
  - 底部进度条（窄进度线 + 百分比）
  - 章末衔接：底部哨兵 + "本章完/继续"视觉占位，滚动到底由 onBoundary 通知父级
- **iOS token**：复用现有 `--color-bg / --color-text / --color-text-muted / --color-primary`，不新增 token

### 4.2 TDD 顺序
1. 写 `WxReaderView.test.tsx`（断言骨架元素：正文容器、章节名、进度条、点击唤出工具栏）→ 红灯
2. 实现 WxReaderView.tsx → 绿灯
3. typecheck + 全量测试回归

### 4.3 后续轮次联调（不在本轮）
- ReaderPage 接入 WxReaderView（替换 TxtReaderView）
- 位置记忆/自动加载/书架排序的联调与验收

## 5. 开发执行计划（todolist）

### 迭代 1：WxReaderView 视觉骨架（TDD）✅/⬜
- [ ] 1. 写 WxReaderView.test.tsx（骨架元素断言）→ 红灯
- [ ] 2. 实现 WxReaderView.tsx（沉浸滚动 + 轻触唤出 + 顶章节/底进度 + 章末占位）→ 绿灯
- [ ] 3. typecheck + vitest 全绿
- [ ] 4. 版本号递增 + 归档
