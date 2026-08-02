# 阅读界面主题同步顽疾 — 根因分析与根治方案（RCA）

> 版本：v2.56.5 ｜ 日期：2026-08-02 ｜ 状态：已根治并回归验证

## 1. 症状（用户报告）

- 更改阅读背景，顶栏（状态栏/镀铬层）不同步；
- 更改了顶栏相关代码后，阅读界面（正文背景）又不同步；
- 各种「奇奇怪怪」：有时同步有时不同步、同一屏不同章节颜色不一致、重选旧主题失效。

历史修复记录（均未根治）：v2.55.1（行距+theme-color）→ v2.56.0（html/body 根背景+SW 刷新）→ v2.56.2（状态栏声明式覆盖层）→ v2.56.3（useReaderChromeTheme 收敛）→ v2.56.4（html 注入 + settingsRef 重放）。**五个补丁全部修在 React 镀铬层与设置重放路径，真正的病灶在 epub.js 主题注入语义。**

## 2. 主题应用的完整链路

| 层 | 机制 | 驱动方式 | 缺陷？ |
|---|---|---|---|
| React 镀铬层（状态栏覆盖层/底栏/面板/页面根背景） | `themeSpec` → 声明式 style | React 渲染 | 无（v2.56.2/2.56.3 已修好） |
| html/body 根背景 + theme-color meta | `useReaderChromeTheme` | 命令式 useEffect，初始值还原 | 无（v2.56.3 已修好） |
| **iframe 内章节文档背景/颜色/行距** | ~~`themes.register(name)+select(name)`~~ | epub.js keyed stylesheet | **有（本次根因）** |
| 字号 | `themes.fontSize` → override 内联样式 | epub.js overrides hook | 无 |
| 设置时序（加载期间切主题被吞） | `settingsRef` 重放 | ReaderPage attachReader | 无（v2.56.4 已修好） |

## 3. 根因 #1（核心）：epub.js keyed stylesheet 的「追加 + 文档序决胜」语义

证据（node_modules/epubjs，禁改，故在封装层规避）：

1. **`Contents._getStylesheetNode(key)`**（lib/contents.js:746-761）：keyed style 元素 `epubjs-inserted-css-<name>` 首次创建时 append 到 head；**已存在时保持原位返回**。
2. **`Contents.addStylesheetRules(rules, key)`**（lib/contents.js:785-809）：拿到已有 styleSheet 后 `insertRule(..., cssRules.length)` —— **只追加、不清理**。
3. **`Themes.select(name)`**（lib/themes.js:156-166）：`update(name)` 对当前 contents 重新 `addStylesheetRules(rules, name)` —— 插回该 key **原有位置**。

由此产生的级联失效：

- 主题首次选择按顺序创建元素：选 white→black 后 head = `[whiteEl, blackEl]`，black 靠后，胜出 ✓；
- 再选 white：新规则插回 whiteEl（**仍在 blackEl 之前**），同优先级 `!important` 冲突由**文档序靠后者胜出** → black 继续赢 ✗。
- **结果：正文停留在旧主题，而 React 镀铬层（声明式）已切新主题 →「改了背景，顶栏变正文不变」。**
- 且失效与选择顺序相关（首次选每个主题都正常，重选旧主题才失效）→ 表现为「有时同步有时不同步」的诡异现象。

并发加重项：

- **连续滚动新拼接章节异色**：`Themes.inject(contents)`（lib/themes.js:185-205）对新 view 只注入 `_current` 一个主题 → 新章节正确、旧章节 stuck 旧主题 → 同屏不同章节不同色。
- **规则堆积**：同一主题名反复设置（如行距三档切换）时旧规则不清理，stylesheet 无界膨胀。

## 4. 根因 #2（次级）：hooks.content 重复注册无界泄漏

`EpubBookController.bindTap()` 在 `load()` 与**每次** `handleRelocated`（连续滚动下滚动重定位即高频触发）都执行 `rendition.hooks.content.register(cb)`；epub.js `Hook.register` 为无脑 push（lib/utils/hook.js:29-38）。滚动 N 次注册 N 个重复回调，每次新章节内容加载触发全部 N 个回调 —— 内存/CPU 双重泄漏，且污染我们主题注入要共用的同一通道。

## 5. 根治方案（手术刀式，不改 node_modules）

**关键洞察**：epub.js 注入原语中只有 `Contents.addStylesheetCss(css, key)` 是**替换语义**（lib/contents.js:769-775 `styleEl.innerHTML = serializedCss`）。

1. `theme.ts`：`buildRenditionTheme`（规则对象）→ `buildRenditionThemeCss`（CSS 文本序列化），选择器/属性集不变。
2. `EpubBookController.applySettings`：弃用 `themes.register/select`，改为 `themeCss` 更新 + 对 `getContents()` 逐个 `addStylesheetCss(css, 'ireader-theme')` —— **固定单 key**：每个章节文档只有一个主题 style 元素，重复设置整体替换，无文档序竞态、无旧主题残留、无规则堆积。
3. 新章节注入：`hooks.content` 回调统一走 `handleContentsReady`（主题注入 + 点按桥接），不依赖有缺陷的 `Themes.inject`。
4. `hooks.content` 全生命周期**仅注册一次**（`bindContentPipeline` + `contentPipelineBound` 守卫），`relocated` 只做幂等的 `rescanContents()` 扫描 —— 泄漏根治。
5. 字号保持 `themes.fontSize`（override → 内联样式 + overrides hook 覆盖新章节，该路径无缺陷）。

复杂度变化：**降**。删除一条缺陷路径（register/select 状态机），点按/主题两条 hooks 通道合并为一次注册；无新增概念。

## 6. 回归验证（TDD）

- `theme.test.ts`：`buildRenditionThemeCss` 输出断言（html 注入 / 子元素行距 / !important）。
- `EpubBookController.test.ts` 新增：
  - 单 key 注入 + register/select 不再被调用；
  - **A→B→A 重选回归**：每次注入同一 key，末次为最新主题；
  - **hooks.content 仅注册一次**：5 次 relocated 后 register 调用数仍为 1；
  - 连续滚动新章节 view 注入当前主题 CSS + 点按桥接直挂。
