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
export const APP_VERSION = '2.11.4';
/**
 * 2.11.4 (2026-07-14): [FIX] 修复 deploy.sh 5 类可靠性缺陷
 *   1) 并行构建管道吞错误 → 改用临时文件记录 exit code
 *   2) systemd Restart=always 端口争用 → mask 后增加 6s 窗口等待
 *   3) pnpm install --prod 超时 → 改为复制 node_modules + rebuild
 *   4) fuser 命令缺失 → fallback 到 lsof/ss 多工具检测
 *   5) 健康检查重复代码 → 合并冗余逻辑
 *   2) 修复：在 display() await resolve 后直接调用 attachGesture()，
 *      作为 rendered/relocated 事件的保底。双保险确保手势一定挂上。
 *   3) 影响范围：所有设备（移动端 + 桌面端）的 epub 阅读模式。
 *      ⚠️ 2.11.0/2.11.1/2.11.2 均因部署失败或事件丢失从未真正生效，
 *      这是第一个手势可用的稳定版本。
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
