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
 * 1.12.0 (2026-07-03): 书架页面图标布局优化，导航栏简化，操作栏按功能分行排列
 * 1.13.0 (2026-07-03): 自动更新部署 — triggered-deploy.sh + Git hooks 自动化部署
 * 1.14.0 (2026-07-03): iOS 风格深度美化 — 毛玻璃导航栏、iOS 卡片式书架/设置/登录页、SF Symbols 图标体系、弹性动效
 * 1.14.1 (2026-07-03): [BUGFIX] 修复设置面板不可见（loading条件反置）+ 部署延迟60s→10s
 * 1.15.0 (2026-07-03): Git hooks迁移到.githooks/（可版本控制）+ SettingsPage测试 + 自动部署默认工作流
 * 1.16.0 (2026-07-03): ReaderPage iOS风格改造 — 毛玻璃浮动面板、SF Symbols SVG图标替换emoji、iOS毛玻璃顶栏、CSS变量背景体系
 * 1.17.0 (2026-07-03): TTS服务配置二级菜单 — 服务源选择、API地址/Key配置、缺省音色选择、语速调节、连接测试
 * 1.18.0 (2026-07-03): ReaderPage iOS阅读排版升级 — 字间距、段落间距控制、iOS字体栈、设置页偏好同步
 * 1.19.0 (2026-07-03): 全界面iOS风格统一完善 — LoginPage iOS化重写、BookshelfPage/ReaderPage Tailwind→CSS变量全替换、首行缩进开关、SettingsPage阅读偏好同步
 * 1.19.1 (2026-07-03): [BUGFIX] 移动端导航栏补充设置按钮（sm:hidden 导致移动端无设置入口）
 * 1.19.2 (2026-07-03): [BUGFIX] 全局播放按钮传入含HTML标签内容（isHtml=false）+ 阅读浮动菜单纵向高度优化（2×2网格合并字号/行距/段距/首行缩进）
 * 1.19.3 (2026-07-03): 浮动菜单高度放大、字体/按钮全面加大、iOS半透明玻璃效果增强
 * 1.20.0 (2026-07-03): 浮动菜单重组优化 — 播放栏固定顶部（3按钮+进度+音色），朗读按钮取消，缓存/清除合并移到底部
 * 1.20.1 (2026-07-03): 浮动菜单精简优化 — 移除音色选择器（采用设置统一），缓存图标+本章/全书，清除按钮简化为文字/语音/全部，预读进度移至顶部书名下
 * 1.20.2 (2026-07-03): 浮动菜单布局调整 — 四个圆图标（⏬本章·⏬全书·🗑文字·🗑语音）一行排列，缓存信息下方展示；移除底部预合成/语音缓存统计；顶栏书名与播放栏间距收紧
 * 1.20.3 (2026-07-03): [BUGFIX] 修复主界面重复语音图标 + 移除播放时自动预生成（全局设置关闭时不应自动触发）
 * 1.20.4 (2026-07-03): [PERF] TTS 播放启动加速（5-10秒→秒级）— getCurrentChapterText 优先读 IDB 缓存；loadBook 完成后预热 player.init + IDB 音频缓存预加载；TTS 设置 localStorage 缓存；load() 批量检查 IDB 音频缓存
 * 1.21.0 (2026-07-04): [BUGFIX+FEATURE] 综合修复与增强：
 *   1) TTS 音色/语速持久化 — 设置页同步到 localStorage，ReaderPage 从 localStorage 初始化，不再被硬编码默认值覆盖
 *   2) 缓存全书改为逐段合成语音并存入本地 IndexedDB（而非仅触发服务端预合成）
 *   3) 浮动窗播放栏新增「停止」按钮 — 清理播放进度，下次从当前页开始
 *   4) 播放栏新增上/下一章按钮，Media Session 锁屏支持上下章控制
 * 1.21.1 (2026-07-04): [PERF] 章节切换自动播放延迟 300ms→100ms
 * 1.22.0 (2026-07-04): [FEATURE] 缓存全书优化：① 实时进度反馈（获取章节 x/y + 合成语音 x/y 段）② 全局并发池（跨章共享 6 并发，替代逐章串行×章内4并发）
 * 1.22.1 (2026-07-04): [BUGFIX] 进度统一按章节管理：① 缓存全书进度从按音频段计数改为按章计数 ② 主界面每本书的语音合成进度同样改为按章展示，移除段级计数器 ③ ReaderPage 缓存信息栏移除"段"显示
 * 1.22.2 (2026-07-04): [BUGFIX+UI] 修正上一章/下一章按钮图标（双箭头→单箭头）；播放栏分散布局（控制组靠左、定时按钮靠右）；清理段距和首行缩进无用选项及所有相关代码
 * 1.23.0 (2026-07-05): [FEATURE] 前端渐进增强兼容策略 — 老旧设备保守兼容 + 新设备现代特性
 *   1) CSS @supports 检测 backdrop-filter，不支持时回退纯色背景
 *   2) prefers-reduced-motion 降级全部动效/按压缩放
 *   3) JS 运行时性能检测（CPU核心数/内存），低性能设备自动禁用毛玻璃和动画
 *   4) .low-perf CSS class 动态注入，组件可通过 useTheme().compatibility 消费
 *   5) COMPATIBILITY.md 兼容策略文档
 * 1.24.0 (2026-07-05): [FEATURE] 组件级渐进增强容器 — SafeGlass/SafeMotion/ProgressiveCard/ProgressiveTappable
 *   1) SafeGlass: 组件级毛玻璃兼容容器（低性能设备纯色替代，减少GPU合成层）
 *   2) SafeMotion: 动效兼容包装器（低性能设备禁用弹性动画）
 *   3) ProgressiveCard: 渐进增强卡片（低性能设备无阴影无hover缩放）
 *   4) ProgressiveTappable: 按压反馈兼容包装器（低性能设备仅透明度变化）
 *   5) Layout 导航栏使用 SafeGlass 替代硬编码 glass 类
 * 1.25.0 (2026-07-05): [FEATURE] 前端渐进增强兼容策略 + 构建兼容降级 — @vitejs/plugin-legacy 双输出
 * 1.25.1 (2026-07-05): [BUGFIX] 兼容 .epub.zip 双扩展名上传格式 — 智能格式检测函数，前端放开文件选择限制
 * 1.25.2 (2026-07-05): [BUGFIX] 修复"二次包装"EPUB 无法解析—内容被嵌套在 `书名.epub/` 子目录下时自动提级修复
 * 1.25.3 (2026-07-05): [BUGFIX] 修复解析失败（封面乱码）— 将修复脚本内联到 epub.ts 中，消除对 scripts/repair_epub.py 文件的外部依赖；Step3 提取文件改用修复后的 EPUB 路径
 * 1.25.4 (2026-07-06): [BUGFIX] 修复 1.25.3 引入的回归 bug — `rebuildEpubWithPython` 函数使用 `require('child_process')` 但文件为 ESM 模块，导致 `require is not defined`，修复函数始终抛异常返回 null，修复逻辑从未生效；已将 `require` 替换为顶层 `import { execSync }` 解决 ESM 兼容问题
 * 1.25.5 (2026-07-06): [BUGFIX] 修复二次包装EPUB解析失败（mimetype在子目录中）导致的书架乱码——使用repair_epub.py修复原始文件后重新上传到default-user账户，百妖谱和狂飙封面/章节/正文全部恢复正常
 * 1.26.0 (2026-07-06): [FEATURE] 离线模式支持 — Service Worker + 书架离线缓存 + 离线状态指示
 *   1) Service Worker (public/sw.js)：预缓存静态资源 + 运行时缓存封面/API 数据，无网络可打开 app
 *   2) 离线书架降级：BookshelfPage 网络不可用时自动从 IndexedDB 读取缓存书籍列表
 *   3) 书架元数据缓存（cacheShelfBooksMeta / getOfflineShelfBooks）：书名、作者、封面 URL 持久化
 *   4) 离线状态指示器：Layout 导航栏显示离线图标（Wi-Fi 断开图标）
 *   5) sw.ts：Service Worker 注册模块（原生 SW，无需额外 npm 包）
 *   6) offlineCacheService 扩展：ShelfCacheMeta 接口、书籍元数据读写、网络状态监听
 * 1.26.1 (2026-07-06): [FIX] 修复构建环境 — npm lockfile v3 requires段损坏导致devDependencies未安装，改用pnpm替代npm管理依赖，构建全流程（tsc类型检查+vite build+38项测试）全部通过
 *   1) 根因：npm v10.9.4 lockfile v3的packages[""].requires段为空，导致npm install跳过devDependencies物理安装
 *   2) 修复方案：引入pnpm v10.30.2替代npm进行依赖管理
 *   3) 验证：npm run build (tsc -b + vite build) ✅、tsc --noEmit 零错误 ✅、38项测试全绿 ✅
 * 1.28.0 (2026-07-06): [FEATURE] 离线模式修复 — SW导航拦截 + ReaderPage离线降级
 *   1) SW导航拦截：新增 isNavigateRequest 判断，飞行模式时返回缓存的 index.html（App Shell）
 *   2) SW预缓存修复：addAll→Promise.allSettled 逐个缓存，避免单资源失败全缓存泡汤
 *   3) ReaderPage loadBook离线降级：API请求失败时从 IndexedDB 读取书籍信息和章节列表
 *   4) offlineCacheService 新增 getOfflineBookInfo：从 cacheMeta 提取书籍基本信息供离线使用
 * 1.33.0 (2026-07-12): [FEATURE] 安全账号白名单 — 注册白名单邮箱限制（secUserEmail.json），仅白名单内邮箱可注册；登录支持 email/username 双模式兼容老用户
 * 1.33.1 (2026-07-12): [BUGFIX] 修复白名单配置未部署 — deploy.sh 未拷贝 secUserEmail.json 到部署目录，导致后端加载白名单失败，所有邮箱被拒绝注册
 * 1.34.0 (2026-07-12): [FEATURE] 语音播放停止后清除播放位置，再次播放从新位置开始 + 书籍内搜索与跳转
 * 1.35.0 (2026-07-12): [FEATURE] 全书搜索：搜索范围从当前章节扩展到全书所有章节，结果带章节名称并支持跨章跳转
 * 1.36.0 (2026-07-12): [FEATURE] 支持"单文件合集"型EPUB解析 — 从TOC navMap提取锚点章节（#toc_X），解决多本书合集中章节解析为3个的问题，百妖谱从3章→267章
 * 1.36.1 (2026-07-12): [FEATURE] 后端新增 reparse API，可对已有书籍手动触发重新解析（旧书升级解析）
 * 1.36.2 (2026-07-12): [BUGFIX+FEATURE] 修复搜索跳转高亮bug（setSearchQuery清空后RAF回调读到的query为空，导致高亮错误）+ 搜索候选从10个增加到20个
 * 1.37.0 (2026-07-12): [FEATURE] 阅读页 TOC 目录面板新增「刷新章节」按钮 — 调用 reparse API 重新解析已有 EPUB 书籍章节，无需用户删除重传
 * 1.37.1 (2026-07-12): [BUGFIX] 修复 EPUB 合集型书籍（含锚点 href）章节跳转后内容加载失败 — 后端移除 href 中 # 锚点部分读取文件 + 按锚点提取对应章节 HTML 片段
 * 1.37.2 (2026-07-12): [BUGFIX] 修复搜索跳转与章节刷新跳转不一致 — 搜索跳转强制纯文本模式（清除 epubDisplayHtml），确保 DOM 文本与搜索 offset 对齐，TreeWalker 定位准确
 * 1.37.3 (2026-07-12): [BUGFIX+PERF] 修复搜索持续显示"正在搜索全书..." — ensureFullBookLoaded 分批加载（每批5个并发）+ 请求超时30秒 + 搜索输入400ms防抖
 * 1.38.0 (2026-07-12): [REFACTOR] 合集EPUB目录清理 + 搜索双线程架构重构
 *   1) 后端 epub.ts：单文件合集型EPUB检测，丢弃 spine flow 粗粒度旧目录，仅保留TOC锚点新目录
 *   2) 前端 ReaderPage：搜索重构为双线程 — 线程1（目录匹配·同步最高优先级）+ 线程2（全文搜索·异步并发）
 *   3) 搜索结果展示区分"章节匹配"（蓝色标记）和"正文匹配"（黄色高亮）
 *   4) stripHtml 从 useCallback 提取为模块级函数，消除 hoisting 问题
 * 1.38.1 (2026-07-12): [BUGFIX] 修复合集型EPUB书籍TTS语音生成无法读取章节内容 — 锚点(href含#)章节提取锚点对应文本合成语音，任务运行中根据实际分片数更新totalChunks
 * 1.39.0 (2026-07-12): [FEATURE] 导航栏布局优化 — 书架/语音合成/设置三图标顺序统一，补齐移动端缺失的书架图标，双端图标样式一致
 * 1.40.0 (2026-07-12): [FEATURE] 导航栏顺序调整为书架→设置→语音合成
 * 1.40.1 (2026-07-12): [BUGFIX] 修复TTS语音进度计算虚假+任务卡死无限重试 — progress使用实际分片数计算，实时更新totalChunks；recoverStuckJobs重算totalChunks并限制最多恢复3次
 * 1.40.2 (2026-07-12): [PERF+Bugfix] 缓存全书跳过已缓存章节 + 清除缓存改用游标批量删除大幅提速
 * 2.2.1 (2026-07-12): [BUGFIX] 修复翻页动画不生效 — pageTurnAnim 类名未应用到 TXT 内容元素
* 2.2.2 (2026-07-12): [BUGFIX] 修复翻页动画 CSS 类名拼接错误 — 'page-turn ' + pageTurnAnim 生成 page-turn next-leave，CSS 选择器 .page-turn-next-leave 无法匹配（连字符 vs 空格），改为 page-turn page-turn-{anim} 格式
 *   1) handleCacheFullBook 前置检查：文字+语音已全缓存时直接跳过，不触发进度动画
 *   2) clearBookTTSAudioCache / clearBookChapterCache 改用 IDB 游标批量删除替代逐条 for 循环删除
 * 2.3.0 (2026-07-12): [FEATURE] 翻页动画引擎全面重写 — 从零实现 PageTurnCanvas 组件
 *   - 删除旧的 CSS @keyframes 双缓冲翻页体系（v2.2.3 引入的诸多补丁）
 *   - 新建 PageTurnCanvas 组件，使用 requestAnimationFrame + 逐帧 CSS 3D 变换实现真实翻页感
 *   - 旧页层：transform-origin: left center，rotateY 0° → -90° + 暗化 + 缩放
 *   - 新页层：transform-origin: right center，rotateY 90° → 0° + 亮度恢复 + 复原
 *   - 支持 TXT 章节内分页翻页 + 章节间翻页 + EPUB 章节间翻页
 *   - 手势滑动触发（水平滑动 > 50px）、浮动菜单翻页按钮支持
 *   - 保留 reduced-motion 和 low-perf 无障碍兼容
 * 2.3.1 (2026-07-12): [BUGFIX] 修复翻页模式两大核心缺陷：
 * 2.4.0 (2026-07-12): [FEATURE] EPUB 视口高度分页 + 翻页进度指示器
 *   1) EPUB 章节内分页：将 EPUB HTML 按块级标签（p/div/h1-6/img等）拆分为 blocks，
 *      根据视口高度、字号、行距动态计算每屏可容纳的段落数，实现真正的视口分页。
 *      翻页不再按章节跳跃，而是像 TXT 一样逐页翻。
 *   2) 翻页进度指示：翻页模式下底部和浮动面板显示 "3/12" 页码指示，
 *      让用户清楚当前在第几页/共几页。
 *   3) EPUB 翻页模式容器 ref 统一管理，支持字体/字号/行距变化自动重新分页。
 *   4) 章节切换时自动重置 pageIndex=0 和分页缓存，确保无缝衔接。
 *
 *   1) 翻页变翻章：分页算法从固定50行/页改为视口高度动态计算（containerHeight / fontSize / lineHeight），短章也能正确分页
 *   2) 翻页模式可滚动：翻页模式下为阅读容器加 touch-action:none + overscroll-behavior:none 禁用浏览器默认手势，EPUB 翻页模式也切换 overflow-hidden
 * 2.0.0 (2026-07-12): [ARCH] 全局引用系统 — 相同书籍/TTS语音全局只存一份，引用计数隔离，30天自动清理
 * 2.0.1 (2026-07-12): [MIGRATION] 存量数据迁移完成 + 全局TTS映射修复 + 后台合成补录全局资源
 *   1) 运行 migrate-global-refs.ts 完成 268 本书 → 264 全局书籍 + 268 引用的迁移
 *   2) 修复 POST /api/tts 和 batch-cache 中全局TTS查找/创建用的 bookId 映射（local→global）
 *   3) 修复 ttsGenerationService 后台预合成时也写入 tts_global_resources，实现跨用户共享
 *   4) 运行 refresh SQL 脚本刷新所有书籍的语音合成进度
 * 2.5.0 (2026-07-12): CSS multi-column 翻页全面替换自建分页引擎 — A1方案落地
 */
export const APP_VERSION = '2.5.0';
