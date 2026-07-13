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
 *   1) 核心策略：CSS Multi-column 增量加载 + 连续内容缓冲区
 *   2) initContentBuffer：从指定章节开始加载内容到 column 容器
 *   3) appendNextContent：翻到末尾时自动追加下一章内容（增量加载）
 *   4) prependPrevContent：翻到开头时自动插入前一章内容（向前增量）
 *   5) 移除废弃的 epubjs 代码（loadEpub、readerRef、renditionRef 等）
 *   6) 移除旧的分页算法（pageContainerRef 行数推算）
 *   7) 移除废弃的 PageTurnCanvas 组件
 *   8) 翻页样式改为 scroll-behavior: smooth 滑动翻页
 *   9) 纯 DOM 渲染内容，无需 setState 刷新整章内容，性能大幅优化
 * 2.7.0 (2026-07-13): [FIX+REDESIGN] 翻页模式完全重写（ReadiumCSS 横向滚动分页模型）
 *   1) 移除错误且臃肿的"增量列分页引擎"（columnPageRef/columnContentRef/initContentBuffer/
 *      appendNextContent/prependPrevContent/recalculatePagination 等全部删除）
 *   2) 修复三大 bug：①切换翻页跳回开头 → 改用 charOffsetRatioRef 跨模式按位置比例恢复
 *   ③翻页失效 → 采用 column-fill:auto + overflow-x:auto 原生横向滚动，翻页=scrollLeft±clientWidth
 *   ④之前一次翻一章 → 现逐页（一屏一页）精确翻页
 *   3) 连续跨章：章末自动接下一章首（比例0.85衔接），章首自动接上一章末（比例0.15）
 *   4) EPUB/TXT 翻页统一渲染管道：EPUB 保留图片/原始 HTML 排版（sanitizeEpubHtml），TXT 文本渲染
 *   5) 新增 paginated-scroll CSS：隐藏滚动条、章节标题/图片/表格排版复用 .epub-content 规则
 * 2.7.1 (2026-07-13): [BUGFIX] 修复 index.css 全局样式被误删 — 恢复 Tailwind 指令/主题变量/交互反馈
 * 2.7.2 (2026-07-13): [FIX] 部署脚本修复（macOS 本地部署可正常启动服务）
 *   1) start_service 去除硬编码 systemd 启动（macOS 无 systemd），改为跨平台「后台进程+PID 文件」启动
 *   2) do_deploy 不再从源码拷贝 pnpm 软链 node_modules（导致 epub 嵌套依赖断链），改为目标目录本地 pnpm install --prod 生成自包含依赖
 *   3) backend/package.json 增加 pnpm.onlyBuiltDependencies: [better-sqlite3]，install 时自动编译原生模块（修复 better_sqlite3.node 缺失）
 *   4) 清理 do_deploy 中重复的"拷贝 frontend"日志
 */
/**
 * 2.8.1 (2026-07-13): [BUGFIX] 根治"打开书籍持续加载中" + 清理 EPUB 自研渲染残留死代码
 *   1) 根因：第9轮 EPUB 重构（2.8.0）引入 epub.js 的 EpubViewer 组件时，旧的自研"text+CSS column"
 *      EPUB 渲染区块（ReaderPage.tsx 2197-2292 行）被遗漏删除，两套 EPUB 视图同条件
 *      (book?.format==='epub') 同时挂载，旧区块 chapterLoading 遮罩持续显示"加载中"并与新视图叠加。
 *   2) 删除旧 EPUB 渲染区块及其专属死代码：epubDisplayHtml 状态、sanitizeEpubHtml 函数、
 *      loadChapterContent/preloadNextChapters 中的 epubHtml 分支、preloadedChaptersRef 的 html 字段。
 *   3) 现 EPUB 仅由 EpubViewer（epub.js）统一渲染，display() 成功即解除自身 loading，无双重渲染。
 *   4) 净减 151 行，tsc --noEmit 与 vite build 均通过。
 */
export const APP_VERSION = '2.8.3';
/**
 * 2.8.3 (2026-07-13): [BUGFIX] 修复 2.8.0 重构引入的阅读器交互三大回归
 *   1) 上一章/下一章按钮失效（EPUB）：浮动翻页按钮原调用 goToNextChapter/goToPrevChapter（章节列表导航），
 *      对 epub.js 内部渲染的 EPUB 内容零响应 → 改为 EPUB 走 epubPageControlRef.current.next()/prev()。
 *   2) 点击空白浮窗消失：EpubViewer 的 iframe 吞掉点击，父层 handleTapReader 收不到 →
 *      在 EpubViewer 内加透明覆盖层捕获点击并转发 onTap（stopPropagation 避免冒泡双重触发）。
 *   3) 移动端持续"加载中"：epub.js 在容器尺寸为 0 时 display() 永不 resolve →
 *      加容器尺寸守卫（ResizeObserver + rAF 重试）+ 15s 超时兜底提示，杜绝永久加载。
 *   4) 附带修复线上后端静态目录解析错误（__dirname 回溯少一级导致 frontend/dist 404 → 500 白屏）。
 */
