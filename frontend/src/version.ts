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
 */

export const APP_VERSION = '1.36.1';
