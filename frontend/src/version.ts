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
 */
export const APP_VERSION = '2.35.0';
