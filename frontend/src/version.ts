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
 */
export const APP_VERSION = '2.49.2';
