/**
 * ireader 版本配置
 * 
 * 版本号规则：a.b.c
 *   a（主版本号）：大范围架构重构、技术栈升级、破坏性API变更 → a+1，b和c归零
 *   b（次版本号）：新增功能特性、用户体验优化、非破坏性功能开发 → b+1，c归零
 *   c（修订号）：Bug修复、性能优化、微小调整 → c+1
 * 
 * 更新主版本号（a）时，一般涉及 Git 分支切换。
 * 每次开发完成后，在提交前根据本次改动类型更新对应位。
 * 
 * ...（历史版本号列表保持不变，在最后追加一行新版本记录）
 * 
 * 2.5.1 (2026-07-12): CSS multi-column 翻页全面替换自建分页引擎 — A1方案落地
 * 2.6.0 (2026-07-12): [FEATURE] 增量列分页引擎 — 翻页不再一次翻一章，实现逐页翻页
 * 2.7.0 (2026-07-13): [FIX+REDESIGN] 翻页模式完全重写（ReadiumCSS 横向滚动分页模型）
 * 2.7.1 (2026-07-13): [BUGFIX] 修复 index.css 全局样式被误删
 * 2.7.2 (2026-07-13): [FIX] 部署脚本修复
 * 2.8.1 (2026-07-13): [BUGFIX] 根治"打开书籍持续加载中" + 清理 EPUB 自研渲染残死代码
 * 2.14.0 (2026-07-15): [FEAT+FIX] EPUB 离线归档 + TTS 逐段管线 + 部署依赖修复 + 移动端手势重构
 * 2.15.3 (2026-07-15): [BUGFIX] 修复朗读与文章位置不同步 + 反复播放从开头开始
 * 2.15.5 (2026-07-16): [BUGFIX] 修复滚动模式自动加载下一章时替换而非追加内容
 * 2.16.0 (2026-07-16): [FEATURE] EPUB 滚动模式支持自动加载下一章
 * 2.17.0 (2026-07-28): [REFACTOR] Phase 1 基础抽象层 — ReaderEngine 接口 + ReadingPosition 类型 + useReadingPosition hook
 * 2.28.0 (2026-07-29): [REFACTOR] ReaderPage 瘦身 1995→577 行，提取 SearchOverlay/TtsOverlay/useCacheManager/useTtsSession/stripHtml
 * 2.29.0 (2026-07-29): [REFACTOR] ttsPlayer.ts 拆分 1391→737 行，分离调度器(ttsScheduler)/文本处理(ttsTextProcessor)/全局状态(ttsGlobalState)
 * 2.30.0 (2026-07-29): [REFACTOR] 提取 Media Session + heartbeat 为 ttsMediaSession.ts，ttsPlayer.ts 738→669 行
 * 2.31.0 (2026-07-29): [FEAT] 迭代A — downloadSession集成批量下载(续传) + 离线包stale UI提示 + playbackRate倍速控件
 * 2.32.0 (2026-07-29): [FEAT] 迭代B — Design tokens CSS变量体系(7大类) + 统一组件库Button/Toast/Modal，替换全部原生alert/confirm
 * 2.33.0 (2026-07-29): [FEAT] 迭代B-2 — 页面级按钮批量迁移至Button组件（BookshelfPage/SettingsPage/LoginPage 共25处）
 * 2.33.1 (2026-07-29): [REFACTOR] 迭代B-3 — 清扫8个组件的硬编码颜色残留(118处)→ios语义色，新增warning-hover token
 * 2.34.0 (2026-07-29): [REFACTOR] 迭代B-4 — UploadQueue自包含弹层迁移至统一Modal体系，Modal新增panelClassName/bodyClassName扩展点
 * 2.35.0 (2026-07-29): [REFACTOR] 迭代B-5 — 6个文件12处原生动作按钮迁移至Button组件，Button新增warning变体
 * 2.36.0 (2026-07-29): [REFACTOR] 迭代B-6 — IconButton组件落地（5尺寸×4变体）+ ReaderControlPanel/ReaderTopBar控件迁移 + TtsQueuePanel/BatchActionBar提取
 * 2.36.1 (2026-07-29): [BUGFIX] 修复TTS朗读状态不同步（useTtsSession双状态源）+ 翻页模式scrollTo目标容器错误
 * 2.37.0 (2026-07-29): [REFACTOR] 迭代B-7 — TxtReaderView分页进度修复 + useTtsSession死状态移除 + Button新增pill变体/xs尺寸/active属性 + ReaderTopBar/ReaderControlPanel 20处迁移
 * 2.38.0 (2026-07-29): [REFACTOR] 迭代B-8 — 8个文件23处原生button全量迁移至Button/IconButton；Button新增row/success/accent变体+justify属性，IconButton新增warning变体；BatchAction改用variant语义化；清理Layout硬编码色值
 * 2.39.0 (2026-07-30): [REFACTOR] 迭代B-9 — SettingsPage 9处原生button迁移至统一组件体系，新增ToggleSwitch组件，Button justify扩展，硬编码颜色清零
 * 2.40.0 (2026-07-30): [BUGFIX] 修复4个核心功能缺陷 — 手势交互全模式启用+TTS首次播放init+初始加载setPosition+进度恢复percentage/100
 * 2.41.0 (2026-08-01): [FEATURE] 移动端优先 iOS 原生观感重构 — 底部透明Dock(书架/图书管理/设置)+图书管理页(上传/批量选择/预合成语音)+横向滑动TabView容器+TDD测试
 * 2.42.1 (2026-08-01): [PERF] 进一步code-split — LibraryPage懒加载拆chunk,提取PageFallback复用组件消重复,主bundle 340KB→334KB
 * 2.44.0 (2026-08-01): [REFACTOR+FEATURE] 阅读界面整体移除重建 — Apple Books 风格 EPUB 阅读器（四主题/aA面板/目录抽屉/全局页码/CFI断点续读/翻页动画）
 * 2.45.0 (2026-08-01): [FEATURE] 阅读器迭代2 — 全书搜索/书签/垂直滚动模式/CSS 3D书页翻转动画
 * 2.46.0 (2026-08-01): [FEATURE] 阅读器 TXT 支持 — EPUB/TXT 统一渲染管线（TXT章节文本→epub.js HTML Feed，复用翻页/主题/字号/滚动/进度/书签全能力）
 * 2.47.0 (2026-08-01): [FEATURE] 书签云同步 — 后端 bookmarks 表+GET/PUT同步API（user_id/book_id/cfi唯一键+全量diff合并）+ 前端 useBookmarks 拉取合并/变更推送，换设备不丢书签
 * 2.47.1 (2026-08-01): [FIX] 打开书籍卡死/加载失败 — epub.js URL 源补尾部斜杠走目录流式模式（按需请求 zip 内部条目），替代整包 zip binary 下载超时
 * 2.48.0 (2026-08-01): [REFACTOR] 阅读界面布局修复 — ①阅读页不再渲染底部 Dock（消除遮挡空白）②顶栏菜单移入底栏（顺序：返回书库｜目录｜书名｜书签·搜索·aA）③删除左右翻页模式与翻页动画，固定垂直滚动④删除全屏点按层，正文点击改用 epub.js click 桥接显隐底栏（修复滚动手势被拦截）
 * 2.48.1 (2026-08-01): [BUGFIX] EPUB 内部资源 401 — epub.js iframe 子资源（图片/CSS/字体）无法附加 Authorization header，后端 /api/books/:id/file/* 由 requireAuth 放宽为 optionalAuth（带 token 仍校验归属，无 token 放行；整书下载 /:id/file 保持鉴权）
 * 2.49.0 (2026-08-01): [FEATURE] 阅读器滚动模式重构 — 由 scrolled-doc（单章节整页替换）切换为 scrolled-continuous（连续滚动）：相邻章节拼接进同一滚动容器，滚到底自然进下一章、滚到顶回上一章，跨章节无缝衔接（典型阅读器行为）；点按桥接改用 hooks.content 官方扩展点直挂内容文档 pointer 事件，根治「点击屏幕弹出菜单」失效
 * 2.49.1 (2026-08-01): [BUGFIX] 修复连续滚动失效 — renderTo 补 manager:'continuous'（epub.js 仅凭 flow:'scrolled-continuous' 会回退 DefaultViewManager 单章模式，表现为只能看一章）；点按桥接三路保障（hooks.content + getContents + relocated 重绑）+ click 兜底防双触发
 * 2.49.2 (2026-08-01): [BUGFIX] 根治点击弹出菜单失效 — renderTo 补 allowScriptedContent:true。根因：epub.js iframe 默认 sandbox="allow-same-origin"（无 allow-scripts），WebKit bug 218086 证实此类 sandbox iframe 内事件无法被父页面 contentDocument 监听器捕获，历次 pointer/click 直挂在 iOS 全部失效；补 allow-scripts 后父页面可正常监听 iframe 内点击
 * 2.50.0 (2026-08-01): [FEATURE+FIX] 阅读器全屏能力（PWA standalone+iOS meta+菜单全屏按钮）｜书架排序统一为最近阅读优先→书名次级（前后端+离线缓存 lastReadAt）｜Dock 加 translateZ(0) 规避 iOS Safari fixed+backdrop-filter 滚动错位｜阅读器卸载时 flush 进度到服务端（保障书架最近阅读排序实时更新）
 * 2.51.1 (2026-08-01): [BUGFIX] 书架排序加固 — 后端 lastReadMap 查询补 userId 过滤（消除全表扫描跨用户隐患）；前后端排序改用时间戳数值比较（已读按 lastReadAt 降序在前，未读按书名升序在后，不受 ISO 格式/locale 影响）；新增未读多本排序/混合场景前端测试
 * 2.52.0 (2026-08-01): [FEATURE] 顶部导航精简 + Dock iOS 化 — 移除顶栏与底部 Dock 重复的「书架/设置」入口（顶栏仅保留语音合成与桌面用户区）；Dock tab 弃用 Button ghost 椭圆背景（固定高度致点击胶囊盖不住图标），重写为 iOS 原生 Tab Bar：无背景、选中蓝色图标+文字+底部指示条、按压弹性缩放
 * 2.53.0 (2026-08-02): [PERF] 书架加载提速 1552x — 根治书架加载慢（N+1 请求 × 无索引全表扫描）：新增 POST /api/books/stats/batch 批量聚合接口（GROUP BY 一次取全部书籍统计，与书数量无关）替代逐本 GET /:id/stats（252 本 → 1 请求）；BookshelfPage 改为批量拉取；db/init.ts 补 7 组幂等索引（books.user_id / reading_progress(user_id,book_id) / reading_progress(book_id) / book_chapters(book_id) / tts_generation_jobs(book_id,user_id) / book_content_cache(book_id,user_id) / tts_cache(user_id,book_id)），EXPLAIN 全 SCAN→SEARCH；getBookCacheStats 去重复 book_chapters 查询（入参复用 totalChapters）
 * 2.56.5 (2026-08-02): [BUGFIX+REFACTOR] 阅读主题同步顽疾根治 — 根因：epub.js keyed stylesheet「同 key insertRule 追加、跨 key 按 head 文档序决胜」（contents.js:746/785 + themes.js:156），主题重选 A→B→A 时旧主题元素文档序靠后永远胜出 → 正文停留旧主题而 React 镀铬层已切新主题（顶栏/正文不同步），连续滚动新旧章节异色、规则无界堆积。手术：弃用 themes.register/select 缺陷路径，改用 addStylesheetCss 固定单 key（ireader-theme）整体替换语义（contents.js:769 唯一替换原语）+ hooks.content 全生命周期仅注册一次（根治 relocated 高频重复注册回调泄漏），主题注入与点按桥接合并为统一内容管线 handleContentsReady；buildRenditionTheme 对象版 → buildRenditionThemeCss 文本版（旧版全删）；新增 A→B→A 重选/单次注册/新章节注入回归测试；RCA 落盘 docs/reader-theme-sync-rootcause.md
 * 2.56.4 (2026-08-02): [BUGFIX] 阅读背景设置异常根治 — ①buildRenditionTheme 新增 html 根元素背景注入（EPUB 书籍 CSS 常在 html 设背景色，只注 body 会让书自带底色在正文四周/章节间隙透出 → 设置主题色后版面不变/顶栏不一致）；②ReaderPage attachReader（rendition 就绪）时用 settingsRef 重放最新设置（加载期间切主题不再被吞，正文不再停留在挂载时旧主题快照）；新增 html 注入断言 + 切主题后 applySettings 最新主题断言，全量 191/191 绿
 * 2.56.3 (2026-08-02): [REFACTOR] 顶栏主题同步收敛 — 状态栏覆盖层 + html/body 根背景 + theme-color 三处同步收敛为 useReaderChromeTheme 单一 hook（返回声明式 statusBarStyle + 内部初始值还原），ReaderPage 瘦身，行为不变，无竞态；新增 hook 单测覆盖 声明式样式/三处同步/切换更新/退出还原初始值
 * 2.56.2 (2026-08-02): [BUGFIX] 顶栏颜色改为声明式渲染驱动 — 新增状态栏安全区覆盖层（env(safe-area-inset-top) 高度、背景=主题色、由 React 渲染直接驱动）：页内切主题顶栏即时同步（不再依赖退出重进）、进入/退出天然一致；html/body 根背景还原策略改用 ref 记录首次挂载初始值，根治「多次切主题后退出还原成倒数第二次主题色」的污染竞态（对应：切主题顶栏不变/进出不一致现象）；配套新增 3 个回归测试
 * 2.56.1 (2026-08-02): [BUGFIX] 沉浸引导文案精确化 — 区分「已添加到主屏幕但从 Safari 打开」（非 standalone，状态栏归系统管，浅色模式白底黑字）与「从主屏幕图标进入」（standalone+black-translucent，状态栏透明透出页面根背景）；引导条提示改为「从主屏幕的 iReader 图标进入阅读」，避免已添加主屏幕的用户误以为还要再添加
 * 2.56.0 (2026-08-02): [BUGFIX] 根治深色阅读顶部固定白色 — ①阅读主题同步扩展为 html/body 根背景：iOS Safari 橡皮筋回弹/PWA 状态栏透明区/地址栏动画透出的根背景随主题（深色不再露出白色横条，截图白条根因消除），退出阅读还原；②深色主题且非 standalone 时显示「添加到主屏幕」沉浸阅读引导条（iOS 系统状态栏仅 standalone+black-translucent 可隐藏，网页无法直接改系统栏）；③SW 缓存版本 v2→v3 强制刷新，杜绝用户加载旧版
 * 2.55.3 (2026-08-02): [FEATURE] 深色模式对标微信读书 — 深色主题（gray/black）chrome 背景 alpha 0.94→0.98、浅色主题 0.94→0.96：底栏/面板不再依赖 backdrop-filter 也呈深色，blur 失效时透出正文的问题消除；配合既有黑底白字与 theme-color 状态栏同步，深色阅读体验对齐主流阅读器
 * 2.55.2 (2026-08-02): [REFACTOR] 批量/单本接口逻辑去重 — 提取 deleteBookForUser（globalResourceService，查归属→删进度→减引用→删记录，返回 found/removed）供 DELETE /:id 与 batch-delete 复用；提取 resolveTtsConfig（ttsGenerationService，enabled/voice/speed 解析 + 请求级覆盖）供 tts-generate 与 batch-tts-generate 复用；行为不变，重复实现收敛为单一事实来源
 * 2.55.1 (2026-08-02): [BUGFIX] 阅读器设置修复 — ①行距三档（紧凑/标准/宽松）生效：buildRenditionTheme 的 line-height 由仅注入 body 扩展到段落/标题子元素选择器组（EPUB 书籍 p 显式 line-height 曾覆盖 body 继承值，导致行距无效果）；②顶栏随阅读主题：ReaderPage 动态同步 theme-color meta 为阅读主题背景色，浏览器/PWA 顶栏不再恒为默认色，退出阅读还原
 * 2.55.0 (2026-08-02): [PERF+FEATURE] 批量操作 N+1 收敛 — 新增 POST /api/books/batch-delete / batch-cache / batch-tts-generate 三个批量接口（单请求替代前端逐本调用，删除 N 本 = 1 请求）；LibraryPage/BookshelfPage 六处 Promise.all 逐本调用全部收敛为单请求，删除/缓存/语音反馈展示实际成功数量；批量接口含 500 本上限与逐本失败隔离
 * 2.54.0 (2026-08-02): [FEATURE] 批量选择体验升级 — 勾选框改独立圆形控件（修复长书名书勾选框被 Button 默认样式拉伸成椭圆、垂直居中错位）；批量动作栏从列表底部移至顶部吸顶（无需滚动到底）；图书管理页批量动作丰富为 删除/缓存离线包/预合成语音 并接通真实 API；书架页批量栏同步吸顶并新增缓存离线动作
 * 2.57.0 (2026-08-02): [FEATURE] 阅读界面滚动阻尼（1-10 级，默认 3）— 新增 scrollDamping 纯函数模块（clamp/阻尼系数线性映射 1→0.9…10→0.25/wheel 拦截器 + deltaMode 归一化）纳入 ReaderSettings 单一数据源；EpubBookController 内容就绪时为 iframe 内容文档装配阻尼（级别经 getLevel 闭包动态读取，设置即时生效，destroy 统一卸载）；aA 阅读设置面板新增 1-10 阻尼滑块（轻/重 + 实时档位）。阻尼仅作用 wheel（鼠标/触控板），原生触摸滚动保持不动（保护历经精修的 epub.js 连续滚动栈）
 * 2.58.0 (2026-08-02): [FEATURE+REFACTOR] 滚动阻尼升级为全局设置 + 触摸支持（移动端主场景）— 阻尼设置从阅读 aA 面板移除，迁入「设置」页外观区块（1-10 滑块，localStorage 全局持久化 ireader_scroll_damping）；scrollDamping 模块新增触摸惯性引擎（touchmove 拦截原生滚动按阻尼系数缩放 + touchend 后随级别递增摩擦的 rAF 惯性动量 + 方向锁定仅接管垂直手势、水平与多指交还原生 + touch-action:pan-x pinch-zoom 保障真机 preventDefault 可靠）；手动 scrollTop 仍触发原生 scroll 事件，epub.js 连续章节加载/relocated/点按桥接不受影响；ReaderSettings 移除 scrollDamping 字段（单一数据源收敛为全局设置），EpubBookController 经 loadScrollDamping 闭包动态读取全局值
 * 2.58.1 (2026-08-03): [BUGFIX] 修复滚动阻尼调坏滚动功能 — 根因：epub.js scrolled-continuous（fullsize=false）真实滚动容器是父页面 div.epub-container（overflow-y:scroll），触摸/滚轮事件在 iframe 内容文档派发；此前阻尼把滚动目标写成 iframe 内容文档 documentElement（不滚动）又 preventDefault 阻止原生滚动 → 垂直滚动彻底失效。修复：attachScrollDamping 改为 (doc, scrollTarget, getLevel) 事件与滚动目标分离，controller 解析 .epub-container 传入；touch-action 改设在真实滚动容器并 WeakMap 引用计数管理还原（多 iframe 共享容器不污染）
 * 2.59.0 (2026-08-14): [FEATURE+DESIGN] 阅读页顶部书眉顶栏主题化（顶栏与读书主题一致）— 新增 ReaderTopBar 主题色书眉（Apple Books 风格：返回书架｜书名居中｜aA 快捷入口，chromeBackground/chromeColor 随主题注入、与底栏同语言半透明 blur+分隔线，padding-top 走 env(safe-area-inset-top)——standalone 下顶栏从屏幕顶开始与页面一体，Safari 浏览器模式自然落在系统状态栏下方）；ReaderChrome 扩展 side=top（自顶滑入/滑出），与底栏共用 chromeVisible 单状态源联动显隐、进入阅读即显示；原悬浮沉浸引导胶囊移除，重构为顶栏内「沉浸式阅读」说明入口（非 standalone+深色主题时显示，浮层说明 iOS 系统状态栏限制与主屏幕图标进入方式）；2.51.0 移除的返回书架入口回归
 * 2.59.1 (2026-08-14): [BUGFIX+ROLLBACK] 顶栏方案回退 + 状态栏主题同步加固 — 用户实测反馈：应用顶栏（返回/书名/aA）多余，真正不一致的是其上方系统状态栏（standalone 下升级后首次进入为主题色，再次进入恢复白色）。回退：删除 ReaderTopBar 与 ReaderChrome side 扩展（恢复无应用顶栏架构），沉浸说明浮层改回原悬浮引导胶囊，chromeVisible 恢复初始隐藏。加固：①useReaderChromeTheme 新增 pageshow/visibilitychange 监听——iOS standalone 快照恢复/bfcache/后台切回时页面不重载、effect 不重跑，根背景若停留还原态（白）则状态栏/顶部持续白色，现于页面恢复时立即重放主题背景；②ReaderPage 错误态（书籍加载失败/格式不支持）由 bg-ios-bg 白底改为阅读主题背景，消除加载失败时状态栏露白；新增页面恢复兑底单测 + 错误态主题化断言
 */
export const APP_VERSION = '2.59.1';
