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
/**
 * 2.14.0 (2026-07-15): [FEAT+FIX] EPUB 离线归档 + TTS 逐段管线 + 部署依赖修复 + 移动端手势重构
 *   1) [FEAT] TTS 预合成改为消费持久化 content_segments：任务创建时写入逐段记录(tts_generation_segments)，
 *      执行时从 content_segments 读取固定文本不再现场重新切分；新增逐段任务状态(pending/running/completed/failed)
 *      支持失败重试；任务中断后跳过已完成片段；进度基于真实持久化段数计算。
 *   2) [FEAT] EPUB 离线包新增原始 EPUB 归档缓存(IndexedDB epubArchives)，阅读器优先从 IndexedDB
 *      加载本地归档(转 Blob URL 供 epub.js)，离线不依赖网络；IndexedDB 升级至 v4；清理缓存同步删除归档；
 *      切换书籍正确重建数据源并释放 Blob URL；保留无归档时在线回退。
 *   3) [FIX] 部署脚本(deploy.sh)强制重新编译 better-sqlite3，安装后校验 ABI 版本，失败即终止部署。
 *   4) [FIX] 移动端手势三功能重构：CSS touch-action 由 pan-x 改 pan-y(浏览器只接管纵向，横向交 JS)；
 *      浮动菜单移除全屏遮罩阻断(改为单层背景+底部面板)；EPUB iframe 手势挂载增加 DOM 直查回退，
 *      gesture prop 拆分为 onLongPress(开菜单)+onTap(关菜单)。
 */
/**
 * 2.15.3 (2026-07-15): [BUGFIX] 修复朗读与文章位置不同步 + 反复播放从开头开始
 *   1) [FIX] 朗读位置不同步：handleStartTTS 新增从当前阅读位置推算 TTS 分段索引的逻辑。
 *      TXT scroll 模式用滚动比例(可滚动高度)、分页模式用 charOffsetRatioRef、
 *      映射到 player 的 totalChunks 计算起始分段，不再仅依赖过时的 savedTtsProgressRef。
 *   2) [FIX] 重复播放从开头开始：handleStopTTS 不再清除 savedTtsProgressRef.current，
 *      保留位置信息供下次点击「朗读」恢复；同时 handleStartTTS 中阅读位置推算逻辑
 *      作为兜底，确保即使 savedTtsProgressRef 为空也能从正确位置开始朗读。
 *   3) 加 34 行，复杂度不变（逻辑从"仅依赖静态保存值"升级为"实时推算 + 保存值兜底"）。
 */


/**
 * 2.15.5 (2026-07-16): [BUGFIX] 修复滚动模式自动加载下一章时替换而非追加内容
 *   1) 根因：IntersectionObserver 检测到章节末尾时调 goToNextChapter(true)，将 _append=true 传入
 *      navigateToChapter(chapter, true)，但 navigateToChapter 对 TXT 模式仅调 loadChapterContent(chapter)
 *      （未传第4个 _append 参数），导致 _append=undefined → 走替换分支（accumulatedIdsRef.clear + 整章替换），
 *      用户感知为"内容跳变"而非"平滑续读"。
 *   2) 修复：navigateToChapter TXT 分支改为 loadChapterContent(chapter, undefined, undefined, _append)，
 *      让 _append=true 正确传递到追加逻辑（第1146-1151行），内容追加当前章节后面。
 *   3) 验证：tsc --noEmit 全绿。
 */

/**
 * 2.16.0 (2026-07-16): [FEATURE] EPUB 滚动模式支持自动加载下一章
 *   1) 根因：EPUB 的 scrolled-doc 模式一次只渲染一个章节的滚动内容，
 *      之前只有 TXT 模式有 IntersectionObserver + bottomSentinelRef 哨兵
 *      实现自动加载下一章，EPUB 模式下缺少相同机制。
 *   2) 修复：EpubViewer 新增 onScrollBottom 回调，在 scrolled-doc 模式下
 *      监听 iframe 内文档的 scroll 事件，当滚动到距底部不足 100px 时触发回调；
 *      ReaderPage 中接入该回调，调用 navigateToChapter(chapters[idx+1], true)
 *      加载下一章（与 TXT 机制对称）。触发后有 2s 防抖防止重复触发。
 *   3) 验证：tsc --noEmit 全绿。
 */

/**
 * 2.17.0 (2026-07-28): [REFACTOR] Phase 1 基础抽象层 — ReaderEngine 接口 + ReadingPosition 类型 + useReadingPosition hook
 *   1) 新增 frontend/src/reader/types.ts：共享 BookFormat / Chapter 类型
 *   2) 新增 frontend/src/reader/engine/types.ts：ReaderEngine 策略接口（TXT/EPUB 统一抽象）
 *   3) 新增 frontend/src/reader/position/types.ts：ReadingPosition 唯一进度模型 + Input/Update 类型
 *   4) 新增 frontend/src/reader/position/useReadingPosition.ts：阅读位置单一数据源 hook
 *   5) 新增 frontend/src/reader/index.ts：模块 barrel export
 *   6) 新增 useReadingPosition.test.ts：10 个单元测试全绿
 *   7) 验收：tsc --noEmit 通过，vitest 10/10 通过
 */
export const APP_VERSION = '2.22.4';
/**
 * 2.16.3 (2026-07-16): [BUGFIX] 移除有缺陷的 EPUB 滚动监听自动加载，替换为常驻上下章按钮
 *   1) 根因：epub.js scrolled-doc 模式的 iframe 内 scroll 事件监听不可靠（容器/内容尺寸变化等
 *      边界情况导致触发不准确），"滚动到底部自动加载下章"功能经常不生效。
 *   2) 修复：移除 EpubViewer.onScrollBottom 滚动监听代码（清理 scrollCleanupRef + 防抖逻辑）；
 *      移除 ReaderPage 中的 onScrollBottom 回调与 loadingNextChapterRef 门控；
 *      改为在 EPUB 阅读器两侧添加常驻的"上一章/下一章"浮动按钮（半透明 hover 显示），
 *      用户点击跳转，行为可靠、反馈明确。epubjs 无现成 UI 按钮组件，使用 chapterNavRef 跳转。
 *   3) 清理：EpubViewer props 中 onScrollBottom → onPrevChapter/onNextChapter 委托。
 *   4) 验证：tsc --noEmit 全绿。
 */
/**
 * 2.16.2 (2026-07-16): [FIX] 重构建并重新部署 — deploy.sh 超时导致进程中断，手动启动恢复正常
 *   1) deploy.sh 执行过程中因 120s 超时被系统终止，虽然构建+拷贝已完成但进程被杀了。
 *   2) 手动 nohup bash start.sh 启动，服务健康检查通过（HTTP 200）。
 *   3) 验证：curl http://localhost:10000 → 200，/api/health → {"success":true,"status":"ok"}。
 */

/**
 * 2.16.1 (2026-07-16): [FIX] 生产部署修复 — deploy.sh 构建后手动启动服务（上一轮部署后服务未运行）
 *   1) 根因：上一轮 deploy.sh 完成构建拷贝后，手动 nohup 启动但未正确加载 .env 文件，
 *      且进程挂在后台后未验证服务是否正常响应（HTTP 000），用户看到的是旧版 2.15.5 服务。
 *   2) 修复：使用 bash 显式 set -a; source .env; set +a 加载环境变量后启动，服务正常监听端口 10000。
 *   3) 验证：curl 返回 HTTP 200，/api/health 响应 {"success":true,"status":"ok"}，前端 HTML 正常返回。
 */
/**
 * 2.15.1 (2026-07-15): [FIX] 滑动翻页根因修复 — passive: true → false
 *   根因：touch 事件监听器的 passive:true 与 touch-action:none 矛盾，
 *   在移动端浏览器内核中导致 touchmove 坐标被冻结，swipe 检测 dx/dy 始终≈0。
 *   修复：passive: true → false（4 处），让浏览器完整传递移动端 touch 序列。
 */
/**
 * 2.15.0 (2026-07-15): [REFACTOR] 菜单触发方式重构 + 手势系统简化
 *   1) 移除长按菜单：useGesture 删除 onLongPress + longPressTimer 状态机，EpubViewer 移除 onLongPress prop
 *   2) 新增左下角半透明汉堡图标（☰）：点击 toggle 浮动操作面板，opacity 0.5/hover 0.8
 *   3) CSS touch-action pan-y → none：彻底禁止浏览器插手，JS 全权处理 swipe/tap
 *   4) 测试更新：移除 2 个长按测试用例，更新 GESTURE_CONFIG 断言。净减 73 行，复杂度下降
 */
/**
 * 2.12.0 (2026-07-14): [FEAT] 文字选择复制功能 + deploy.sh 权限防御
 *   1) 复制选中文字：浮动操作面板中新增"复制"按钮，支持 Clipboard API 写入剪贴板 + Toast 反馈
 *   2) deploy.sh 防御：清理旧 app 目录前先 chmod -R u+w，解决 pnpm hardlink 只读权限导致 rm/cp 失败
 *   3) 上轮延续：滑动翻页箭头指示器、长按触觉反馈、文字选择与手势互斥
 */
/**
 * 2.11.2 (2026-07-14): [BUGFIX] 修复 epub 模式下移动端/桌面端滑动翻页及长按菜单均无法使用
 *   1) 根因：EpubViewer 中 attachGesture() 用 `!contents.document` 守卫判断
 *      rendition.getContents() 的返回值，但运行时实际返回 Contents[]（数组），
 *      数组无 .document 属性 → 守卫永远为 true → attachToEpubContents 从未被调用，
 *      手势监听（touch/mouse）均未挂载到 iframe document 上。
 *   2) 修复：将守卫改为先标准化为数组再判断 list[0]?.document，
 *      确保手势正确挂载。attachToEpubContents 本身已兼容数组入参。
 *   3) 影响范围：所有设备（移动端 + 桌面端）的 epub 阅读模式。
 *      ⚠️ 上一轮 2.11.1 的"桌面端 mouse 缺失"诊断有误，实际是守卫条件 bug 导致
 *      所有手势（含 touch）从未挂载，故 2.11.0/2.11.1 所有设备均无法使用。
 */

/**
 * 2.11.0 (2026-07-14): [FEATURE] 新增统一手势操作入口（gesture hub），修复 epub 模式左右滑动无法翻页 + 长按浮窗失效
 *   1) 根因：第19轮（2.10.4）删掉全屏遮罩 <button> 后，epub 阅读内容在 iframe 内、浏览器安全机制使外层 DOM 的
 *      touch 事件无法穿透到 iframe，导致 EpubViewer 与外层 ReaderPage 都收不到滑动/长按手势；且当时改用
 *      rendition.on('click') 只转发 click、不处理 touch/move/longpress，长按浮窗时灵时不灵。
 *   2) 修复：新增 src/hooks/useGesture.ts 统一手势入口，集中定义 swipe / longpress / tap 识别，阈值全收敛到
 *      GESTURE_CONFIG 单常量（LONG_PRESS_MS=800，消除原 txt 1000 / epub 600 不一致）。
 *      - epub 模式：通过 epub.js 官方通道 rendition.getContents() 在 iframe 的 document 上直接注入 touch 监听
 *        （attachToEpubContents），真正恢复左右滑动翻页（调 rendition.next/prev）+ 可靠长按浮窗。
 *      - txt 模式：外层容器改用 gesture.attachToElement 接管，删除散落的 handleSwipeStart/End、
 *        longPressStart/Cancel 等逻辑，行为保持一致。
 *   3) 文字选择不拦截：仅在识别为 longpress 后才阻止误触，否则原生穿透（书内 TOC 跳转/复制正常）。
 *   4) 复杂度下降：移除一个侵入式遮罩层 + 撤销 2 处不一致的魔法数字，手势逻辑集中到单一模块。
 */
/**
 * 2.10.4 (2026-07-14): [BUGFIX] 移除全屏透明遮罩，恢复书自带目录跳转与文字复制
 *   1) 根因：EpubViewer 在 epub.js iframe 之上覆盖一层 `absolute inset-0 z-20` 的全屏 <button>，
 *      拦截了 iframe 内所有点击/触摸事件 → 书自带 TOC 链接点击无法穿透到 epub.js（无法跳转）；
 *      同时 ReaderPage 的 reader-root 挂载 `select-none` 类禁用了文字选中（无法复制）。
 *   2) 修复：删除全屏 <button> 遮罩，改用 epub.js 原生 `rendition.on('click', ...)` 事件委托
 *      （epub.js 在 iframe 文档内注入监听并转发事件，无需覆盖层）捕获长按（≥600ms）触发浮动菜单，
 *      真实点击与文本选择穿透给 iframe 自身处理；同步移除 reader-root 的 select-none。
 *   3) 复杂度下降：移除一个侵入式 DOM 层，复用 epub.js 标准 API，无新增逻辑。
 */
/**
 * 2.10.1 (2026-07-14): [FIX+OPTIMIZE] 键盘翻页复用滑动翻页通道 + 翻页模式页面固定 + 浮动菜单长按1秒
 *   1) [FIX] PC 键盘 ←/→ 翻页根因：上一轮（2.9.x）在 scroll 模式错误地复用「上一章/下一章」章节导航，
 *      与用户要求的"复用滑动翻页（向左滑=next/向右滑=prev、逐页翻）"不符。现改为：←/→ 在所有阅读模式下
 *      均严格走「滑动翻页」通道（EPUB→epubPageControlRef.next/prev，TXT→performPageTurnRef），绝不跳章节。
 *   2) [FIX] 翻页模式阅读页面仍可上下移动一小段：在 index.css 锁定 epub.js iframe 与 TXT 分页容器的纵向
 *      手势（touch-action: pan-x + overflow: hidden + overscroll-behavior: contain），翻页模式页面固定。
 *   3) [OPTIMIZE] 浮动菜单过于灵敏（点击即弹）：改为「长按≥1秒」才弹出（ReaderPage 外层与 EpubViewer
 *      透明覆盖层统一使用长按计时器），短按仅用于关闭已打开的目录(TOC)，不再误触弹菜单。
 */
/**
 * 2.9.3 (2026-07-14): [FEATURE+OPTIMIZE] 桌面端键盘翻页全模式生效 + TTS 提速 + 按钮点击反馈
 *   1) [FIX] 键盘翻页"没反应"根因：2.9.2 将 ←/→ 快捷键强绑定 paginated 模式，而阅读器默认是 scroll 模式，
 *      默认模式下按键被直接 return → 用户感知"没实现"。现改为全模式生效：paginated 走原整页翻通道，
 *      scroll（默认）复用浮动面板的"上一章/下一章"导航（handlePrev/NextChapter），与 UI 按钮行为完全一致。
 *   2) [OPTIMIZE] TTS 延迟优化：①ReaderPage 中 ireader_tts_noCache 默认由 true 改为 false，开启本地语音缓存
 *      （优先复用后端已合成 WAV + IDB 缓存音频，告别"每次点击都重新合成≈5s"）；
 *      ②TTSPlayer.init() 冷启动不再 await 网络取设置（用默认值立即建 <audio> 元素，设置后台异步刷新），
 *      消除点击后的首响阻塞。
 *   3) [FEATURE] 按钮点击反馈增强：播放按钮 loading 态显示旋转 spinner（"准备中…"），
 *      播放/暂停/上一章/下一章/停止按钮加 active:scale 按压缩放，点击是否成功一目了然。
 */
/**
 * 2.8.5 (2026-07-13): [BUGFIX] 修复暗色模式/翻页手势被吞/TOC目录不关联三大阅读器问题
 *   1) 暗色模式 EPUB 无法阅读：EpubViewer themes.register 未设置 background-color + color，
 *      暗色模式 iframe 仍白底黑字 → 注册时追加深色背景+浅色文字，监听 theme 状态实时切换。
 *   2) 翻页与滚动失效：EpubViewer 透明覆盖层 button 的 onTouchEnd + e.preventDefault()
 *      拦截了 epub.js iframe 内部的翻页/滚动手势 → 移除 onTouchEnd（点击仍通过 onClick 正常响
 *      应），让手势穿透到 iframe 内部的 epub.js 手势系统。
 *   3) 浮动菜单目录不关联 EPUB 章节：navigateToChapter 对 EPUB 未做适配，始终调
 *      loadChapterContent（纯文本）→ 新增 epubChapterNavRef，通过 book.spine.get(index).href
 *      让 EpubViewer 跳转到对应章节。
 * 2.8.4 (2026-07-13): [BUGFIX] 修复 deploy.sh 部署时 EADDRINUSE 冲突 — 停用 systemd 服务，统一后台进程管理
 *   1) 根因：deploy.sh 的 stop_old_instance 用 kill_processes_on_port 杀掉旧进程后，
 *      systemd（Restart=always + RestartSec=5）立即重新拉起旧版本进程，
 *      新进程 bind 端口时产生 EADDRINUSE。
 *   2) 修复：stop_old_instance 改为轮询循环（≤6次）：systemctl stop → sleep 5 →
 *      kill_processes_on_port → 检查端口空闲。systemd 每次拉起旧进程都被新循环
 *      杀掉并再次 stop，直到端口真正释放。start_service 也加固了端口二次确认。
 *   3) 旧 PID 文件清理逻辑（方式2）保留作为降级兼容。
 * 2.8.3 (2026-07-13): [BUGFIX] 修复 2.8.0 重构引入的阅读器交互三大回归
 *   1) 上一章/下一章按钮失效（EPUB）：浮动翻页按钮原调用 goToNextChapter/goToPrevChapter（章节列表导航），
 *      对 epub.js 内部渲染的 EPUB 内容零响应 → 改为 EPUB 走 epubPageControlRef.current.next()/prev()。
 *   2) 点击空白浮窗消失：EpubViewer 的 iframe 吞掉点击，父层 handleTapReader 收不到 →
 *      在 EpubViewer 内加透明覆盖层捕获点击并转发 onTap（stopPropagation 避免冒泡双重触发）。
 *   3) 移动端持续"加载中"：epub.js 在容器尺寸为 0 时 display() 永不 resolve →
 *      加容器尺寸守卫（ResizeObserver + rAF 重试）+ 15s 超时兜底提示，杜绝永久加载。
 *   4) 附带修复线上后端静态目录解析错误（__dirname 回溯少一级导致 frontend/dist 404 → 500 白屏）。
 */
/**
 * 2.8.6 (2026-07-13): [BUGFIX] 修复浮动菜单目录无法点击 — TOC 侧边栏 z-20 与 EpubViewer 覆盖层 z-20 冲突
 *   1) 根因：TOC 侧边栏（z-20）在 DOM 中位于 EpubViewer（内含 z-20 透明覆盖层）之前，
 *      同层级下后渲染的覆盖层盖在 TOC 上方，拦截了 TOC 按钮的点击事件。
 *   2) 修复：将 TOC 侧边栏的 z-index 从 z-20 提升至 z-30，确保其可点击区域不被覆盖层遮挡。
 * 2.8.9 (2026-07-13): [BUGFIX] 修复 TTS 朗读 HTML/CSS 代码导致进度异常 — 章节缓存使用简易剥离遗漏 <style> 块
 *   1) 根因：cacheSingleChapter 前用 simpleStrip2（仅去标签）处理 EPUB 内容，CSS 代码残留到 IDB 缓存
 *      → TTS 朗读 CSS 代码 → 文本段数异常 → 进度条计算失真（134%）。
 *   2) 修复：simpleStrip2 替换为完整 stripHtml（移除 <style>/<script>/<head> 等块），
 *      同时缓存读取路径也加 stripHtml 兜底，确保显示和朗读内容均不含 CSS 残留。
 * 2.8.7 (2026-07-13): [BUGFIX] 修复 EPUB 模式下点击播放按钮无响应 — 悬浮面板半透明遮罩吞掉按钮点击事件
 *   1) 根因：悬浮面板外层容器 onClick={() => setShowUi(false)} 事件捕获/冒泡阶段先于或遮盖了
 *      内部播放/暂停/停止/上下章按钮的 onClick 回调，导致 handleStartTTS 等未被正确触发。
 *      事件层级：悬浮遮罩（z-30 覆盖全屏）→ 按钮 → 用户感知"点不下去"。
 *   2) 修复：所有播放控制按钮（播放/暂停/停止/上章/下章）的 onClick 中添加
 *      e.stopPropagation()，阻止事件冒泡至遮罩层。
 */
/**
 * 2.9.0 (2026-07-13): [FEATURE] 阅读界面优化 — 移除左右浮动导航按钮，增强目录高亮
 *   1) 移除屏幕左右两侧半透明的"上一章"‹ 和"下一章"› 浮动按钮，
 *      翻页仍可通过滑动手势、浮动面板内导航等途径完成。
 *   2) 目录菜单当前章节高亮增强：左侧彩色边框指示器 + 播放图标标记 +
 *      更鲜艳的背景色与文字色 + 加粗字体，非当前章节保持低调。
 *   3) 打开目录时自动滚动到当前章节位置（scrollIntoView）。
 */
/**
 * 2.10.2 (2026-07-14): [BUGFIX] 修复翻页模式在移动端 PWA 仍可整页上下位移 — 根容器文档级锁定（修根非补丁）
 *   1) 根因：2.10.1 仅在子容器（.epub-viewer-canvas / .paginated-scroll）加 touch-action:pan-x 补丁，
 *      漏掉真正控制整页能否滚动的全局根容器（html/body/#root 无 height:100% / overflow / 固定锁定）
 *      + viewport 缺 viewport-fit=cover + 根盒用 100vh（地址栏误差），iOS Safari 在 document 层仍可整页橡皮筋位移。
 *   2) 修复：①index.css 给 html,body,#root 加 height:100% + overscroll-behavior:none（仅禁整页回弹，不误伤 scroll 模式与长页面）；
 *      ②新增 .reader-root 作用域类（position:fixed; inset:0; overflow:hidden; overscroll-behavior:none），
 *      由 ReaderPage 根盒挂载，彻底锁死阅读器整页位移；③index.html viewport 补 viewport-fit=cover；
 *      ④ReaderPage 根盒 h-screen(100vh) → h-[100dvh]，消除 PWA 全屏地址栏可视区误差。
 *   3) 注：第14轮（2.10.1）子容器补丁保留无害，本修正在更外层根因处收口。
 */
/**
 * 2.10.0 (2026-07-14): [FEATURE] TTS 设置页面增加音色试听按钮
 *   1) ttsService.ts 新增 synthesizeSpeech 方法（POST /api/tts，返回 Blob）
 *   2) SettingsPage.tsx 缺省音色下拉框下方增加"试听"按钮
 *   3) 点击后合成 3 秒试听文案并播放，播放中按钮显示加载态
 *   4) 播放结束自动重置按钮状态，支持反复试听
 */
/**
 * 2.10.3 (2026-07-14): [BUGFIX] 修复翻页时右侧白条 — 给 epub.js iframe 文档根(html)补背景色
 *   1) 根因：EpubViewer 的 themes 只给 body 设置了背景色，未给 html 根元素设置。epub.js 在
 *      flow:'paginated' 模式下用 transform 平移翻页，翻页瞬间右侧露出的空白列属于 html 根区域
 *      （body 之外），html 默认白色背景 → 翻页时露出白条（深色模式尤其明显）。
 *   2) 修复：在 themes 注册处（applyTheme 初始化 + 样式变化 effect 两处）均给 'html' 追加与 body
 *      同色的 background-color，翻页露出的空白列与页面同色，白条消失。这是修根（让露出区域颜色
 *      正确），非在父层加遮挡补丁，复杂度不变。
 */

/**
 * 2.15.2 (2026-07-15): [BUGFIX] 修复登录页点击「离线使用」后卡死在「加载中…」无法返回/退出
 *   1) 根因：AuthProvider 的认证初始化 useEffect 依赖为 [handleUnauthorized, navigate]，永远不变，
 *      仅在组件挂载时运行一次。登录页点击「离线使用」调用 enterOfflineMode()（置 isOfflineMode=true）
 *      后再 navigate('/') 切换路由，AuthProvider 不重新执行初始化逻辑，读到旧 isOfflineMode=false
 *      → 走 getCurrentUser() 的 axios 请求分支；离线态下该请求挂起/失败，最终 setLoading(false) 收尾，
 *      但用户已卡在「加载中」且书架页离线无缓存时缺「返回登录页」入口，表现为持续加载、无法退出。
 *   2) 修复（修根，非打补丁）：
 *      - AuthContext：初始化 useEffect 依赖加入 isOfflineMode，使进入离线模式后重跑 → 立即
 *        setLoading(false) 跳过认证；并统一「主动离线 / 物理断网」两条跳过认证分支，离线时清空残留登录态。
 *      - LoginPage：离线按钮注释明确「先 enterOfflineMode 再 navigate」，确保 BookshelfPage 挂载时
 *        AuthProvider 已处于离线态，ProtectedRoute 直接放行、走离线分支。
 *      - BookshelfPage：离线无缓存的 error 态新增「返回登录页」按钮，离线登录用户有唯一逃生出口。
 *   3) 验证：tsc --noEmit 全绿；新增 AuthContext 离线模式单测（离线态 loading 立即 false、不请求 API、
 *      isAuthenticated 为真）；全量 vitest 46 项通过。
 */

/**
 * 2.15.4 (2026-07-16): [BUGFIX] ReaderPage 离线错误提示缺少「退出离线模式」和「返回登录页」按钮
 *   1) 根因：ReaderPage 的 error 渲染块（第 2247~2264 行）仅渲染了「重试」按钮，没有提供
 *      「退出离线模式」和「返回登录页」两个逃逸出口，导致用户进入离线模式后无法退出。
 *      对比 BookshelfPage 的同类型错误渲染已包含这两个按钮（修复 2.15.2 时已考虑），
 *      但 ReaderPage 遗漏了相同处理。
 *   2) 修复：在 ReaderPage error 面板中新增「返回登录页」和「退出离线模式」两个按钮，
 *      仅在 isOfflineMode 为 true 时显示；从 useAuth 解构 exitOfflineMode。
 *   3) 验证：tsc --noEmit 全绿。
 */
