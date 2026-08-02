# 阅读界面主题同步顽疾 — 根因分析报告（RCA）

> 版本：v2.56.5 ｜ 日期：2026-08-02 ｜ 修复 commit：f76ac53 ｜ 状态：已根治，194/194 测试全绿

## 一、症状（用户报告）

1. 更改阅读背景（主题），顶栏（状态栏/镀铬层）不同步；
2. 更改了顶栏相关代码后，阅读界面（正文背景）又不同步；
3. 「各种奇奇怪怪」：有时同步有时不同步、同一屏不同章节颜色不一致、重选旧主题后正文不变色。

## 二、复现步骤

前置：任意 EPUB 书籍，连续滚动模式（scrolled-continuous）阅读页。

1. 打开 aA 面板，依次切换主题：白 → 黑 → 灰 → 棕褐（每个主题都首次选择，正文/顶栏均正常同步）；
2. **再次选择「白」**（重选已用过的主题）：
   - 预期：正文背景恢复白色；
   - 实际：**正文保持上一个深色主题不变**，而顶栏/底栏/面板（React 声明式渲染）已切白 → 顶栏与正文不同步；
3. 在「不同步」状态下垂直滚动跨过章节边界：
   - 实际：**新拼接进来的章节显示正确的新主题，旧章节保持旧主题** → 同屏两个章节两种颜色；
4. 失效与否取决于历史选择顺序（首次选每个主题必正常，只有「重选」失效）→ 表现为间歇性、难以捉摸。

## 三、定位过程

### 3.1 排查范围收敛

阅读主题涉及五条同步链路，逐条复核（git log 显示 v2.55.1~v2.56.4 五个补丁都修在前两条）：

| # | 链路 | 机制 | 结论 |
|---|------|------|------|
| 1 | React 镀铬层（状态栏覆盖层/底栏/面板/页面根背景） | `themeSpec` → 声明式 style | ✅ 无缺陷（v2.56.2/2.56.3 已修好） |
| 2 | html/body 根背景 + theme-color meta | `useReaderChromeTheme`（初始值还原） | ✅ 无缺陷（v2.56.3 已修好） |
| 3 | 设置时序（加载期间切主题被吞） | `settingsRef` 重放（attachReader） | ✅ 无缺陷（v2.56.4 已修好） |
| 4 | 字号 | `themes.fontSize` → override 内联样式 + overrides hook | ✅ 无缺陷 |
| 5 | **iframe 内章节文档背景/颜色/行距** | `themes.register(name)+select(name)` | ❌ **病灶所在** |

### 3.2 源码取证（node_modules/epubjs，禁改）

- `lib/contents.js:746-761` `_getStylesheetNode(key)`：keyed style 元素 `epubjs-inserted-css-<name>` 首次创建时 append 到 head；**已存在则保持原位返回**；
- `lib/contents.js:785-809` `addStylesheetRules(rules, key)`：对已有 styleSheet 执行 `insertRule(..., cssRules.length)` —— **只追加、不清理**；
- `lib/themes.js:156-166` `Themes.select(name)`：`update(name)` 对当前 contents 重新 `addStylesheetRules(rules, name)` —— 插回该 key **原有位置**；
- `lib/themes.js:185-205` `Themes.inject(contents)`：连续滚动新拼接的章节 view 只注入 `_current` 一个主题；
- `lib/utils/hook.js:29-38` `Hook.register`：无脑 push（次级根因取证）。

### 3.3 失效机理推演（与复现现象逐一对应）

- 主题首次选择按顺序创建元素：选 白→黑 后 head = `[whiteEl, blackEl]`，black 靠后，CSS 同优先级 !important 冲突由文档序靠后者胜出 → black 正确显示 ✓；
- 再选白：新规则插回 whiteEl（**仍在 blackEl 之前**）→ black 继续赢 ✗ —— 对应复现步骤 2「重选失效」；
- 失效取决于选择顺序 —— 对应症状 3「有时同步有时不同步」；
- 新章节经 `inject` 只注入当前主题、旧章节 stuck —— 对应复现步骤 3「同屏异色」；
- React 镀铬层是声明式即时渲染、正文走上述缺陷路径 —— 对应症状 1/2「顶栏与正文互相不同步」。

## 四、根因结论

- **根因 #1（核心）**：epub.js keyed stylesheet 的「同 key insertRule 追加、跨 key 按 head 文档序决胜」语义缺陷。主题重选时旧主题 style 元素保持原位且文档序靠后的元素永远胜出 → 正文停留旧主题；连续滚动下新旧章节注入路径不一致 → 同屏异色；同 key 反复设置规则无界堆积。**这是「更改阅读背景不同步」的唯一根因，此前五轮补丁均未触及。**
- **根因 #2（次级）**：`EpubBookController.bindTap()` 在 `load()` 与每次 `handleRelocated`（滚动高频触发）都 `hooks.content.register`，回调数组随滚动无界增长（内存/CPU 双重泄漏），污染主题注入共用的同一 hooks 通道。
- **归属模块**：`frontend/src/reader/EpubBookController.ts` + `frontend/src/reader/theme.ts`（epub.js 库缺陷在 node_modules 不可改，但封装层选错了注入原语）。

## 五、根治方案（手术刀式，不改 node_modules）

**关键洞察**：epub.js 注入原语中只有 `Contents.addStylesheetCss(css, key)` 是替换语义（`lib/contents.js:769-775` `styleEl.innerHTML = serializedCss`）。

1. `theme.ts`：`buildRenditionTheme`（规则对象）→ `buildRenditionThemeCss`（CSS 文本），旧版全删；
2. `applySettings`：弃用 `themes.register/select`，改 `themeCss` 更新 + `getContents()` 逐个 `addStylesheetCss(css, 'ireader-theme')` —— 固定单 key，每个章节文档只有一个主题 style 元素，重复设置整体替换，无文档序竞态/无残留/无堆积；
3. 新章节注入与点按桥接合并为统一入口 `handleContentsReady`，不依赖有缺陷的 `Themes.inject`；
4. `hooks.content` 全生命周期仅注册一次（`bindContentPipeline` + 守卫），`relocated` 只做幂等 `rescanContents()` —— 泄漏根治；
5. 字号保持 `themes.fontSize`（无缺陷路径，不动）。

复杂度变化：**降**（删除一条缺陷路径，两条 hooks 通道合并为一次注册，无新增概念）。

## 六、回归验证

- `theme.test.ts`：`buildRenditionThemeCss` 输出断言（html 注入/子元素行距/!important）；
- `EpubBookController.test.ts` 新增 4 个回归：
  1. 单 key 注入 + `register/select` 不再被调用；
  2. **A→B→A 重选回归**：每次注入同一 key，末次为最新主题；
  3. **hooks.content 仅注册一次**：5 次 relocated 后 register 调用数仍为 1；
  4. 连续滚动新章节 view 注入当前主题 CSS + 点按桥接直挂；
- 结果：前端 `tsc --noEmit` ✅、后端 `tsc --noEmit` ✅、`vitest run` 26 文件 194/194 ✅、commit f76ac53 已 push（触发 CI/CD）。
