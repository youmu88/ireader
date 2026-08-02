# 阅读界面主题同步顽疾 — 根因分析报告（RCA）

> 版本：v2.56.5 ｜ 日期：2026-08-02 ｜ 修复 commits：f76ac53（代码）+ f418952（本文档）｜ 状态：已根治，测试全绿

## 一、症状（用户报告）

1. 阅读界面更改阅读背景（主题色），顶栏（状态栏/镀铬层）不同步；
2. 更改了顶栏相关代码后，阅读界面（正文背景）又不同步；
3. 各种「奇奇怪怪」：有时同步有时不同步、同一屏不同章节颜色不一致、重选旧主题后正文不变色。

## 二、复现步骤

前置：任意 EPUB 书籍，连续滚动模式（scrolled-continuous）阅读页。

1. 打开 aA 面板，依次切换主题：白 → 黑 → 灰 → 棕褐（每个主题均首次选择，正文/顶栏正常同步）；
2. **再次选择「白」**（重选已用过的主题）：
   - 预期：正文背景恢复白色；
   - 实际：**正文保持上一个深色主题不变**，而顶栏/底栏/面板（React 声明式渲染）已切白 → 顶栏与正文不同步；
3. 在不同步状态下垂直滚动跨过章节边界：
   - 实际：**新拼接进来的章节显示正确的新主题，旧章节保持旧主题** → 同屏两个章节两种颜色；
4. 失效与否取决于历史选择顺序（首次选每个主题必正常，只有「重选」失效）→ 间歇性、难以捉摸。

## 三、定位过程

### 3.1 排查范围收敛（五条同步链路逐条复核）

git log 显示 v2.55.1~v2.56.4 五个补丁全部修在前两条链路（React 镀铬层与根背景），真正的病灶从未被触及：

| # | 链路 | 机制 | 结论 |
|---|------|------|------|
| 1 | React 镀铬层（状态栏覆盖层/底栏/面板/页面根背景） | `themeSpec` → 声明式 style | ✅ 无缺陷（v2.56.2/2.56.3 已修好，保留） |
| 2 | html/body 根背景 + theme-color meta | `useReaderChromeTheme` 命令式 hook | ✅ 无缺陷（v2.56.3 已修好，保留） |
| 3 | **iframe 内章节文档背景/颜色/行距** | ~~`themes.register(name)+select(name)`~~ epub.js keyed stylesheet | ❌ **核心根因（本次修复）** |
| 4 | 字号 | `themes.fontSize` → override 内联样式 | ✅ 无缺陷（保留） |
| 5 | 设置时序（加载期间切主题被吞） | `settingsRef` 重放 | ✅ 无缺陷（v2.56.4 已修好，保留） |

### 3.2 深入 epub.js 源码取证（node_modules，禁改）

- `Contents._getStylesheetNode(key)`（lib/contents.js:746-761）：keyed style 元素 `epubjs-inserted-css-<name>` 首次创建时 append 到 `<head>`；**已存在时保持原位返回**；
- `Contents.addStylesheetRules(rules, key)`（lib/contents.js:785-809）：对已有 styleSheet 执行 `insertRule(..., cssRules.length)` —— **只追加、不清理**；
- `Themes.select(name)`（lib/themes.js:156-166）：`update(name)` 对当前 contents 重新 `addStylesheetRules(rules, name)` —— 规则插回该 key 元素的**原有位置**；
- `Themes.inject(contents)`（lib/themes.js:185-205）：新章节 view 只注入 `_current` 一个主题；
- `Hook.register`（lib/utils/hook.js:29-38）：无脑 `push`，无去重。

### 3.3 失效链路推演

- 首 White→Black：head = `[whiteEl, blackEl]`，black 靠后，同优先级 !important 冲突由文档序靠后者胜 → black 生效 ✓；
- 再选 White：新规则插回 `whiteEl`（仍在 `blackEl` 之前），文档序不变 → **black 继续胜** ✗；
- React 镀铬层是声明式渲染、已切白 → **顶栏白、正文黑，不同步**；
- 连续滚动：新章节经 `inject` 只含当前主题 → 新章节白、旧章节黑 → **同屏异色**；
- 失效与历史选择顺序强相关（仅「重选」失效）→ 用户体感「有时好有时坏」。

## 四、根因结论

**根因 #1（核心）**：epub.js keyed stylesheet 的「同 key insertRule 追加、跨 key 按 head 文档序决胜」语义缺陷。主题重选 A→B→A 时，旧主题的 style 元素在 `<head>` 文档序中靠后，同优先级 !important 规则冲突永远由旧主题胜出 → 正文 iframe 停留旧主题，而 React 镀铬层（声明式）已切新主题 → 顶栏/正文不同步；新拼接章节只注入当前主题 → 同屏新旧章节异色；同 key 反复设置（如行距切换）规则无界堆积。此前五轮补丁全部修在 React 镀铬层（链路 1/2/5），从未触及链路 3 的 epub.js 注入语义，故反复复发。

**根因 #2（次级）**：`EpubBookController.bindTap()` 在 `load()` 与每次 `handleRelocated`（连续滚动下高频触发）都执行 `hooks.content.register(cb)`，`Hook.register` 无脑 push → 回调数组随滚动无界增长，每次新章节内容加载触发全部重复回调（内存/CPU 双重泄漏），并污染主题注入共用的同一 hooks 通道。

## 五、根治方案（手术刀式，不改 node_modules）

**关键洞察**：epub.js 注入原语中只有 `Contents.addStylesheetCss(css, key)` 是**替换语义**（lib/contents.js:769-775，`styleEl.innerHTML = serializedCss`）。

1. `theme.ts`：`buildRenditionTheme`（规则对象）→ `buildRenditionThemeCss`（CSS 文本），选择器/属性集不变，旧版全删；
2. `EpubBookController.applySettings`：弃用 `themes.register/select`，改为 `themeCss` 更新 + 对 `getContents()` 逐个 `addStylesheetCss(css, 'ireader-theme')` —— **固定单 key**：每个章节文档只有一个主题 style 元素，重复设置整体替换，无文档序竞态、无旧主题残留、无规则堆积；
3. 新章节注入：`hooks.content` 回调统一走 `handleContentsReady`（主题注入 + 点按桥接），不依赖有缺陷的 `Themes.inject`；
4. `hooks.content` 全生命周期**仅注册一次**（`bindContentPipeline` + `contentPipelineBound` 守卫），`relocated` 只做幂等 `rescanContents()` → 泄漏根治；
5. 字号保持 `themes.fontSize`（override 内联样式 + overrides hook 覆盖新章节，该路径无缺陷）。

复杂度变化：**降**（删除一条缺陷路径 + 两条 hooks 通道合并为一次注册，无新增概念）。

## 六、回归验证

- `theme.test.ts`：`buildRenditionThemeCss` 输出断言（html 注入 / 子元素行距 / !important）；
- `EpubBookController.test.ts` 新增回归：
  - 单 key 注入 + `themes.register/select` 零调用；
  - **A→B→A 重选回归**：每次注入同一 key，末次为最新主题；
  - **hooks.content 仅注册一次**：5 次 relocated 后 register 调用数仍为 1；
  - 连续滚动新章节 view 注入当前主题 CSS + 点按桥接直挂；
- 结果：reader 相关 2 文件 23/23 通过；全量 26 文件 194/194 全绿；前后端 `tsc --noEmit` 通过；commits f76ac53 + f418952 已 push main，触发 GitHub Actions CI/CD。
