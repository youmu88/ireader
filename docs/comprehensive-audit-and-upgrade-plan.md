# iReader 全面代码评审与升级优化方案（技术方案 + Todolist 二合一）

> 评审日期：2026-10-13 ｜ 评审对象：main 分支当前工作区 ｜ 版本基线：2.61.0
> 评审方式：全量代码勘察（前端 12,438 行 / 后端 8,548 行）+ 关键断言二次复核 + 运行期实证
> **复核修订（2026-10-14）**：全部断言已对照当前代码逐条复核（6 域并行勘察 + 主评审对「零调用/死代码」类强断言亲自检索复核；HEAD=75a43d0，与评审基线无代码漂移）。结论：33 项缺陷断言中 30 项完全属实、3 项表述修正（D22/D26/D27，见 §2.1）、无一项被推翻；行号校准 20 余处、统计数字更正 2 处；另发现 23 项原评审遗漏的问题（见 §13，重要的已并入各域与 Todolist）。

---

## 0. 执行摘要

**核心结论：用户报告的四类问题（翻页无反应、语音播放、书籍缓存、离线看书）全部属实，且共性根因一致——不是零散 bug，而是 2.44.0~2.49.0 多轮"阅读器整体重建"中，前端功能层被整批删除后未重建：翻页交互、TTS 播放层、离线下载链路三块能力至今没有承载者，留下大量"有后端、无前端""有实现、无调用"的断链代码。**

四域诊断一览：

| 缺陷域 | 用户症状 | 根本原因 | 性质 |
|---|---|---|---|
| 翻页交互 | 点按/滑动无反应，只能滚动 | 2.48.0 显式删除翻页模式，渲染固定 `scrolled-continuous`，翻页 API 零实现 | 架构性功能缺失 |
| TTS 语音 | 无法在阅读器内听书 | 播放层（useTtsSession/TtsOverlay/播放器）2.44.0 重建时删除未重建；后端另有缓存错配 P0 | 前端缺失 + 后端缺陷 |
| 书籍缓存 | 缓存功能形同虚设 | 书架"缓存"按钮只写服务端表并弹成功提示，浏览器端 IndexedDB 零写入（假成功） | 断链 + 欺骗性 UI |
| 离线看书 | 断网即无法阅读 | ReaderPage 无离线回退；SW 明确不拦截 API；离线包链路是死代码 | 全链路断裂 |

另发现**三项 P0 安全漏洞**（可伪造任意用户 token 的 JWT 硬编码密钥、默认管理员后门 admin/admin123、5 个未鉴权 SSRF 接口）与一批工程质量债。**建议按 Phase 0（安全）→ Phase 1（阅读体验）→ Phase 2（TTS）→ Phase 3（离线闭环）→ Phase 4（工程治理）五阶段推进，总计约 17~27 个工作日**，详细 todolist 见第 11 节。

---

## 1. 评审范围、方法与运行期实证

### 1.1 评审范围

- 前端 `frontend/src`（React 18 + Vite 5 + TS，12,438 行，77 个 ts/tsx 文件；复核实测 77，初稿记 79 系把 frontend 根目录 vite.config.ts / vitest.config.ts 计入）
- 后端 `backend/src`（Express 4 + better-sqlite3 + Drizzle，8,548 行，33 个 ts 文件；复核实测 33，初稿记 31 为统计口径错误）
- 工程配套：CI 工作流、部署脚本、Service Worker、docs/ 全部 14 份历史设计稿、git 近 40 次提交
- 复核纪律：所有关键缺陷断言均经主评审二次检索/读取确认（下文引用均含 文件:行）

### 1.2 运行期实证（本轮真实执行）

| 检查项 | 结果 |
|---|---|
| `tsc --noEmit`（backend + frontend） | 双端通过，EXIT=0 |
| 后端测试 `vitest run`（rebuild 前） | **5 个测试文件失败**——better-sqlite3 原生模块 ABI 失配（NODE_MODULE_VERSION 131 vs 137），整个套件不可运行 |
| `pnpm rebuild better-sqlite3` 后 | 8 个测试文件 / 98 个测试全部通过 |
| 前端测试 `vitest run` | 29 个文件 / 239 个测试全部通过 |

> ⚠️ 测试基础设施脆弱性实锤：Node 升级后未 rebuild 原生模块即导致后端测试"静默全挂"。测试全绿≠覆盖充分——本轮确认的 P0 缺陷（如 ttsCacheService 缓存条件覆盖 bug）恰恰**没有**任何测试覆盖。

---

## 2. 缺陷总览（按严重级）

分级标准：P0 = 核心功能不可用/数据错误/可被远程接管；P1 = 功能明显残缺/安全隐患/性能风险；P2 = 体验缺陷/技术债。

| # | 级别 | 域 | 缺陷 | 位置 |
|---|---|---|---|---|
| D1 | P0 | 翻页 | 翻页模式被删除，无分页管线、无翻页 API、无翻页交互 | EpubBookController.ts:144-145 |
| D2 | P0 | TTS | 阅读器零 TTS 集成，播放层整体缺失 | ReaderPage.tsx（全文零命中） |
| D3 | P0 | TTS | drizzle 链式 `.where()` 覆盖而非 AND → 任意文本命中任意缓存音频（错音）、跨书返回缓存 | ttsCacheService.ts:72-77 |
| D4 | P0 | 缓存 | 书架缓存按钮假成功：只写服务端表，IndexedDB 零写入却弹成功 toast | BookshelfPage.tsx:226-228 |
| D5 | P0 | 离线 | 离线阅读全链路断裂：无离线回退、离线包链路零调用 | ReaderPage.tsx:111 |
| D6 | P0 | 安全 | JWT_SECRET 硬编码兜底，可离线伪造任意用户 token | middleware/auth.ts:9 |
| D7 | P0 | 安全 | 空库自动创建 admin/admin123 默认管理员 | db/init.ts:443-446 |
| D8 | P0 | 安全 | 5 个未鉴权 SSRF 接口（任意 apiUrl 服务端 fetch + 回显） | routes/tts.ts:21,27,39,51,174 |
| D9 | P0 | TTS | synthesize 无 apiUrl 回退，未配置即 400，预生成逐段失败 | ttsProxyService.ts:269-296 |
| D10 | P0 | TTS | 读不存在的 `settings.voice_id`（实为 voiceId），开机预合成无视用户音色 | index.ts:106 |
| D11 | P1 | 翻页 | tap 桥接无 pointercancel 清理 / 无链接选区守卫 / 阈值 10px vs 6px 不一致双触发 | EpubBookController.ts:363-400 |
| D12 | P1 | 翻页 | 横滑是死手势：方向锁交还原生但容器无横向溢出 | scrollDamping.ts:107,187 |
| D13 | P1 | TTS | IDOR：jobs 取消/删除不校验归属；tts-generate 不校验书籍归属；跨用户读写音频 | tts.ts:459-507, books.ts:952-972 |
| D14 | P1 | TTS | 缓存键缺 model/apiUrl，换模型命中旧音频；engineConfigHash 写入但零消费者 | tts.ts:77,134 |
| D15 | P1 | TTS | 三个设置死旋钮（并发/分片大小存取+UI 但零消费者，分片/并发实为硬编码） | contentSegmentService.ts:17 |
| D16 | P1 | 缓存 | 后端内容缓存表只写不读（章节接口只读文件不查表） | books.ts:774-845 |
| D17 | P1 | 缓存 | SHA256 校验在非安全上下文恒通过，损坏资源静默入库 | offlineCacheService.ts:418-423 |
| D18 | P1 | 缓存 | 音频缓存键序错配（source:voice:rate vs voice:rate:source），覆盖率统计恒 0 | offlineCacheService.ts:149-153,981-982 |
| D19 | P1 | 缓存 | 清理泄漏：clearBookCache 漏清 offlinePackages/downloadSessions，幽灵 ready 包残留 | offlineCacheService.ts:1180-1230 |
| D20 | P1 | 缓存 | 后端离线清单接口同步 IO：readFileSync 全部文件 + 重算 sha256 阻塞事件循环 | books.ts:654-682 |
| D21 | P1 | 离线 | SW 不拦截 API（API_CACHE/isBookFile/isAPIRequest/SW_VERSION 死代码），静态资源离线兜底错返 index.html | public/sw.js:18,22,72,76,134,167-168 |
| D22 | P1 | 离线 | SW 无版本 bump 机制（历史上已因此出过线上事故） | deploy.sh / version.ts:73 |
| D23 | P1 | 安全 | 封面路由零鉴权 + SVG 占位图回显书名（未登录可枚举） | books.ts:420-457 |
| D24 | P1 | 安全 | 阅读进度版本号客户端可投毒，永久阻塞多端同步 | progress.ts:56-79 |
| D25 | P1 | 安全 | TTS apiKey 明文存储 + GET /settings 原样返回 | tts.ts:211, schema.ts:168 |
| D26 | P1 | 工程 | CI 流水线必挂：npm ci 但根目录与 backend/ 无 package-lock.json（仅 frontend/ 有）；runner 上自部署无意义 | .github/workflows/deploy.yml:31-56 |
| D27 | P1 | 工程 | 后端生产代码约 182 处 any（初稿记 61 为低估），全部路由工厂 `db: any` 弃用 Drizzle 类型 | books.ts:45 等 |
| D28 | P1 | 工程 | schema 双真源（drizzle vs 裸 SQL）+ 手写 ALTER 迁移，已现漂移（pinned 列） | db/init.ts vs db/schema.ts |
| D29 | P1 | 工程 | reading_progress 无 UNIQUE 约束 + select-then-insert 竞态 | init.ts:509, progress.ts:50-92 |
| D30 | P2 | 工程 | books.ts 1263 行 god file；async 路由无 try/catch（Express4 悬挂）；pbkdf2Sync/execSync 阻塞事件循环；无优雅停机；cors 全开 | books.ts / tts.ts:27,39,51,63,174 等 |
| D31 | P2 | 工程 | 仓库卫生：空文件 `1`、误建目录、14 个 .DS_Store、3 份 .docx 镜像、e2e 脚本散落 | 仓库根 |
| D32 | P2 | 文档 | README"501"、sw.ts 假宣传、offline-book-package-design.md 失实标注、optimization-design.md 进度表滞后 | README.md:65 等 |
| D33 | P2 | 工程 | TabView 已实现+有测试但零引用未接线 | components/TabView/TabView.tsx |
| D34 | P1 | 安全 | 注册白名单真实邮箱入库：backend/secUserEmail.json 硬编码 5 个真实个人邮箱，被 auth.ts:27-35 用作注册访问控制（commit 9801724 入库） | backend/secUserEmail.json |

### 2.1 复核修订记录（2026-10-14，对照 HEAD=75a43d0）

**总体结论：33 项缺陷断言中 30 项完全属实（含仅行号微偏者），3 项表述修正，无一项被推翻。** 关键「零调用/死代码」类强断言（`rendition.next()/prev()` 零调用、ReaderPage TTS 零命中、`downloadBatchCachedAudio` 零调用方、TabView 零引用、D3 链式 `.where()` 覆盖写法）均经主评审亲自检索二次证实。

表述修正 3 项：

| # | 初稿表述 | 复核后事实 |
|---|---|---|
| D22 | "SW 无版本 bump 机制" | v2.60.1（2856b9d）事故后已建立**手工** bump 规则（version.ts:74 发布约定 + v2.60.1→v4、v2.61.0→v5 连续两次手动 bump）；真实缺口是**无构建期与 version.ts 的自动联动**（deploy.sh 全文零命中 SW 相关字串）。待办不变，现状描述修正 |
| D26 | "npm ci 但仓库无 package-lock.json" | 精确化：根目录与 backend/ 无 package-lock.json（npm ci 必挂、:31 cache:'npm' 先报错）；frontend/ **实有** package-lock.json（与 pnpm-lock 双真源并存，本身即治理项） |
| D27 | "后端 61 处 any" | 严重低估：`any`/`as any` 全 backend/src 218 行匹配，生产代码约 **182 处**（routes 层 64 处：books 37 / tts 17 / auth 8 / categories 1 / progress 1） |

子断言补注 3 项（主结论不变）：

- **D16**「只写不读」补注：book_content_cache 被 books.ts:571-580 统计接口读计数，但**章节内容永不被服务**（getCachedChapterContent 全仓零调用）——「白占数据库」结论不变。
- **D19** 关联子断言「downloadSessions 已建表但未用于恢复」失实：两条下载链路实际用 session 跳过已完成项（offlineCacheService.ts:562-563、:599/:610/:627、:1423-1428 createOrResumeDownloadSession）；真实缺口是**失败后无自动重试/恢复触发器**。
- **D21** 部分修复已落地：导航请求已是 NetworkFirst（v2.60.1）；遗留为 5xx 不回退缓存、静态资源兜底错返 index.html、死符号与失实头注释（sw.js:2/:5/:6/:9）。

行号校准（机制全部属实，仅引用行号修正）：D5 ReaderPage.tsx:130→**111**；D15 contentSegmentService.ts:8→**17**；D24 progress.ts:56-79→**57-81**；D29 progress.ts:50-92→**62-103**、init.ts:509 实为非唯一索引 idx_rp_user_book（:74-86 DDL 无 UNIQUE）；D30 index.ts:104-108→**85**（setInterval 30s，SIGTERM 全文零命中）；§3 考古 version.ts:48-50→**43,47,49-51**；§3.2 scrollDamping.ts:186→**43（DIR_LOCK_THRESHOLD 定义）/185（比较）**；§4 D3 :184-187→**182-188**、D9 回退行号→**123/186/246**；§5 七函数行号（:539/:263/:780/:701/:386/:968/:1180）、清单接口 **654-684**、章节接口 **774-843**、模块总行数约 1400→**1623**；§6 sw.js API 直通 :183-185→**167-168**。

---

## 3. 域一：阅读器翻页与手势交互（D1、D11、D12）

### 3.1 用户症状与根因链

症状："无法正常反应，只能滚动"。**这不是事件失灵 bug，而是翻页功能在 2.48.0 被有意删除后的架构性缺失**——手势事件本身是通的（滚动正常、点按能弹菜单），但代码中不存在任何"点击/滑动 → 翻页"的映射。

根因链（三层全部缺失）：

```
渲染层：无分页管线
  EpubBookController.ts:144-145（EPUB）与 :185-186（TXT）均固定
  flow: 'scrolled-continuous' + manager: 'continuous'（连续滚动拼接容器）
  TS/TSX 源码 grep "paginated" 零命中（index.css:578-674 残留 23 处
  .paginated-scroll 死样式，未被任何组件引用——可作恢复分页时的现成资产）
    ↓
API 层：翻页方法不存在
  EpubBookController.ts:56-59 next()/prev() 仅为接口声明
  全仓库 rendition.next(/prev( 零调用点——UI 想翻页也无 API 可调
    ↓
交互层：无翻页交互绑定
  ReaderPage.tsx:128-129 点按唯一语义 = setChromeVisible 切换（显隐底栏）
  左右 1/4 点按翻页区（apple-books-reader-design.md §3 规格）未实现
  横滑：scrollDamping.ts:187 方向锁把水平手势 active=false 交还原生，
       :107 又给容器设 touch-action: 'pan-x pinch-zoom' 放行横 pan，
       但滚动容器无横向溢出 → 横滑是"死手势"（滑了没任何反应）
  键盘：grep ArrowLeft/ArrowRight 零命中，无键盘翻页（frontend/src 仅
       Modal.tsx:30 有 Escape 键处理）
```

版本考古（version.ts:43,47,49-51 + git 0abcb59/d3d3edc）：2.45.0（:43）垂直滚动模式上线（"滚动模式禁用翻页区"细节见 git 0abcb59 提交正文与 apple-books-reader-design.md:105）→ 2.48.0（:47）「删除左右翻页模式与翻页动画，固定垂直滚动」→ 2.49.x（:49-51）转 scrolled-continuous。测试基线 `ReaderPage.test.tsx:131` 只断言"点按→显隐底栏"，把现状固化为预期。

### 3.2 伴生交互缺陷（同类机制：tap 判定无守卫/状态悬挂）

| 缺陷 | 位置 | 机制 |
|---|---|---|
| 无 pointercancel 监听 | EpubBookController.ts:363-365 | 只绑 pointerdown/up/click，被系统手势取消的指针留下悬挂 tapStart，游离 click 误触菜单 |
| tap 无链接/选区守卫 | EpubBookController.ts:391-400 | 位移<10px 即 emitTap，点书内链接、收起文字选区也会翻转菜单；旧守卫 `getSelection().isCollapsed` 随 2.44.0 重建丢失 |
| 阈值不一致 | EpubBookController.ts:397 vs scrollDamping.ts:43/:185 | tap 判定 10px vs 阻尼方向锁 6px（DIR_LOCK_THRESHOLD 定义于 :43、比较于 :185）：6~10px 微拖既滚动又弹菜单（双触发） |

**复核新增发现（2026-10-14，原评审遗漏）**：
1. **wheel 横向分量被吞**：阻尼 wheel 拦截器只处理垂直滚动（deltaY 路径），触控板横向 deltaX 语义未定义——横滑翻页方案落地时需一并接管 deltaX（与 3.3-3 横滑入口复用）。
2. **touch-action 三套政策并存**：index.css:146 全局 `manipulation`、index.css:643 死样式区 `pan-y`、scrollDamping.ts:107 运行时 `pan-x pinch-zoom`——恢复分页/重构手势时应收敛为单一来源。
3. **tap 双路径去重不对称**：pointerup 与 click 双路径都可能 emitTap（EpubBookController.ts:391-407），去重逻辑不对称，存在特定时序下菜单双翻转窗口（并入 D11 伴生修复）。
4. **e2e 死脚本**：scripts/e2e_reader.py:110-113 仍引用 2.48.0 已删除的「翻页/单页/分页」按钮，早已无法跑通（Phase 4 卫生项）。

### 3.3 技术方案

**方案 A（推荐）：回归双阅读模式（分页 + 滚动可选）**

1. **渲染层**：EpubBookController 增加 `mode: 'paged' | 'scrolled'` 参数；paged 模式下 `flow: 'paginated'`（epub.js 原生分列分页），保留 scrolled 模式现状。设置页新增"阅读模式"选择，写入 localStorage 并持久化到用户偏好。
2. **API 层**：控制器实现并暴露 `next()/prev()`：paged 模式直通 rendition；scrolled 模式映射为"滚动一个视口高度 + 章节边界自动续接"（复用现有连续容器）。
3. **交互层**：
   - 点按分区：内容区左 1/4 → prev、右 1/4 → next、中 1/2 → 菜单开关（在现有 onTap 回调内按 clientX 分区路由，无需新增覆盖层，规避 iOS sandbox 事件问题——EpubBookController.ts:145-150 注释记载的 WebKit 218086 教训）。
   - 横滑翻页：在 scrollDamping 方向锁（axis==='h' 分支）**拦截横滑**而非交还原生：累计水平位移超阈值（48px）且垂直分量小 → 触发 next/prev；与触控板 wheel 的 deltaX 复用同一入口。
   - 键盘：←/→/PageUp/PageDown/空格 绑定 next/prev。
   - 过渡动画：paged 模式启用 180ms 水平过渡（对齐 apple-books-reader-design.md §3 规格）。
4. **伴生修复**：补 pointercancel 清理；handleTapEnd 增加 `getSelection().isCollapsed` 与链接元素守卫；tap 位移阈值统一为 6px（与方向锁一致）。
5. **纳入已设计未实施的 scroll-damping-refactor-design.md**（三层管线重构：单一阻尼系数/touch-action 生命周期化/level 缓存广播），作为手势底座一并落地。
6. **测试**：翻页分区路由、横滑阈值、pointercancel 清理、scrolled 模式翻屏的单元测试；更新 ReaderPage.test.tsx 基线。

**方案 B（保守）：保持滚动-only，点按左右 1/4 = 滚动一屏、横滑 = 切章**。改动小但与主流阅读器交互习惯（微信读书/Apple Books 均为分页）偏离，不推荐为终态；若工期极紧可作 Phase 1 的第一周过渡形态。

---

## 4. 域二：TTS 语音播放（D2、D3、D9、D10、D13、D14、D15）

### 4.1 现状诊断

**前端：播放链路整体缺失。** ReaderPage.tsx 全文 tts/speech/audio 零命中（本轮复核确认）。完整播放层（reader/tts/* 播放器与调度器、useTtsSession、TtsOverlay 迷你播放器、ttsMediaSession 等）在 commit d3d3edc「2.44.0 阅读界面整体重建」中删除且未重建。现存残留：BookshelfPage.tsx:238 注释引用已不存在的 TTSPlayer 单例；offlineCacheService.downloadBatchCachedAudio 无调用方；SettingsPage 的 no_cache 开关只写 localStorage、前端无任何请求携带该参数（后端 tts.ts:65 支持）→ 开关无效。

**后端：能生成、不能放心用。** 路由完整（tts.ts 525 行，README 声称的"501 Not Implemented"已失实），但存在严重缺陷：

1. **【P0·数据正确性】缓存条件被覆盖（D3）**：ttsCacheService.ts:72-77 `findCache` 先 `.where(text_hash AND voice AND speed AND source)`，再 `query = query.where(user_id = ...)`。drizzle-orm 0.29.5 的链式 `.where()` 是**赋值覆盖**而非 AND 组合（select.js:407 `this.config.where = where`）→ 实际生效条件只有 user_id → **任意文本命中该用户任意缓存音频（错音播放）**。同病：:182-188 `findCachedSegmentsByBook`（batch-cache 跨书返回全部缓存）、:244-247 `clearAllCache`（删错缓存）。复核注：drizzle-orm 0.29.5 select.js:416 `this.config.where = where` 确为赋值覆盖。
2. **【P0·开箱即坏】apiUrl 无回退（D9）**：ttsProxyService.ts:269-296 synthesize 要求 apiUrl 必填（:284-286 返回 400），而 DEFAULT_API_URL 回退只覆盖 health/voices/models（:123/:186/:246）。未配置 TTS_API_URL 时：实时合成 400、预生成任务逐段 failed；tts.ts:125 `apiUrl: apiUrl!` 非空断言进一步把「未配置」掩盖为运行期异常。backend/.env.example 的变量名（TTS_URL/EDGETTS_URL）与实际读取名（TTS_API_URL/TTS_API_KEY，ttsProxyService.ts:17-18）不一致，误导部署。
3. **【P0】属性名错配（D10）**：index.ts:106 读 `settings?.voice_id`，schema.ts:165 行键实为 `voiceId` → 开机自动预合成永远用缺省音色，无视用户设置。
4. **【P1】缓存身份缺失（D14）**：缓存键仅 source|voice|speed|text（tts.ts:77,134），缺 model/apiUrl → 换模型/引擎命中旧音频；engineConfigHash 写入 jobs 表但全仓无消费者。
5. **【P1·越权】IDOR（D13）**：jobs 取消/批量取消/删除不校验 job.userId（tts.ts:459-462,474-481,500-507）；books.ts:952-972 与 :1248-1251 tts-generate 不校验书籍归属；tts.ts:315-318,80-82,139-141 userBookRefs 查询缺 user_id 过滤 → 可为他人书籍建任务并读取他人音频。
6. **【P1】死旋钮（D15）**：preGenerateConcurrency/firstChunkMaxSize/normalChunkMaxSize 有存取有 UI 但零消费者（分片硬编码 200：contentSegmentService.ts:17；并发硬编码 2：ttsGenerationService.ts:58）。
7. 其他：voiceCacheService.ts:99 LRU 淘汰按 user+voice 缺 book 维度（跨书误删）；ttsGenerationService.ts:192-201 setTimeout 不清理（每段泄漏 ≤120s 定时器）；:396-432 段失败无自动重试；缺省音色三处不一致（index.ts:106 回退 Xiaoxiao vs schema.ts:165 默认 alloy vs init.ts:498 种子 Xiaoxiao）。
8. **复核新增发现（2026-10-14）**：①source 枚举跨链路不一致（缓存/预生成链路与 edge 链路的 source 标签不统一，前端播放层重建时必须统一 source 口径，否则缓存二分）；②缓存指纹为无盐 md5 且无版本号，缓存键升级（4.2-4）后历史条目无法被动失效，需一次性清理；③IDOR 第四处：ttsGenerationService.ts:407 userBookRefs 查询同样缺 user_id 过滤（初稿仅列 tts.ts 三处）。

### 4.2 技术方案

**后端修复（先行，半天~1 天，独立可验收）：**

1. `.where()` 覆盖三处改为 `and(...条件数组)` 单次传入；补"不同文本不得命中同一缓存"的回归测试。
2. ttsProxyService 统一 `resolveApiUrl()`：synthesize 与后台生成同享 DEFAULT_API_URL 回退；.env.example 变量名与实际读取对齐。
3. index.ts:106 改读 `voiceId`；缺省音色统一收敛到一个常量模块。
4. 缓存键升级为 `source|model|apiUrlHash|voice|speed|text`，历史缓存键做一次清理（version 标记重建）。
5. IDOR：所有 job 操作 SQL 加 `AND user_id = ?`；tts-generate 校验 book 归属；userBookRefs 查询补 user_id。
6. 死旋钮二选一：接线（并发/分片真正读设置）或从 UI 移除——推荐接线，工作量小（两处常量改读 settings）。

**前端播放层重建（核心工作，3~5 天）：**

1. 新建 `reader/tts/` 播放模块：`TtsPlayer`（HTMLAudioElement 封装：播放/暂停/倍速/跳段）、`TtsScheduler`（按当前章节段落序拉取缓存音频，优先 batch-cache 预生成产物，miss 时实时 synthesize 兜底）、`useTtsSession`（会话状态机：idle/playing/paused/loading + 进度高亮联动）。
2. 阅读器接线：ReaderBottomBar 增加听书入口；播放时高亮当前段落并自动滚动跟随（scrolled 模式）/自动翻页（paged 模式，复用域一 next()）；章节边界自动续播；TtsOverlay 迷你播放条（可退出阅读器后台播放）。
3. 设置联动：no_cache 参数真正随请求携带；音色/倍速即改即生效（触发调度器重取）。
4. 错误体验：单段失败自动重试 1 次 → 跳过并 toast 汇总，不中断整章播放。
5. MediaSession 集成（锁屏控制），iOS Safari 静音键策略验证。

---

## 5. 域三：书籍缓存（D4、D16~D20）

### 5.1 现状诊断：一条"看起来在工作"的假链路

用户点书架"批量缓存" → `BookshelfPage.tsx:226` 调 `POST /api/books/batch-cache` → 后端只写服务端 `book_content_cache` 表（books.ts:1211-1231，逐本串行 await）→ 前端弹「已提交 N 本图书的离线缓存」成功 toast（:228）。**浏览器 IndexedDB 零写入**——用户以为缓存成功，实际设备上什么都没有（LibraryPage.tsx:103 单本入口同款，复核确认）。

同时，`offlineCacheService.ts`（实测 1,623 行）里一整套真实离线包**写侧实现零生产调用方**（行号已复核校准）：downloadOfflineEpubPackage(:539)、cacheBookChapters(:263)、cacheTTSAudio(:780)、validateOfflinePackage(:701)、clearBookCache(:1180)、getOfflineBookInfo(:386)、getBookCacheStatus(:968)——只在测试文件中被引用。IndexedDB v6 的七个 store 中六个（bookChapters/ttsAudio/epubResources/epubArchives/downloadSessions/offlinePackages）的生产 put 全部位于上述死链函数内，**永为空**；唯一生产写点是书架元数据 cacheShelfBooksMeta(:1295)。复核补注：「零调用」仅指写侧——读侧函数（getCachedEpubArchive:445、getCachedChapters:370 等）被 ReaderPage:168、BookshelfPage 生产调用，只是读到的 store 恒空。

后端侧同样空转：章节内容接口 `GET /:id/chapters/:chapterId/content`（books.ts:774-843）只读文件、从不查询 book_content_cache；contentCacheService.getCachedChapterContent 无任何路由调用——**内容只写不读，白占数据库**（复核补注：books.ts:571-580 统计接口会读该表做计数，但章节内容永不被服务）。

实现质量问题：
- SHA256 校验在非 HTTPS 环境 `crypto.subtle` 为 undefined 时恒返回 true（:418-423），损坏资源静默入库；
- 音频缓存键序错配：getTTSAudioKey 生成键含 `source:voice:rate` 段（:149-152，且 source/voice 经 encodeURIComponent），getBookCacheStatus 用未编码的 `voice:synthesisRate:source` 序做子串匹配（:981-982）→ 音色覆盖率统计恒 0（复核补注：仅统一键序还不够，profileKey 的编码差异需一并修）；
- 下载任一资源失败即整包标 failed（:680-695）；复核修正：downloadSessions 实际已用于断点跳过已完成项（:562-563、:599/:610/:627），真实缺口是**失败后无自动重试/恢复触发器**；manifest 每资源完成即全量重写（:658-660），O(n²)；
- 清理泄漏：clearBookCache(:1180)/clearAllCache(:1218) 事务仅含 5 store，漏清 offlinePackages + downloadSessions → 删缓存后幽灵 ready 包仍被 checkPackageStaleness(:742) 当有效包；
- 后端清单接口（books.ts:654-684）每次请求 readFileSync 全部文件 + 重算 sha256（:675），同步阻塞事件循环（books.ts:806 章节接口 EPUB 分支 readFileSync 同族）；
- **复核新增**：①死接口 `POST /:id/cache`（books.ts:929）无任何前端调用方；②batch-cache 逐本串行 await（books.ts:1219），大批量会长时间挂住请求但前端已弹「已提交」；③estimateCacheSize(:1232) 漏计 epubArchives/offlinePackages 占用；④downloadBatchCachedAudio(:1388) 音频入库无内容哈希校验。

### 5.2 技术方案

**架构决策：接线现有 offlineCacheService（推荐），不推倒重来。** 该模块 70% 能力已实现且测试覆盖（DB v6 schema、校验、断点表），缺的只是调用链。废弃路线（全部走 SW 缓存 API）会浪费已有实现且 SW 不适合大文件可靠存储。

1. **打通调用链**：书架单本/批量缓存按钮 → `downloadOfflineEpubPackage`（EPUB）/`cacheBookChapters`（TXT）→ 进度 UI（已有 UploadQueue 组件模式可复用）→ 完成后写 offlinePackages manifest → 才弹成功 toast。删除对 `/api/books/batch-cache` 的前端调用（保留后端接口供 TTS 预生成内部用，或一并评估下线）。
2. **缓存状态可视化**：书架每本书显示缓存状态徽标（无/部分/就绪/过期），数据源 getBookCacheStatus（修复 D18 键序后可用）。
3. **后端接口异步化**：清单接口改预计算（上传/解析完成时算好 manifest 存表，接口只读表返回）；sha256 计算移入上传管线。
4. **健壮性**：verifySha256 非安全上下文改为显式跳过校验并打标（而非伪通过）；失败资源级重试 + downloadSessions 真实续传；manifest 增量更新。
5. **清理补全**：clearBookCache/clearAllCache 补 offlinePackages/downloadSessions；openDB 处理 onblocked（提示关闭其他标签页）。
6. **TTS 音频缓存入库**：预生成完成的音频按现有 cacheTTSAudio 入 IndexedDB（域二播放层直接消费，形成闭环）。

---

## 6. 域四：离线看书（D5、D21、D22）

### 6.1 现状诊断：断网即不可用

- ReaderPage.tsx:111 `axios.get(/api/books/:id)` 无离线回退（且无 timeout；:137/:142 章节请求有 15s 超时）→ catch 直接「书籍加载失败」(:191)；`getOfflineBookInfo` 存在但无人调用。EPUB 虽先查 `getCachedEpubArchive`(:168)，但因域三断链归档恒为空 → 恒走网络文件 URL(:169)；TXT 分支 :141-146 逐章**串行** axios 拉取，零离线路径（N 章线性放大加载时间，性能与离线一并解决）。
- Service Worker 明确不管数据：public/sw.js:167-168 API 请求直接放行网络；:22 API_CACHE、:72 isBookFile、:76 isAPIRequest、:18 SW_VERSION 四个死符号——`sw.ts:7` 注释宣称的"已缓存 API 数据的离线回退"是假的，sw.js 头注释亦有 4 处失实（:2 版本号、:5 预缓存范围、:6 宣称运行时缓存书籍/TTS 音频、:9 宣称 API NetworkFirst）。:133-134 静态资源离线兜底错返 index.html（JS/CSS 以 HTML MIME 加载直接报错）；导航请求 5xx 不回退缓存(:96-122)；SW 版本 bump 自 v2.60.1 事故（version.ts:73）后为**手工规则**（:74 发布约定，v2.60.1→v4、v2.61.0→v5 均手动 bump），无构建期与 version.ts 自动联动（deploy.sh 全文零命中 SW 字串）。
- 仍可用的离线能力：书架元数据快照（cacheShelfBooksMeta）、离线模式登录旁路（AuthContext）、SW 静态壳与封面缓存、进度 localStorage 快照（useReaderProgress）。

### 6.2 技术方案（离线阅读闭环）

依赖域三先打通下载链路，本域补"消费侧"：

1. **ReaderPage 离线回退链**：书籍加载按 `元数据（IndexedDB 快照）→ EPUB 归档/TXT 章节（IndexedDB 包）→ 网络` 三级回退；检测 `navigator.onLine === false` 或请求失败时切换离线模式横幅（复用书架离线旁路的判定逻辑）。
2. **TXT 离线**：cacheBookChapters 产物直接作为 ReaderPage TXT 数据源，网络/离线同一条数据管道（先查 IndexedDB，miss 再 axios，成功后回填）。
3. **SW 整顿**：删除 API_CACHE/isBookFile/isAPIRequest/SW_VERSION 死符号与失实头注释（:2/:5/:6/:9）；静态资源离线兜底按扩展名返回正确资源（仅导航请求回退 index.html）；导航 5xx 回退缓存副本（导航 NetworkFirst 已于 v2.60.1 落地，此处补齐剩余项）；**SW 版本号与 frontend version.ts 联动自动 bump**（构建脚本注入；现状为 v2.60.1 起的手工 bump 规则），杜绝"发了新版 SW 不更新"事故复发。
4. **验收口径**：下载一本 EPUB + 一本 TXT → 断网 → 刷新、重开浏览器、直接进入阅读器三个场景均可完整阅读；进度离线可记、联网后同步。

---

## 7. 横切面：安全与架构（D6~D8、D23~D31）

### 7.1 P0 安全三项（Phase 0 必修）

| # | 漏洞 | 位置 | 攻击面 | 修复方案 |
|---|---|---|---|---|
| D6 | JWT 密钥硬编码兜底 | middleware/auth.ts:9 `process.env.JWT_SECRET \|\| 'ireader-jwt-secret-dev-only'`；两个 .env.example 均无该条目 | 知道该公开字符串即可离线伪造任意 userId 的 token，完全接管 API | 启动时强校验：缺失即 process.exit(1) 并打印配置指引；.env.example 补条目与生成命令注释 |
| D7 | 默认管理员后门 | db/init.ts:443-446 空库自动建 admin/admin123（注释自曝密码） | 新部署即弱口令入口；登录无速率限制可爆破 | 移除自动建号，改为首次启动引导创建（CLI 参数或首屏 setup 向导）；登录加速率限制（内存滑动窗即可） |
| D8 | 未鉴权 SSRF | routes/tts.ts:21(sources),27(voices),39(models),51(health),174(test) 均无 requireAuth，接受任意 apiUrl 服务端 fetch 并回显 | 内网端口扫描、云元数据端点读取 | 全部挂 requireAuth；apiUrl 限定必须来自服务端 settings（拒绝请求体传入），或加协议+私网地址黑名单 |

### 7.2 P1 安全与数据完整性

- **D23 封面路由零鉴权**（books.ts:420-457）：挂 optionalAuth（与 books.ts:715 file 路由同契约：带 token 校验归属、无 token 放行公开书）或直接 requireAuth；SVG 占位图不再回显书名。
- **D24 进度版本投毒**（progress.ts:57-81，客户端 incomingVersion 直入 max 计算，传 999999 即永久阻塞他端 ：66 恒拒）：progressVersion 改为服务端权威（服务端 max+1，客户端值仅作冲突检测参考，不参与 max 计算）；冲突响应改 409。
- **D25 apiKey 明文**（schema.ts:168, tts.ts:211,225-236）：GET /settings 返回脱敏（sk-****尾4位）；PUT 校验类型与长度；存储加密（AES-GCM，密钥派生自 JWT_SECRET 独立盐）或至少不再回显。
- **D29 进度表竞态**：reading_progress 加 `UNIQUE(user_id, book_id)` + `INSERT ... ON CONFLICT DO UPDATE`，消灭 select-then-insert 竞态（init.ts:74-86 DDL 无 UNIQUE、:509 仅非唯一索引 idx_rp_user_book）。
- **D34 注册白名单真实邮箱入库（复核新增·2026-10-14）**：backend/secUserEmail.json 硬编码 5 个真实个人邮箱并已提交进 git（commit 9801724），被 auth.ts:27-35 用作注册访问控制。①真实邮箱属隐私敏感信息，进 git 历史即永久暴露；②白名单与代码同仓，变更无审计。处置：移出仓库（.gitignore + 环境变量/挂载注入）；是否重写历史清除见 §12.2-6。

### 7.3 架构与工程质量

1. **D27 类型安全**：后端生产代码约 182 处 any（`any`/`as any` 共 218 行匹配；routes 层 64 处：books 37/tts 17/auth 8/categories 1/progress 1），全部路由工厂 `db: any`（books.ts:45、categories.ts:8、progress.ts:8、routes/auth.ts:54；唯 tts.ts:17 用 `ReturnType<typeof initDatabase>` 正确）。方案：路由工厂签名统一替换为正确类型（一次全局 sed + 编译驱动修复），收益是 Drizzle 查询类型检查全量恢复——**D3 的 `.where()` 覆盖 bug 在有类型约束下更难写出**。
2. **D28 schema 双真源**：drizzle schema.ts 与 init.ts 裸 SQL 并存且已漂移（books.pinned 仅在 schema.ts:29）。方案：以 drizzle-kit generate 生成迁移 SQL 为唯一迁移来源，init.ts 只执行迁移产物；补 drizzle.config.ts。
3. **D30 god file 与可靠性**：books.ts 1263 行拆分为 bookscrud/uploads/files/stats 四个路由模块；async 路由统一包 try/catch 或引入 express-async-errors（当前 tts.ts 全部 5 个 async handler :27/:39/:51/:63/:174 均无 catch，Express4 不接 rejection → 请求悬挂）；pbkdf2Sync 100k 轮（routes/auth.ts:72）与 execSync python 修复（parser/epub.ts:198-204，最长 15s）改异步；补 SIGTERM 优雅停机（index.ts 现零命中 SIGTERM）与 setInterval 清理（index.ts:85 每 30s tryProcessQueue）；cors 收敛为白名单。
4. **D26/D31/D33 工程卫生**：CI 改 pnpm（与 lockfile 一致）并移除 runner 自部署步骤（改为构建产物 artifact）；清理空文件 `1`、误建目录、.DS_Store（补 .gitignore）、.docx 镜像；TabView 接线或删除。
5. **测试基建**：CI 加入 `pnpm rebuild` 步骤防 ABI 漂移；为本次全部 P0 修复补回归测试（当前 D3/D9/D10 均无测试覆盖）。

---

## 8. 历史设计稿处置清单（避免新方案与存量冲突）

| 设计稿 | 状态 | 处置建议 |
|---|---|---|
| scroll-damping-refactor-design.md | **已设计未实施**（自述 v1.0 评审稿；scrollDamping.ts 仍 233 行，双参数插值/WeakMap 引用计数均在） | 纳入 Phase 1 手势底座一并实施 |
| offline-book-package-design.md | 大部分已实施（DB v6、downloadSessions、validate/staleness 在码），但 offlineCovers store 标注已完成而实际不存在 | 修订文档失实项后继续作为 Phase 3 蓝图 |
| phase1-tts-scheduling.md | 后端侧已实施（断点重算/快照/唯一索引），前端播放端缺失；复核修正：初稿把"覆盖率"归入后端侧不准确——覆盖率（getBookCacheStatus profile）实为前端 offlineCacheService.ts:968，且该文档 :95-97 前端 checklist 已全勾 | 作为 Phase 2 后端基线，补前端播放层 |
| reader-theme-sync / chrome-theme-manager / shelf-loading / design-tokens / ios-native-redesign | 已实施（残留尾巴：TabView 未接线、design-tokens 硬编码色未清完） | 尾巴项进 Phase 4 |
| apple-books-reader-design.md | 主体生效，翻页/书签/顶栏章节已被 2.48~2.51 移除 | 翻页交互规格（§3）作为 Phase 1 规格来源复活 |
| reading-mode-redesign / wx-reader-view / reader-wechat-reflow / gesture-upgrade-design | **已过时**（ReaderEngine/WxReaderView/useGesture 等承载文件已删除，仅 version.ts 历史注释残留） | 移入 docs/archive/，标注废弃 |
| optimization-design.md | 主体已实施，进度表滞后（downloadSession/SW 更新已完成仍标 ❌） | 更新进度表 |

---

## 9. 目标架构（升级后）

```mermaid
flowchart TB
    subgraph 前端
        BP[书架 BookshelfPage] -->|真实下载| DL[offlineCacheService 接线]
        DL -->|写入| IDB[(IndexedDB v6: 包/章节/音频/元数据)]
        RP[阅读器 ReaderPage] -->|三级回退: IDB→网络| IDB
        RP -->|next/prev: 点按分区/横滑/键盘| EC[EpubBookController<br/>paged + scrolled 双模式]
        RP -->|接线| TTS[TTS 播放层重建<br/>Player + Scheduler + Session]
        TTS -->|消费| IDB
        TTS -->|miss 兜底| API2[/api/tts 实时合成/]
    end

    subgraph 后端
        API[books/tts/progress 路由<br/>全量 requireAuth + 归属校验]
        GEN[ttsGenerationService<br/>apiUrl 回退 + 键含 model]
        CACHE[ttsCacheService<br/>and() 条件修复]
        API --> GEN --> CACHE
    end

    subgraph 安全基线
        S1[JWT_SECRET 启动强校验]
        S2[无默认管理员 + 登录限速]
        S3[SSRF 收口: 鉴权+服务端配置源]
    end

    TTS -->|预生成/实时| API
    DL -->|清单/文件| API
    SW[Service Worker v+1<br/>仅静态壳 + 版本联动 bump] -.-> RP
```

---

## 10. 分阶段实施路线图

| 阶段 | 主题 | 核心交付 | 预估工时 | 前置依赖 |
|---|---|---|---|---|
| **Phase 0** | 安全加固 | D6/D7/D8/D23 修复 + CI 修复（D26）+ 登录限速 | 1~2 天 | 无 |
| **Phase 1** | 阅读核心体验 | 双阅读模式、翻页 API、点按分区/横滑/键盘、tap 守卫三连修、阻尼重构 | 4~6 天 | 无（可与 P0 并行） |
| **Phase 2** | TTS 闭环 | 后端 6 项修复（1 天）+ 前端播放层重建 + 阅读器接线 | 4~6 天 | Phase 1（翻页 API 供自动翻页复用） |
| **Phase 3** | 缓存与离线闭环 | 下载链路接线、假成功修正、ReaderPage 三级回退、SW 整顿、后端异步化 | 5~8 天 | 无强依赖（建议在 P1 后） |
| **Phase 4** | 工程治理 | 类型清 any、schema 单真源、books.ts 拆分、可靠性、仓库/文档卫生 | 3~5 天（可拆散持续） | 无 |

总计约 **17~27 个工作日**。每阶段独立可验收、可发版（版本号按 .aiAgent-memory.md 规则递增：P0/P1 为 b 位，修 bug 为 c 位）。

---

## 11. Todolist（按阶段，可直接勾选跟踪）

### Phase 0 · 安全加固（P0，先于一切）✅ 已实施（v2.62.0，2026-10-15；实施口径备注见各条）

- [x] P0：JWT_SECRET 启动强校验，缺失即拒绝启动并输出配置指引（D6，middleware/auth.ts assertJwtSecret；deploy.sh 自动生成并持久化到部署目录 .env）
- [x] P0：删除空库自动创建 admin/admin123 逻辑，改为首启创建向导/CLI（D7，已拍板选 CLI：`pnpm create-user`；init.ts 旧数据迁移需显式传 initialUser）
- [x] P0：tts.ts 5 个免鉴权接口挂 requireAuth；~~apiUrl 一律取服务端设置~~ 实施口径经拍板调整：允许请求传入但仅限 http/https 协议（内网允许，保本机 TTS 场景），apiKey 掩码回退设置真值（D8，tts.ts + middleware/urlGuard.ts）
- [x] P0：登录接口加速率限制（内存滑动窗，5 次/分钟/IP）（D7 配套，middleware/rateLimit.ts；失败计数、成功不计入）
- [x] P1：封面路由鉴权 + SVG 占位图去掉书名回显（D23，optionalAuth 与 file 路由同契约；首字母一并移除）
- [x] P1：.github/workflows/deploy.yml 改 pnpm --frozen-lockfile、移除 runner 自部署步骤、加 pnpm rebuild 防 ABI 漂移（D26，改上传 artifact）
- [x] P1：backend/.env.example 补 JWT_SECRET/TTS_API_URL/TTS_API_KEY 并修正过期变量名（D6/D9 配套，另删除无人读取的 TTS_URL/EDGETTS_URL/MEGATTS3_URL）
- [x] P1（原 Phase 4 提前，经拍板并入）：GET /settings apiKey 掩码脱敏 + PUT 掩码不覆盖 + voices/models/health 掩码回退（D25）
- [x] P1（原 Phase 4 提前，经拍板并入）：进度版本号服务端权威，客户端值不参与 max 计算（D24；过期版本拒写保护保留）
- [ ] P1：backend/secUserEmail.json（真实邮箱白名单）移出仓库：.gitignore + 环境变量/挂载注入（D34）

### Phase 1 · 阅读核心体验（翻页 + 手势）

- [ ] P0：EpubBookController 增加 mode 参数，paged 模式启用 `flow:'paginated'`，scrolled 保持现状（3.3-1）
- [ ] P0：控制器实现并暴露 next()/prev()：paged 直通 rendition，scrolled 映射滚动一屏（3.3-2）
- [ ] P0：点按分区路由：左 1/4 上一页、右 1/4 下一页、中 1/2 菜单（onTap 内按 clientX 分区）（3.3-3）
- [ ] P0：横滑翻页：scrollDamping 方向锁拦截横滑，位移≥48px 触发翻页/切章（3.3-3，D12）
- [ ] P1：键盘 ←/→/PageUp/PageDown/空格 绑定翻页（3.3-3）
- [ ] P1：paged 模式 180ms 翻页过渡动画（3.3-3）
- [ ] P1：设置页新增阅读模式切换并持久化（3.3-1）
- [ ] P1：tap 桥接补 pointercancel 清理（D11，EpubBookController.ts:363-365）
- [ ] P1：handleTapEnd 加选区 isCollapsed 与链接元素守卫（D11，:391-400）
- [ ] P2：tap 位移阈值统一 6px，消除微拖双触发（D11）
- [ ] P1：实施 scroll-damping-refactor-design.md 三层管线重构（已设计未实施）
- [ ] P1：翻页/手势单元测试：分区路由、横滑阈值、pointercancel、选区守卫；更新 ReaderPage.test.tsx 基线

### Phase 2 · TTS 闭环

- [ ] P0：ttsCacheService 三处链式 `.where()` 改 and() 单传（findCache/findCachedSegmentsByBook/clearAllCache）（D3，:72-77/:184-187/:244-247）
- [ ] P0：补回归测试：不同文本不得命中同一缓存音频、batch-cache 不跨书（D3）
- [ ] P0：ttsProxyService 统一 resolveApiUrl()，synthesize 与后台生成共享默认回退（D9）
- [ ] P0：index.ts:106 `voice_id` 改 `voiceId`；缺省音色收敛单常量（D10）
- [ ] P1：缓存键升级含 model/apiUrlHash，历史缓存标记重建（D14）
- [ ] P1：jobs 取消/删除/清空补 user_id 条件；tts-generate 校验书籍归属；userBookRefs 补 user_id（D13）
- [ ] P1：死旋钮接线：并发/分片大小真实读 settings（D15）
- [ ] P1：段失败自动重试 1 次；synthesizeWithTimeout 定时器清理（ttsGenerationService.ts:192-201,396-432）
- [ ] P0：前端重建 reader/tts 播放层：Player/Scheduler/useTtsSession（4.2）
- [ ] P0：ReaderBottomBar 听书入口 + 播放中段落高亮自动跟随/自动翻页（paged 模式复用 next()）（4.2-2）
- [ ] P1：TtsOverlay 迷你播放条 + MediaSession 锁屏控制（4.2-2）
- [ ] P1：no_cache 参数随请求携带，开关生效（4.2-3）
- [ ] P1：voiceCacheService LRU 淘汰补 book 维度；README TTS 章节纠偏（删除"501"失实描述）
- [ ] P2：source 枚举跨链路统一；tts.ts:125 apiUrl! 断言移除；userBookRefs 第四处补 user_id（ttsGenerationService.ts:407）

### Phase 3 · 缓存与离线闭环

- [ ] P0：书架缓存按钮改调 downloadOfflineEpubPackage/cacheBookChapters，真实写 IndexedDB 后才弹成功（D4，BookshelfPage.tsx:226-228；LibraryPage.tsx:103 同）
- [ ] P0：删除前端对 /api/books/batch-cache 的假缓存调用（保留后端接口评估内部用途）（D4）
- [ ] P1：书架缓存状态徽标：无/部分/就绪/过期（数据源 getBookCacheStatus）（5.2-2）
- [ ] P1：verifySha256 非安全上下文显式跳过并打标，不再伪通过（D17，:418-423）
- [ ] P1：音频缓存键序统一（getTTSAudioKey 与 getBookCacheStatus 同序），覆盖率统计可用（D18）
- [ ] P1：资源级失败重试 + downloadSessions 真实续传；manifest 增量更新去 O(n²)（5.2-4）
- [ ] P1：clearBookCache/clearAllCache 补清 offlinePackages/downloadSessions；openDB 处理 onblocked（D19）
- [ ] P1：后端离线清单接口改预计算读表；sha256 移入上传管线（D20，books.ts:654-682）
- [ ] P1：章节内容接口接入 book_content_cache 查询（或删表，二选一杜绝只写不读）（D16）
- [ ] P0：ReaderPage 离线三级回退：元数据→本地包→网络；离线模式横幅（D5，:111）；元数据请求补 15s timeout（与 :137/:142 对齐）
- [ ] P0：TXT 阅读走 IndexedDB 优先数据管道（6.2-2）
- [ ] P1：sw.js 删 API_CACHE/isBookFile/isAPIRequest/SW_VERSION 死符号与失实头注释；静态兜底按扩展名返回正确资源；导航 5xx 回退缓存副本（D21；导航 NetworkFirst 已于 v2.60.1 落地）
- [ ] P1：SW 版本号构建期与 version.ts 联动自动 bump（D22）
- [ ] P1：离线验收：下载 EPUB+TXT 各一本 → 断网刷新/重开/直进阅读器三场景全通过（6.2-4）
- [ ] P2：预生成 TTS 音频入库 IndexedDB，与播放层闭环（5.2-6）
- [ ] P2：缓存域卫生四件套：死接口 POST /:id/cache 下线评估（books.ts:929）；estimateCacheSize 补计 epubArchives/offlinePackages（:1232）；音频入库补哈希校验（:1388）；getBookCacheStatus profileKey 编码与键序一并修（:981-982）
- [ ] P2：TXT 章节拉取并行化 + versionHash 失效策略（ReaderPage.tsx:141-146/:168-169，随 Phase 3 数据管道一并处理）

### Phase 4 · 工程治理（可拆散持续）

- [ ] P1：路由工厂 `db: any` → `ReturnType<typeof initDatabase>`，编译驱动清剩余 any（D27）
- [ ] P1：drizzle.config.ts + drizzle-kit generate 迁移为唯一真源，init.ts 只执行产物（D28）
- [ ] P1：reading_progress 加 UNIQUE(user_id,book_id) + ON CONFLICT 更新（D29）
- [ ] P2：books.ts 拆分 crud/uploads/files/stats 四模块（D30）
- [ ] P2：async 路由统一错误处理（express-async-errors 或包装器）；pbkdf2/execSync 异步化；SIGTERM 优雅停机；cors 白名单（D30）
- [ ] P2：进度版本号服务端权威 + 409；GET /settings apiKey 脱敏（D24/D25，可与 P0 一起做）→ ✅ 已提前至 Phase 0 实施（v2.62.0；409 改造未做，conflict 仍为 200+标志位以保持前端兼容）
- [ ] P2：仓库卫生：删空文件 `1`/误建目录、.gitignore 补 .DS_Store（git 已跟踪 2 个，磁盘另有未跟踪散落）、.docx 镜像归档（3 份）、e2e 死脚本清理（e2e_reader.py 引用已删翻页按钮）或入 scripts/（D31）
- [ ] P2：文档纠偏：README/sw.ts/offline-book-package-design/optimization-design 失实项更新（D32）
- [ ] P2：TabView 接线或删除（D33）
- [ ] P2：过时设计稿移入 docs/archive/（reading-mode-redesign、wx-reader-view、reader-wechat-reflow、gesture-upgrade-design）

---

## 12. 风险、依赖与待拍板决策点

### 12.1 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| epub.js paginated 模式与现有 iframe sandbox/click 桥接的兼容性（WebKit 218086 教训） | Phase 1 分页模式可能在 iOS Safari 出现点击桥接失效 | 复用现有 allowScriptedContent 方案；Phase 1 首项即做 iOS 真机冒烟 |
| scrolled 模式"翻一屏"在连续拼接容器中的边界效果（章节中间起止错位） | 翻页落点不精确 | 以 epub.js locations 锚点对齐视口顶部，而非按像素滚动 |
| TTS 播放层重建期间旧预生成数据（不含 model 维度缓存键）混合命中 | 换模型后仍播旧音频 | Phase 2 缓存键升级时整体清一次 tts_cache（已有 evictStaleCache 可扩展） |
| better-sqlite3 ABI 漂移复发 | 测试静默全挂 | CI 加 rebuild 步骤；本地文档记录 Node 升级后必须 rebuild |

### 12.2 待拍板决策点（需用户确认后进入对应 Phase）

1. **翻页方案**：方案 A（回归分页双模式，推荐，工作量 4~6 天）vs 方案 B（滚动-only + 点按翻屏过渡，1~2 天）？若选 A，分页是否作为默认模式？
2. **默认管理员处置**：直接移除自动建号（需用户首次启动时创建账号）vs 保留但强制首登改密？
3. **死代码处置原则**：offlineCacheService 接线复活（推荐，本方案默认）确认后，BookshelfPage/LibraryPage 的 batch-cache 假入口是否直接下线后端接口？
4. **TTS 死旋钮**：接线生效（推荐）vs 从设置 UI 移除？
5. **Phase 0 安全修复涉及行为变化**（JWT 必填、接口全鉴权）：私有化部署场景是否存在必须保留匿名访问的客户端？如有请指出，SSRF 收口方案需相应调整。
6. **D34 白名单处置**（复核新增）：secUserEmail.json 移出仓库（前进修复）无争议；是否进一步**重写 git 历史**清除已泄露邮箱（改写全部后续 commit hash，需强推 + 协作方配合）取决于仓库私有性与合规要求，需拍板。

### 12.3 验收基线（当前实测，供升级后对比）

| 指标 | 当前值（2026-10-13 实测） |
|---|---|
| typecheck | 双端通过 |
| 后端测试 | 8 文件 / 98 用例全绿（需先 `pnpm rebuild better-sqlite3`） |
| 前端测试 | 29 文件 / 239 用例全绿 |
| 阅读器翻页能力 | 无（架构性缺失） |
| 阅读器 TTS 能力 | 无（播放层缺失） |
| 离线阅读能力 | 无（链路断裂，仅书架元数据/静态壳可离线） |
| 安全 P0 | 3 项（D6/D7/D8） |

---

## 13. 复核新增发现汇总（2026-10-14，原评审遗漏项）

> 复核方式：6 域并行对照代码勘察 + 主评审对全部「零调用/死代码」类强断言亲自二次检索。以下 23 项均已定位到 文件:行，标注 ★ 的已并入 §11 对应 Phase todolist。

**域一·翻页/手势（4 项）**
1. wheel 拦截器不处理横向 deltaX，触控板横滑语义未定义（scrollDamping.ts wheel 路径）——横滑翻页落地时一并接管 ★
2. touch-action 三套政策并存：index.css:146 全局 manipulation / index.css:643 死样式 pan-y / scrollDamping.ts:107 运行时 pan-x pinch-zoom ★（随手势底座收敛）
3. tap pointerup/click 双路径去重不对称，特定时序菜单双翻转窗口（EpubBookController.ts:391-407）★（并入 D11）
4. e2e_reader.py:110-113 引用 2.48.0 已删除的翻页按钮，死脚本 ★（Phase 4）

**域二·TTS（4 项）**
5. source 枚举跨链路不一致（openai vs edgetts），播放层重建前必须统一 ★（Phase 2）
6. tts.ts:125 `apiUrl!` 非空断言掩盖「未配置」故障为运行期异常 ★（随 D9 修）
7. ttsGenerationService.ts:407 userBookRefs 第四处缺 user_id（初稿仅列 tts.ts 三处）★（并入 D13）
8. 缓存指纹无盐 md5 且无版本号，键升级后历史条目无法被动失效（tts.ts:77,134）★（随 D14 键升级一次性清理）

**域三·缓存（5 项）**
9. 死接口 `POST /:id/cache`（books.ts:929）零前端调用 ★（Phase 3/4 下线评估）
10. batch-cache 逐本串行 await（books.ts:1219），大批量长时间挂住请求而前端已报成功 ★（随 D4 异步化）
11. estimateCacheSize(:1232) 漏计 epubArchives/offlinePackages ★（Phase 3）
12. downloadBatchCachedAudio(:1388) 音频入库无内容哈希校验 ★（Phase 3）
13. getBookCacheStatus profileKey 未 encodeURIComponent（:981-982），与 getTTSAudioKey(:151) 编码不一致——修 D18 必须键序+编码一起修 ★（Phase 3）

**域四·离线/SW（5 项）**
14. sw.js 头注释 4 处失实（:2 版本、:5 预缓存范围、:6 书籍/TTS 运行时缓存、:9 API NetworkFirst）★（随 D21 清理）
15. 死符号扩容：isAPIRequest(:76)、SW_VERSION(:18) 零消费 ★（随 D21 清理）
16. ReaderPage.tsx:111 书籍元数据请求无 timeout（:137/:142 均有 15s）★（Phase 3 随 D5）
17. TXT 逐章串行拉取（:141-146），N 章线性放大加载时间 ★（Phase 3）
18. ReaderPage.tsx:168-169 归档 versionHash 已弃用但无失效策略——域三接通后可能永久读旧归档 ★（Phase 3 设计明确版本失效规则）

**横切·安全与治理（5 项）**
19. ★★ D34：backend/secUserEmail.json 5 个真实个人邮箱入库（commit 9801724）作注册白名单（auth.ts:27-35）——隐私泄露 + 访问控制单点，建议 Phase 0/1 移出仓库
20. version.ts:52-68 版本记录乱序（违背 :12 自述的尾部追加规则）——纯记录卫生
21. design-tokens 硬编码色残留（index.css 抽查 2 处 hex 直写）——印证 §8 判断，精确清单可 grep 统计
22. frontend/package-lock.json 与 pnpm-lock.yaml 双真源并存（D26 复核时发现）——Phase 4 统一为 pnpm 单真源
23. docs/ 3 份 .docx 为纯镜像副本，归档时只留一份真源（Phase 4）

---

*本文档由全量代码评审生成：四域勘察报告 + 主评审二次复核 + 运行期实测；2026-10-14 全量复核修订（§2.1 结论修正与行号校准、§13 新增 23 项），所有失实与遗漏项已当轮修正并入，未发现被推翻的核心结论。引用位置格式为 文件:行，可直接跳转核对。*
