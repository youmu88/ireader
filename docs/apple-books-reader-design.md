# Apple Books 风格 EPUB 阅读器设计

> 版本：2.44.0 · 日期：2026-08-01 · 状态：实施中

## 1. 背景与目标

旧阅读界面（epub.js 直渲 EpubViewer + 微信读书风格 WxReaderView + TXT 引擎 + TTS 播放层深度耦合，约 6000 行）已整体移除。本设计从零构建一套对标 **iOS/macOS「图书」(Apple Books)** 阅读体验的 EPUB 阅读器。

**目标**
- 全屏沉浸式阅读，镀铬 UI（顶栏/底栏）默认隐藏，点按唤出
- Apple Books 四色阅读主题 + aA 字体面板
- 全局页码（"第 X 页，共 Y 页"）+ 进度滑块
- CFI 精确断点续读（复用既有进度 API 与冲突合并）

**非目标（后续迭代）**：TXT 支持、TTS 朗读、全书搜索、书签、垂直滚动模式、仿真翻页 curl 动画。

## 2. 核心决策（用户指令推导，可纠正）

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 渲染引擎 | epub.js 0.3（沿用现有依赖） | CFI 精确定位、生态成熟；foliate-js 引入新依赖且社区小 |
| TXT 书籍 | 新阅读器仅 EPUB；TXT 点开提示暂不支持 | 用户明确"epub阅读器" |
| TTS | 阅读器第一版不接 TTS；后端 TTS 与设置页保留 | 用户指令范围是"阅读界面" |
| 进度数据 | 复用 GET/PUT `/api/books/:id/progress`（cfi/percentage/pageIndex/progressVersion） | 契约稳定，旧进度兼容 |
| 离线 | 复用 offlineCacheService 的 epubArchives 离线包 | PWA 既有能力 |

## 3. 交互规格（对标 Apple Books）

| 交互 | 行为 |
|------|------|
| 点按屏幕中央 | 顶栏自下滑入 + 底栏自上滑入（0.25s ease），再点隐藏 |
| 点按左/右 1/4 边缘 | 上一页/下一页，带 180ms 滑动过渡 |
| 顶栏 | `‹ 书库` 返回 · 书名（居中截断） · 目录图标 · aA 图标 |
| 底栏 | 进度滑块（0-100%，拖动跳转） + `第 X 页，共 Y 页` |
| aA 面板 | 底部弹层：字号 A-/A+（60%-200%，步进 10%）· 四主题圆点 · 行距三档（1.5/1.75/2.0） |
| 目录抽屉 | 左侧滑出（max-w-xs），章节树，当前章高亮，点击跳转并关闭 |
| 翻页动画 | 容器 translateX 180ms 滑动过渡（epub.js paginated 瞬移的视觉包装） |

**四主题**（页面容器与 rendition 内容联动）：

| 主题 | 背景 | 文字 |
|------|------|------|
| white | #ffffff | #1c1c1e |
| sepia | #f8f1e4 | #5f4b32 |
| gray | #2c2c2e | #d1d1d6 |
| black | #000000 | #e5e5ea |

## 4. 技术方案

### 4.1 渲染与页码
- `flow: 'paginated'`, `spread: 'none'`，容器 100% 宽高
- `book.locations.generate(1200)` 异步生成全局位置列表；生成前底栏显示章节内页码（`displayed.page/total`），生成后切换全局页码并启用滑块
- 主题/字号/行距：`rendition.themes.register` 四主题 + `select` / `fontSize('110%')` / `override('line-height')`，均不重建 DOM

### 4.2 进度
- 恢复：GET progress → `cfi` → `rendition.display(cfi)`；无记录从头开始
- 保存：`relocated` 事件 800ms 防抖 → PUT `{ cfi, percentage, pageIndex, progressVersion, deviceId }`
- 冲突：响应 `conflict: true` 时采用服务端版本号继续（不强制跳页，避免打断阅读）
- 离线兜底：localStorage `ireader_reader_pos_{bookId}`

### 4.3 书籍来源
- 在线：`/api/books/:id/file` + `Authorization` header（epub.js requestHeaders）
- 离线：`getCachedEpubArchive(bookId)` → ArrayBuffer → `ePub(buffer)`

## 5. 模块结构

```
src/reader/                      # 全新模块（旧 reader/ 已删除）
  types.ts                       # ReaderTheme/ReaderSettings/TocItem/ReaderLocation
  theme.ts                       # 四主题定义 + rendition 样式生成
  EpubBookController.ts          # epub.js 封装：load/next/prev/goTo/applySettings/事件桥接
  useReaderSettings.ts           # 设置状态 + localStorage 持久化 + clamp
  useReaderProgress.ts           # 进度恢复/防抖保存/版本冲突
  components/
    ReaderChrome.tsx             # 顶栏+底栏显隐动画容器
    ReaderTopBar.tsx             # 返回/书名/目录/aA
    ReaderBottomBar.tsx          # 进度滑块 + 页码
    FontSettingsPanel.tsx        # aA 底部弹层
    TocPanel.tsx                 # 目录抽屉
src/pages/ReaderPage.tsx         # 组装：加载 → controller → chrome/面板/点按层
```

## 6. 测试计划

| 测试 | 覆盖 |
|------|------|
| theme.test.ts | 四主题完整性、rendition 样式生成、默认值 |
| useReaderSettings.test.ts | 默认值、localStorage 读写、字号 clamp 边界 |
| useReaderProgress.test.ts | 防抖保存、版本号递增、conflict 处理（mock axios） |
| EpubBookController.test.ts | mock epubjs：load 流程、事件桥接、主题应用、翻页转发 |

## 7. 开发执行计划

- [x] Phase 1：移除旧阅读界面全部代码（40+ 文件 + BookshelfPage 播放条 129 行），tsc 全绿
- [x] 迭代1：reader 核心（types/theme/EpubBookController + 单测）
- [x] 迭代2：hooks（useReaderSettings/useReaderProgress + 单测）
- [x] 迭代3：UI 组件（Chrome/TopBar/BottomBar/FontPanel/TocPanel + 单测）
- [x] 迭代4：ReaderPage 组装 + 路由接回 + TXT 提示（+ 集成测试）
- [x] 迭代5：全量验证（tsc + vitest 137 全绿）+ 版本 2.44.0 + 归档

## 8. 迭代2 完成记录（2.45.0 · 2026-08-01）

| 功能 | 实现 | 测试 |
|------|------|------|
| 垂直滚动模式 | rendition.flow 切换 + aA 面板开关 + 滚动模式禁用左右点按翻页区 | settings/controller 单测 |
| 书签 | useBookmarks（localStorage 按书持久化，CFI 唯一键 toggle）+ 顶栏书签按钮（当前页状态+toast）+ TocPanel 目录/书签双 tab + controller.getExcerptAt 摘要提取 | 10 hook + 4 面板 + 1 集成 |
| 全书搜索 | searchBook（spine 逐章 TreeWalker 遍历 + Range→CFI 可跳转，逐章 unload 控内存，单章失败不中断）+ 全屏 SearchPanel（300ms 防抖即输即搜 + mark 高亮 + 章节标题反查） | 9 算法 + 8 面板 + 1 集成 |
| 仿真翻页 | translateX 平移升级为 CSS 3D 书页翻转（rotateY±32° 书脊侧为轴 + perspective 1600px 景深） | 集成回归 |

**curl 技术结论（双独立来源验证）**：
- epub.js 无官方/社区成熟 curl 翻页插件（GitHub issue #510：“no plugins close to this”）
- StPageFlip/page-flip 需离散 HTML 元素/图片作为页面输入，与 epub.js 连续流渲染模型（iframe+CSS columns）不兼容，集成=自研分页引擎；且 npm page-flip@2.0.7 已 5 年未维护
- 本项目历史三次自研分页（2.5.1/2.6.0/2.7.0）均失败回滚
- 决策：采用 CSS 3D 翻转逼近；真 curl 自研分页属架构级改动，建议单独立项评估

## 9. TXT 支持（2.46.0 · 2026-08-01）

去除新阅读器对 TXT 的“暂不支持”限制，改为 EPUB/TXT 统一渲染管线：

| 层 | 实现 |
|----|------|
| buildTxtFeed | 纯函数：TXT 章节文本 → epub.js HTML Feed（XHTML <section> 骨架，<p> 段落化，HTML 转义防注入，空章过滤） |
| EpubBookController.loadTxt | 以 HTML Feed 方式构造 epub.js book（sections 数组即书源），spine 连续多章，CFI 定位与 EPUB 同构 |
| ReaderPage 分流 | format==='txt' 时拉取章节清单 → 逐章取正文 → loadTxt 渲染，复用既有翻页/主题/字号/滚动/进度/书签/搜索全能力 |

技术要点：TXT 不重复实现独立渲染引擎，而是将纯文本标准化为 epub.js 可渲染的 HTML Feed，使全部阅读器能力天然对 TXT 生效，系统复杂度保持可控。
- 新增 7 个 buildTxtFeed 单测 + 1 个 TXT 组装集成测试更新，全部 182 测试通过，tsc 全绿
