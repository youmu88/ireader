# ireader 阅读器微信读书式重构设计文档

## 1. 问题背景

现有阅读器（ReaderPage + EpubViewer + TxtReaderView）存在两个已确认的 bug，且阅读体验未达微信读书水准：

**Bug A —— 无法记住阅读位置**
- TXT 滚动模式：恢复依赖 `pendingScrollRestorePct` state 传给 TxtReaderView 的 `initialScrollRatio`，但该 state 在 `loadChapterContent` 之后才设置，传给组件时**章节内容尚未加载完成**，恢复时常失败；且 EPUB 恢复依赖挂载时的单一 `initialCfi`，跨渲染/章节切换不稳定。
- 根因：恢复时序依赖 state 传递与内容加载的竞态，非订阅式恢复。

**Bug B —— 章节末尾无法自动加载下一章**
- ReaderPage 用 `IntersectionObserver` 监听 `bottomSentinelRef.current`，但 `TxtReaderView` 内部**从未挂载这个 sentinel DOM**，该 ref 恒为 null，`observer.observe()` 永不触发，自动加载形同虚设。

## 2. 达成目标（用户已确认方案）

| # | 目标 | 说明 |
|---|------|------|
| G1 | 彻底重写阅读器组件 | 全新微信读书式沉浸 ReaderView |
| G2 | 记住每章内位置 + 云同步 | 沿用 useProgressPersistence/useProgressRestore 体系，修复恢复竞态 |
| G3 | 顶部章节 + 底部进度 + 章末衔接布局 | 微信读书式沉浸布局重组 |
| G4 | 修复自动加载下一章 bug | 移除底部哨兵与实际 DOM 的脱节，订阅驱动；移除冗余手动按钮 |

## 3. 需求规格表

| 需求ID | 类型 | 需求描述 | 优先级 | 关联模块 | 验收要点 |
|--------|------|---------|--------|---------|---------|
| R-001 | Bug修复 | TXT 滚动位置恢复不再竞态丢失，返回时回到上次位置 | P0 | ReaderView/TxtReader | 模拟加载后恢复 scrollRatio 正确 |
| R-002 | Bug修复 | EPUB 位置用 CFI 订阅式恢复 | P0 | ReaderView/EpubViewer | 传入 initialCfi 正确 display |
| R-003 | 功能 | 底部哨兵真实挂载，滚动到底自动加载下一章 | P0 | TxtReaderView | IntersectionObserver 触发 goToNext |
| R-004 | 功能 | 顶部章节名 + 底部进度条 + 章末衔接 | P0 | ReaderView | 布局重组，微信读书式 |
| R-005 | 约束 | 移除冗余手动下一章按钮 | P1 | ReaderView | EPUB 侧边按钮移除 |
| R-006 | 约束 | 复用现有进度持久化/恢复 hook | P0 | hooks | 不重复造轮子 |

## 4. 实现方案

### 4.1 修复 Bug A（位置记忆）——订阅式恢复

**方案**：将 `TxtReaderView` 的 `initialScrollRatio` 恢复改为**订阅式**：
- 新增 state `restoredContentKey`，当内容加载完成 + 恢复比例确定后再一次性应用 `scrollTop`。
- 用 `useEffect` 监听 `[content, initialScrollRatio]`，在滚动容器 `scrollHeight` 可用后应用一次，并用 only-once 保护避免覆盖用户后续滚动。
- EPUB 侧：`initialCfiRef` 已存在，改为每次 `currentChapter` 变化时重新 display(cfi)，确保跨章恢复稳定。

### 4.2 修复 Bug B（自动加载下一章）——哨兵真实挂载

**方案**：在 `TxtReaderView` 滚动模式末尾**真实渲染 `<div ref={scrollSentinelRef}>`**，并暴露该 ref 或改为内部 IntersectionObserver + 回调。ReaderPage 移除失效的外部 observer，改为等 TxtReaderView 内部触发。

### 4.3 布局重组（微信读书式）

新建沉浸式 `ReaderView` 布局容器：
- 顶栏：左返回、中章节名、右目录/更多
- 正文：全高沉浸，点击中央呼出菜单（沿用现有手势）
- 底部：进度条（当前章比 + 全书比）+ TTS/目录快捷
- 章末：自动加载下一章（无限衔接）

### 4.4 复用与依赖

- 沿用 `useReadingPosition` / `useProgressPersistence` / `useProgressRestore`（云同步不变）
- 沿用 `ReaderTopBar` / `ReaderControlPanel` / `TocDrawer` / `SearchOverlay` / `TtsOverlay`
- 重写点为：TxtReaderView 的恢复/哨兵 + ReaderPage 布局容器

## 5. 开发执行计划（todolist）

### 迭代 1：TxtReaderView —— 修复恢复正常时序（TDD）
- [ ] 1. 写 `TxtReaderContent` 恢复逻辑测试（模拟加载后 scrollRatio 应用一次）
- [ ] 2. 改 TxtReaderView：恢复为 only-once 订阅式，内容就绪后应用
- [ ] 3. 检查通过

### 迭代 2：TxtReaderView —— 底部哨兵真实挂载（TDD）
- [ ] 1. 写滚动哨兵测试（滚动到底触发 onAutoLoadNext）
- [ ] 2. 在滚动模式末尾渲染 sentinel + IntersectionObserver → onAutoLoadNext
- [ ] 3. ReaderPage 移除失效的外部底哨兵 observer
- [ ] 4. 检查通过

### 迭代 3：ReaderView 布局重组
- [ ] 1. ReaderPage 顶部章节 + 底部进度布局重组
- [ ] 2. 移除冗余 EPUB 侧边手动章节按钮
- [ ] 3. 全量测试回归

### 迭代 4：归档
- [ ] typecheck + 全量测试 + 构建 + 版本号 + git commit/push
