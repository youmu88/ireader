# iReader 全面优化设计文档

**文档版本**：v1.0
**审查基线**：2026-07-15
**适用范围**：语音预合成、EPUB 解析、阅读器、界面布局、朗读体验、离线模式、数据一致性与工程质量
**目标**：将当前“功能可运行但链路分散”的实现，收敛为内容模型统一、在线离线一致、可恢复、可观测、可测试的阅读与听书系统。

## 1. 现状结论

项目采用前后端分离架构：后端为 Express + SQLite + Drizzle，前端为 React + Vite + epub.js + IndexedDB。主要入口为 [backend/src/index.ts](/Users/wilsonwen/workspace/ireader/backend/src/index.ts)、[ReaderPage.tsx](/Users/wilsonwen/workspace/ireader/frontend/src/pages/ReaderPage.tsx)、[EpubViewer.tsx](/Users/wilsonwen/workspace/ireader/frontend/src/components/EpubViewer.tsx) 和 [offlineCacheService.ts](/Users/wilsonwen/workspace/ireader/frontend/src/services/offlineCacheService.ts)。

当前优点：

- EPUB 和 TXT 均有上传、解析、目录、进度保存能力。
- EPUB 已接入 epub.js，支持 CFI 进度、分页/滚动模式、主题和字体设置。
- TTS 已具备实时合成、后台预合成、用户级缓存、全局资源复用、前端 IndexedDB 音频缓存和 Media Session 基础能力。
- 已实现主动离线模式、书架元数据缓存、章节文本缓存和本地音频缓存。
- 手势、文字选择、长按菜单已经从多个历史实现逐步合并，但仍需要与阅读内容模型进一步解耦。

当前主要问题不是单个按钮或样式缺陷，而是以下结构性问题：

1. EPUB 章节在解析、章节接口、epub.js spine、TTS 提取、前端缓存中存在多种不同语义。
2. 预合成任务以“估算分段数”创建，以“另一套实际分段算法”执行，进度和恢复无法精确对应。
3. 在线播放、服务端缓存、前端缓存、离线播放分别实现了缓存身份，容易出现错配、漏命中或旧音频复用。
4. 离线模式只缓存文本和音频，EPUB 阅读所需的原始 ZIP、XHTML、CSS、图片、字体和目录资源没有形成完整离线包。
5. [ReaderPage.tsx](/Users/wilsonwen/workspace/ireader/frontend/src/pages/ReaderPage.tsx) 约 148KB，[BookshelfPage.tsx](/Users/wilsonwen/workspace/ireader/frontend/src/pages/BookshelfPage.tsx) 约 64KB，页面同时承担数据请求、缓存、搜索、阅读布局、TTS、进度、手势和弹层，修改风险和回归成本很高。
6. 当前视觉系统有较多积极的 iOS 风格尝试，但 Tailwind、内联 style、全局 CSS 和历史兼容代码并存，导致组件间间距、按钮、弹窗、颜色和移动端安全区不完全一致。

## 2. 关键缺陷分级

### P0：必须优先修复

#### P0-1 EPUB 内部资源接口存在越权风险

[backend/src/routes/books.ts](/Users/wilsonwen/workspace/ireader/backend/src/routes/books.ts) 中的 `GET /:id/file/*` 为兼容 epub.js 子请求而不使用 `requireAuth`，只校验书籍 ID 是否存在，没有校验当前用户是否拥有该书。任何知道书籍 ID 的请求都可能读取其他用户的 EPUB 内部 XHTML、图片、CSS 或字体。

**设计要求**：

- epub.js 请求必须携带 Authorization header，内部资源接口恢复 `requireAuth`。
- 同时校验 `books.user_id = req.user.userId`，或通过 `user_book_refs` 校验有效引用。
- 路径校验统一使用 `path.resolve` 后判断 `resolvedPath === root || resolvedPath.startsWith(root + path.sep)`，不能仅使用字符串 startsWith。
- 不允许通过该接口访问原始 ZIP 之外的任意路径。
- 增加跨用户访问的集成测试。

#### P0-2 预合成分段模型不统一

[backend/src/services/ttsGenerationService.ts](/Users/wilsonwen/workspace/ireader/backend/src/services/ttsGenerationService.ts) 创建任务时按章节偏移量估算每 200 字符一段，实际执行时又先按句子再按 200 字符拆分；EPUB 还存在服务端锚点提取和前端 `stripHtml` 两套文本清理逻辑。结果会造成：

- `totalChunks` 与实际分段数不同。
- 进度百分比前后跳变或无法达到真实覆盖率。
- 任务重启时无法知道某个段落是否已经完成。
- 前端批量下载的 segmentIndex 与服务端实际合成段序不一定一致。

**设计要求**：先生成持久化的 `content_segments`，再执行 TTS。分段必须由唯一的内容规范化模块完成，任务只处理已有段，不再自行重新切分。

#### P0-3 部分章节预合成实际上可能处理全书

`createPartialGenerationJob` 只在创建时查询前 N 章，但 `processJob` 重新按 `bookId` 查询全部章节，没有把章节范围或章节 ID 列表保存在任务中。用户选择“预合成前 N 章”时，任务可能仍然处理全书。

**设计要求**：任务表增加 `scope_type`、`scope_start_order`、`scope_end_order` 或独立任务段表；执行时只处理任务快照中的章节 ID。

#### P0-4 全局 TTS 引用创建存在空引用风险

预合成服务中创建全局资源后没有始终将新建资源对象回写到 `existing` 变量，随后创建 `tts_refs` 时使用 `existing?.id`，新资源场景可能插入空的 `global_resource_id` 或错误引用。

**设计要求**：统一使用事务函数 `getOrCreateGlobalTtsResource()`，返回确定的资源 ID；创建资源、用户引用、缓存索引必须在同一事务中完成，并增加外键和非空约束测试。

#### P0-5 离线 EPUB 不是完整离线阅读

当前 IndexedDB 主要缓存章节文本和 TTS 音频；Service Worker 只预缓存 App Shell，运行时也没有可靠缓存 EPUB 内部 XHTML、CSS、图片、字体和原始文件。离线进入 EPUB 阅读页时，epub.js 仍可能请求 `/api/books/:id/file/*`，导致正文样式、图片、目录或整本渲染失败。

**设计要求**：离线下载 EPUB 时生成完整的 `OfflineBookPackage`，至少包括书籍元数据、章节结构、规范化正文、原始 EPUB 资源或等价渲染资源、封面和阅读进度。离线阅读优先使用本地包，不再依赖服务器接口。

### P1：影响核心体验和维护成本

#### P1-1 EPUB 章节语义重复实现 ✅

EPUB 解析在 [backend/src/parser/epub.ts](/Users/wilsonwen/workspace/ireader/backend/src/parser/epub.ts) 中以 flow/spine 为主，再用 TOC 锚点补充单文件合集；章节接口又通过正则截取锚点；TTS 服务再次使用另一套正则提取锚点；前端 epub.js 又使用 spine index 跳转目录。这会造成目录项、阅读位置、文本缓存和语音段落互相错位。

**设计要求**：建立统一章节模型：

```text
Book
  └─ Chapter
       ├─ stableId
       ├─ order
       ├─ level
       ├─ title
       ├─ sourceHref
       ├─ fragment
       ├─ spineIndex
       ├─ rawContent
       ├─ normalizedText
       └─ contentHash
```

目录展示、epub.js 跳转、章节接口、离线缓存、TTS 均只使用该模型。

#### P1-2 EPUB 章节缓存存在锚点路径错误 ✅

[backend/src/services/contentCacheService.ts](/Users/wilsonwen/workspace/ireader/backend/src/services/contentCacheService.ts) 对 EPUB 直接使用 `chapter.href` 拼接文件路径，没有移除 `#fragment`。含锚点的单文件 EPUB 会缓存失败或取不到文件。

**设计要求**：统一调用 `resolveChapterResource(chapter)`，内部拆分 href 和 fragment，先读取资源，再按 DOM 结构截取片段；不得在多个业务模块复制字符串正则。

#### P1-3 章节内容接口返回原始 HTML，前端多处自行清洗 ✅

当前 EPUB 正文、全文搜索、TTS、离线缓存分别使用不同的 HTML 清洗方式。简单正则不能可靠处理嵌套标签、脚本、样式、实体、CDATA、表格、ruby、注音和 block 结构。

**设计要求**：后端解析阶段产出：

- `rawHtml`：用于富文本/epub.js 渲染。
- `normalizedText`：用于搜索、TTS、摘要和纯文本阅读。
- `contentHash`：用于缓存失效和增量更新。

前端不再自行实现 `stripHtml` 的业务版本。

#### P1-4 TTS 任务不具备真正的断点续跑

当前卡住任务恢复后将 `progress` 和 `completedChunks` 重置为 0，且没有逐段任务状态。已完成音频只能通过文本缓存间接判断，无法保证任务状态、资源状态和统计状态一致。

**设计要求**：增加 `tts_generation_segments`：

```text
id, job_id, book_id, chapter_id, segment_id,
status, attempt_count, audio_resource_id, error,
started_at, finished_at, updated_at
```

任务恢复时只重试 `pending`、超时 `running` 和可重试 `failed` 的段。

#### P1-5 TTS 任务缺少 source 维度

TTS 缓存已开始纳入 source，但任务表、任务去重、任务列表和预合成入口仍主要按 book、voice、speed 判断。切换引擎但音色和语速不变时，可能错误复用旧任务或显示错误进度。

**设计要求**：所有 TTS 身份统一为：

```text
source + voice + speed + text/contentHash + outputFormat + engineConfigHash
```

自定义 API 地址、版本或关键参数发生变化时，通过 `engineConfigHash` 使缓存自然失效，禁止把 API Key 明文放入 hash 或前端缓存。

#### P1-6 服务端 TTS 缓存并发写入不够可靠

实时 POST 请求和后台预合成可能同时发现缓存不存在并重复合成、重复写文件、重复插入记录。当前文件名和数据库写入缺少统一的数据库唯一键和锁定流程。

**设计要求**：增加唯一索引：

```text
(global_book_id, chapter_id, segment_id, source, voice, speed, content_hash, format)
```

采用“插入占位记录 → 竞争失败则等待已有记录 → 合成完成原子替换文件”的流程。

#### P1-7 前端 IndexedDB 缓存版本和统计模型不完整

[frontend/src/services/offlineCacheService.ts](/Users/wilsonwen/workspace/ireader/frontend/src/services/offlineCacheService.ts) 的音频 key 已包含语音配置和文本指纹，但 `cacheMeta.cachedAudioSegments` 统计所有配置的变体，不能代表当前设置下的可播放覆盖率。旧版本 key 也没有明确迁移或删除策略。

**设计要求**：

- 缓存 key 使用结构化字段，不依赖拼接字符串。
- 每个缓存包记录 `contentHash`、`ttsProfileHash`、`schemaVersion`。
- 统计按当前 profile 计算，区分“已缓存变体”和“当前可播放覆盖率”。
- 升级时删除无法验证身份的旧音频，避免误播。
- 所有 Blob/ArrayBuffer 大小计算统一使用 `toArrayBuffer()`。
- 增加容量超限、QuotaExceededError、浏览器清理存储和事务中断的用户提示。

#### P1-8 前端下载批量缓存缺少真正的离线包事务

当前批量下载逐段并发请求后再批量写 IndexedDB。下载到一半断网或页面被杀死时，可能留下不可见的半包；元数据又可能显示可用。

**设计要求**：引入 `downloadSession`：

```text
sessionId, bookId, contentHash, ttsProfileHash,
totalItems, completedItems, status, updatedAt
```

只有所有必需资源完成并校验后才将包标记为 `ready`；离线播放只读取 `ready` 包，未完成包显示“可续传”。

### P2：影响体验、视觉和长期演进

#### P2-1 阅读页面职责过重

[ReaderPage.tsx](/Users/wilsonwen/workspace/ireader/frontend/src/pages/ReaderPage.tsx) 同时负责书籍加载、章节导航、TXT 分页、EPUB 状态、全文搜索、TTS 播放、预合成、缓存、离线、阅读进度、弹出菜单和手势。任何改动都会触发大量隐式依赖。

**设计要求**：拆成以下模块：

- `useBookSession`：书籍、章节、内容和版本。
- `useReadingProgress`：本地草稿、远端同步、冲突处理。
- `useOfflineBook`：离线包下载、状态和清理。
- `useSpeechSession`：播放、预取、跨章、语音 profile。
- `useReaderGestures`：点击、滑动、长按、文字选择。
- `ReaderShell`：顶栏、底栏、浮动菜单和弹层。
- `TxtRenderer` / `EpubRenderer`：只负责渲染。

#### P2-2 播放器存在复杂且脆弱的 WAV 拼接分支

[TTSPlayer](/Users/wilsonwen/workspace/ireader/frontend/src/services/ttsPlayer.ts) 同时支持逐段播放、后台拼接、跳转、跨章追加、预取和 Blob URL 生命周期。WAV 解析固定假设头部 44 字节、PCM 格式和 `data` 位于固定偏移；遇到扩展 fmt chunk、非 PCM、不同采样率或压缩格式时会失败。拼接模式只拼接当前已就绪片段，后续片段仍可能无法连续进入同一个音频源。

**设计建议**：短期保留逐段 `<audio>` 播放作为可靠主路径，后台只做“预取保证”；中期由服务端输出标准化、可拼接的音频格式，或使用 MediaSource/服务端章节级音频，不在浏览器手写 WAV 解析器。

#### P2-3 语速语义不清

当前 `speed` 既作为服务端 TTS 合成参数，又通过 `HTMLAudioElement.playbackRate` 再次改变播放速度。用户调速时可能既改变音频生成身份，又改变播放倍速，导致体验和缓存语义混乱。

**设计要求**：分离为：

- `synthesisRate`：影响生成音频和缓存身份。
- `playbackRate`：本地播放倍速，不改变缓存身份。

设置页和播放器分别展示，默认只改变播放倍速；用户明确选择“重新合成语速”时才触发新 profile。

#### P2-4 跨章预取缺少上下文校验

预取结果当前通过 generation 和数组保存，仍需确保 chapterId、contentHash、ttsProfileHash 同时匹配。文本刷新、设置切换、章节重解析后，旧预取必须立即作废。

**设计要求**：预取对象携带完整 session key，不匹配时释放 Blob URL 和丢弃结果。

#### P2-5 阅读进度同步缺少冲突策略

EPUB 使用 CFI，TXT 使用 pageIndex/textOffset/percentage，TTS 又有独立的播放进度。没有统一的版本号、设备来源和最后写入策略，多个设备或离线恢复时可能相互覆盖。

**设计要求**：

```text
progressVersion, deviceId, updatedAt, source,
readingPosition, speechPosition
```

采用本地优先草稿 + 在线合并；阅读位置与语音位置分离保存，语音播放不直接覆盖阅读位置。

## 3. 目标架构

### 3.1 统一内容管线

```text
上传
  → 文件校验与 hash
  → EPUB/TXT 解析
  → 统一 ChapterManifest
  → rawHtml / normalizedText / contentHash
  → 持久化章节与资源清单
  → 阅读渲染、搜索、TTS、离线包共同消费
```

`ChapterManifest` 是所有功能的唯一事实来源。任何模块不得再自行从原始文件解析章节标题、锚点或文本。

### 3.2 统一语音管线

```text
ChapterManifest
  → SegmentManifest
  → TTSProfile
  → SegmentGenerationJob
  → AudioResource
  → Server Cache / IndexedDB Offline Package
  → Player
```

建议新增实体：

- `tts_profiles`：source、voice、synthesisRate、format、engineConfigHash。
- `content_segments`：chapterId、segmentIndex、text、textHash、startOffset、endOffset。
- `tts_audio_resources`：segmentId、profileId、status、path、size、duration、checksum。
- `tts_generation_jobs`：范围、快照、状态、统计。
- `tts_generation_segments`：逐段状态和重试信息。

### 3.3 统一离线包

```text
OfflineBookPackage {
  packageId,
  bookId,
  bookVersionHash,
  manifestVersion,
  metadata,
  chapters,
  epubResources,
  ttsProfiles,
  audioSegments,
  progress,
  status: downloading | ready | stale | failed,
  bytes,
  updatedAt
}
```

离线模式的判定只决定“禁止网络写操作和远端读取”，不应改变业务数据结构。阅读器始终从 `BookSession` 读取内容，在线和离线只更换 `BookSessionRepository` 实现。

## 4. EPUB 优化设计

### 4.1 解析器目标

- 支持 EPUB 2 NCX、EPUB 3 nav、标准 spine、单文件锚点章节和嵌套目录。
- 正确解析 OPF 所在目录、相对 href、URL 编码和 fragment。
- 保留目录层级，不把同一资源的多个目录节点错误去重。
- 通过 DOM/XML 解析提取章节内容，避免依赖脆弱正则。
- 识别封面、目录、版权页、插图等非正文节点，并允许用户选择是否参与 TTS。
- 处理 UTF-8、XML 实体、ruby、注音、表格、脚注、图片 alt 文本和换行。
- 上传时校验 ZIP 结构、mimetype、container.xml、OPF、文件名规范、解压大小和压缩炸弹风险。

### 4.2 解析失败与可修复文件

当前通过执行 Python 脚本修复二次包装 EPUB。该方案应改为纯 Node 实现或隔离的受限解析进程：

- 不依赖生产环境是否安装 Python。
- 限制 CPU、内存、临时目录和单文件大小。
- 记录原始文件 hash、修复类型、修复结果和错误原因。
- 修复后的文件生成新的 `normalizedFileHash`，原始文件仍保留审计关系。
- 失败时返回可操作错误：缺少 mimetype、OPF 无效、资源缺失、编码错误等。

### 4.3 渲染策略

推荐长期采用“服务端统一 manifest + 前端本地资源适配器”：

- 在线 EPUB：epub.js 继续承担排版和 CFI。
- 离线 EPUB：优先从 IndexedDB 资源适配器读取，提供与 epub.js request 接口兼容的本地 URL。
- 对单文件锚点章节，阅读、目录和 TTS 均使用同一 `chapterId + fragment`。
- 目录跳转不能简单把业务章节索引当作 spine index，必须通过 manifest 的 `spineIndex` 或 href/fragment 映射。

## 5. 语音预合成与朗读设计

### 5.1 预合成用户流程

1. 用户选择书籍、章节范围、语音 profile 和是否下载到本地。
2. 系统展示预计段数、预计大小、预计耗时和当前已有覆盖率。
3. 创建幂等任务；相同书籍版本、范围和 profile 的任务复用。
4. 后端生成固定 SegmentManifest，逐段执行。
5. 每完成一个段，更新段状态、音频 checksum、大小和累计覆盖率。
6. 前端通过 SSE/WebSocket 或退避轮询获取进度，不固定 3 秒高频轮询。
7. 生成完成后，用户可以选择“仅服务器可用”或“下载为离线包”。
8. 下载中断后可续传，只有离线包完整才显示“可离线朗读”。

### 5.2 播放策略

缓存优先级：

```text
当前离线包 ready 音频
  > 浏览器 IndexedDB 当前 profile 音频
  > 服务端全局资源
  > 服务端用户资源
  > 在线实时合成
```

每一级命中都必须验证：`bookVersionHash + chapterId + segmentId + textHash + profileHash + audioChecksum`。任何字段不匹配都视为 miss，不允许按 chapterId 和 segmentIndex 猜测。

### 5.3 朗读易用性

- 首次点击后优先播放本地已有第一段，后续异步预取。
- 明确显示“正在读取缓存”“正在合成第 N 段”“离线缺少第 N 段”。
- 播放控制固定在底部 Mini Player：播放/暂停、上一段、下一段、章节、倍速、音量、睡眠计时。
- 点击当前朗读文本可跳转阅读位置，但不改变阅读进度除非用户确认。
- 语速播放倍速与合成语速分离。
- 锁屏控制补充上一章、下一章、快退 15 秒、快进 30 秒。
- 切换音色/profile 时停止当前预取并明确提示“已有缓存仍保留，但新 profile 需重新生成”。
- 失败段支持“重试本段”“跳过本段”“停止朗读”，不自动静默跳过关键正文。

## 6. 离线模式设计

### 6.1 可用性目标

进入离线模式后，用户应能够：

- 打开 App Shell 和书架。
- 查看已下载书籍、封面、作者、分类和最近阅读位置。
- 打开 TXT 或 EPUB 正文，不依赖网络 API。
- 在已下载内容中搜索、目录跳转、修改阅读样式。
- 播放当前 profile 已下载的语音。
- 保存阅读进度和语音位置到本地，联网后同步。
- 查看离线包占用空间、下载进度、失效原因和删除入口。

### 6.2 离线入口与认证

当前主动离线会清除 token，退出离线需要重新登录。建议改为：

- 保留本地会话标识，但离线请求禁止发送敏感 token 到不可达接口。
- 进入离线时由 `OfflineSession` 接管数据访问，而不是让所有页面自行判断 `navigator.onLine`。
- `navigator.onLine` 仅作为提示信号，不作为可用性事实；实际以请求失败和本地包状态为准。
- 重新联网后执行同步队列，成功后再刷新远端数据。

### 6.3 Service Worker

当前 Service Worker 只覆盖静态资源和封面，且静态资源使用 stale-while-revalidate，可能在新版本激活前继续使用旧 App Shell。建议：

- 静态资源采用 Vite manifest 预缓存，版本 hash 驱动更新。
- 导航请求使用网络优先或带版本校验的 App Shell，避免长期旧代码。
- EPUB 资源和 TTS 音频不依赖 SW 作为唯一存储，统一进入 IndexedDB 离线包。
- SW 只负责 App Shell 和可选 HTTP 资源缓存，业务数据由 repository 管理。
- 增加“新版本可用，点击刷新”提示和 `controllerchange` 处理。

## 7. 阅读可用性与交互设计

### 7.1 阅读布局

- 阅读区域使用 `100dvh`、`env(safe-area-inset-top/bottom)`，避免 iOS 地址栏和刘海遮挡。
- 顶栏默认自动隐藏，单击正文显示/隐藏控制层；长按只触发选择/操作菜单。
- TXT 滚动、TXT 分页和 EPUB 分页统一使用同一套阅读偏好：字号、行距、字距、字体、主题、页边距。
- 分页模式显示页码/章节进度，滚动模式显示阅读百分比。
- 目录抽屉支持当前章节、高亮、层级折叠、搜索和回到当前位置。
- 小屏设备避免左右两侧同时放置低频按钮，核心操作保持 44px 以上触控区域。

### 7.2 文字选择与长按

- 长按阈值、移动容差、多指取消和 touchcancel 由一个手势状态机统一管理。
- 文本选择成功后菜单提供复制、朗读所选、搜索、分享；没有选区时不显示复制。
- EPUB iframe 和 TXT DOM 都输出统一 `SelectionContext`，不在父组件猜测窗口 selection。
- 浮动菜单位置进行 viewport 边界修正，不能被顶部/底部控制层遮挡。
- 选择状态和手势翻页互斥，但不应通过全局 `user-select: none` 解决冲突。

### 7.3 搜索

当前全文搜索逐章请求并将内容放入前端 Map，适合小书，不适合大书。建议：

- 后端生成规范化文本索引或本地离线包内建立轻量索引。
- 搜索结果携带 `chapterId + textOffset + contextHash`。
- 点击结果通过 manifest 定位，TXT 用 offset，EPUB 用 CFI 或 fragment。
- 大书使用分页加载、取消旧请求、限制并发和结果数量。

## 8. 界面视觉优化

### 8.1 现状问题

- Tailwind utility、内联 style、全局 CSS 三种方式混用，颜色和间距容易漂移。
- 全局 CSS 中存在历史兼容规则、重复媒体查询和多个阅读器布局模型。
- 部分样式使用 `var(--color-text-primary)`，但变量体系主要定义的是 `--color-text`，可能导致颜色回退异常。
- 使用 `:has()` 做按钮按压选择器，但项目声称兼容较旧 Safari，实际兼容目标与 CSS 使用不一致。
- 图标按钮部分依赖 title 或符号字符，屏幕阅读器语义和视觉一致性不足。
- 大量 emoji 作为状态图标，跨系统外观不一致，视觉层级不稳定。
- 毛玻璃、阴影和大圆角使用较多，阅读器本身应更克制，避免内容区域被装饰干扰。

### 8.2 设计系统收敛

建立 `design tokens`：

- color：background、surface、elevated、text、muted、border、primary、danger。
- spacing：4/8/12/16/20/24/32。
- radius：8/12/16/24。
- typography：body、caption、title、display、reader。
- elevation：none、small、medium、modal。
- motion：instant、fast、normal，支持 reduced motion。

组件统一：

- `Button`、`IconButton`、`SegmentedControl`、`Modal`、`BottomSheet`、`Toast`、`ProgressBar`、`BookCard`、`MiniPlayer`、`ReaderToolbar`。
- 所有图标按钮有 `aria-label`，不依赖 emoji 表达关键操作。
- 所有颜色通过 CSS variables 或主题组件注入，不在业务页大量写 HSL 和 rgba。
- 阅读器正文和管理页面使用不同密度，避免书架卡片样式渗入正文。

### 8.3 可访问性

- 交互控件触控区域至少 44×44px。
- 弹层打开后焦点移入，Escape 关闭，关闭后焦点恢复。
- 进度、下载、播放状态使用 `aria-live` 或可读状态文本。
- 颜色对比度满足 WCAG AA。
- 支持键盘翻页、播放控制和目录导航。
- `prefers-reduced-motion` 下关闭翻页动画、弹性缩放和非必要 pulse。

## 9. 数据库与 API 设计

### 9.1 必要索引与约束

- `book_chapters(book_id, order)` 唯一。
- `book_content_cache(user_id, book_id, chapter_id, content_hash)` 唯一。
- `tts_profiles(source, voice, synthesis_rate, engine_config_hash)` 唯一。
- `content_segments(chapter_id, segment_index)` 唯一。
- `tts_audio_resources(segment_id, profile_id)` 唯一。
- 所有全局资源引用使用非空外键和软删除策略。
- 任务操作接口必须校验 `user_id`，不能仅按 jobId 取消或删除。

### 9.2 API 统一返回

统一格式：

```json
{
  "success": true,
  "data": {},
  "meta": {
    "requestId": "...",
    "version": "..."
  },
  "error": null
}
```

错误需要包含稳定 code：`BOOK_NOT_FOUND`、`EPUB_INVALID`、`OFFLINE_PACKAGE_INCOMPLETE`、`TTS_SEGMENT_MISSING`、`CACHE_PROFILE_MISMATCH` 等，前端根据 code 展示可操作提示，而不是依赖中文字符串 contains。

### 9.3 API 安全与资源控制

- 上传限制文件类型、大小、解压后总大小和文件数量。
- 防止 ZIP Slip、ZIP Bomb、路径穿越和任意文件读取。
- API Key 不回传前端或日志；设置页面只显示脱敏结果。
- 所有书籍、章节、音频资源、任务接口执行用户归属校验。
- 音频文件使用 `Content-Type` 白名单、`Content-Disposition` 安全文件名和缓存控制。
- 增加请求 ID、TTS 任务 ID、bookId、chapterId、segmentId 的结构化日志。

## 10. 测试设计

### 10.1 单元测试

- EPUB：标准多文件、EPUB 2、EPUB 3、单文件锚点、嵌套目录、相对路径、URL 编码、缺少封面、坏 XML、二次包装。
- 内容规范化：脚本/样式、实体、ruby、表格、图片 alt、换行和特殊字符。
- TTS 分段：中英文混排、超长句、引号、括号、连续标点、空段、纯符号、段序稳定性。
- 缓存身份：正文变化、语音源变化、音色变化、合成语速变化、播放倍速变化、书籍版本变化。
- IndexedDB：升级迁移、Blob/ArrayBuffer、容量异常、事务回滚、半包不显示 ready。
- 手势：点击、长按、滑动、多指、touchcancel、文字选择互斥。

### 10.2 集成测试

- 上传 → 解析 → 目录 → 章节内容 → 阅读进度 → 重启恢复。
- EPUB 目录节点与 epub.js CFI/spine 跳转一致。
- 创建全书任务、部分任务、取消、失败重试、卡住恢复和断点续跑。
- 实时 TTS 命中全局缓存、用户缓存、缓存 miss 合成、并发去重。
- 跨用户不能读取书籍文件、章节、音频资源或任务。

### 10.3 端到端测试

至少覆盖：

- iPhone Safari/Android Chrome 的滚动阅读和分页阅读。
- EPUB 文字选择复制、长按菜单、左右滑动。
- 前台播放切后台、锁屏控制、来电/蓝牙音频焦点恢复。
- 下载离线包中途断网、刷新、重新进入、续传和删除。
- 真实大 EPUB：100MB 以上、图片和字体较多、章节 1000+。
- 低性能设备和 reduced motion。

## 10.5 实施进度跟踪（更新于 2026-07-28）

| Phase | 状态 | 说明 |
|-------|------|------|
| Phase 0：止血与安全 | ✅ 全部完成 | P0-1 ✅ 鉴权+路径校验；P0-2 ✅ 分段模型统一（R55）；P0-3 ✅ 范围限制+章节ID快照（R56）；P0-4 ✅ 事务封装+级联删除（R57）；P0-5 ✅ OfflineBookPackage 完整离线包（R63） |
| Phase 1：统一内容模型 | ✅ 全部完成 | ChapterManifest 统一模型 + normalizedText/contentHash 后端产出 + 缓存锚点修复（R59）；遗留书籍批量回填 270 本 17408 章节（R60） |
| Phase 2：重构 TTS 任务 | ✅ 全部完成 | P1-4~P1-8 逐段任务表、断点续跑、source 维度、并发去重、downloadSession 基础（R58） |
| Phase 3：离线包 | ⚠️ 主体完成 | OfflineBookPackage 完整结构+资源清单+续传会话+校验+失效检测（R63）；书架 stale 检测已集成（R64）；❌ downloadSession 未集成到批量下载流程；❌ 在线/离线统一 Repository 未做；❌ SW 更新机制未做 |
| Phase 4：阅读器拆分与视觉收敛 | ⚠️ 主体完成 | hooks 8个 + 组件 4个已提取，TTS 播放器重构完成，ReaderPage 3700→1987行；❌ design tokens/无障碍/统一组件库/MiniPlayer 未做 |
| Phase 5：质量与性能 | ⚠️ 部分完成 | 150 单元测试 + tsc + CI/CD 流水线；❌ 大书性能基准/结构化日志/错误码未做 |

### P0 缺陷明细

| ID | 状态 | 验证依据 |
|----|------|---------|
| P0-1 EPUB 资源鉴权 | ✅ 已修复 | `GET /:id/file/*` 已加 requireAuth + path.resolve + startsWith(sep) 防穿越 |
| P0-2 预合成分段模型 | ✅ 已修复 | 移除遗留分段路径，净减200行，统一由 content_segments 驱动（R55） |
| P0-3 部分预合成范围 | ✅ 已修复 | createPartialGenerationJob 持久化章节ID快照，消除范围漂移（R56） |
| P0-4 全局 TTS 空引用 | ✅ 已修复 | createFullBookGenerationJob 等封装为原子事务，deleteJobs 级联删除（R57） |
| P0-5 离线 EPUB 完整性 | ✅ 已修复 | OfflineBookPackage 含资源清单/封面/TOC/续传/校验/失效检测，版本 2.25.0（R63） |

### P2 体验项明细

| ID | 状态 | 说明 |
|----|------|------|
| P2-1 阅读页面职责过重 | ⚠️ 大幅改善 | 3700→1987行，8 hooks + 4 组件已提取，但仍含大量内联逻辑 |
| P2-2 WAV 拼接分支 | ✅ 已删除 | concat 模式已移除，保留逐段播放主路径 |
| P2-3 语速语义不清 | ✅ 已修复 | speed 已拆分为 synthesisRate（影响缓存身份）+ playbackRate（本地倍速），设置页标注“合成语速” |
| P2-4 跨章预取校验 | ⚠️ 部分 | SequentialPlayer 有基础校验，无完整 session key 匹配 |
| P2-5 进度同步冲突 | ✅ 已修复 | progressVersion/deviceId/updatedAt 多设备合并（高版本优先 + 服务端单调递增） |

### Phase 4 已完成子项

- ✅ ReaderEngine 接口 + ReadingPosition 类型 + useReadingPosition
- ✅ TxtEngine（DOM 测量分页 + 滚动模式 + 章节边界事件）
- ✅ TxtReaderView 组件
- ✅ EpubEngine（epub.js 封装为 ReaderEngine 接口）
- ✅ SequentialPlayer + DefaultTtsController
- ✅ 删除 concat 拼接模式 + TTS 启发式进度同步
- ✅ useReaderEngine / useReaderSettings / useReaderNavigation / useGestures
- ✅ ReaderTopBar 组件 + useReaderSettings 集成
- ✅ ReaderControlPanel 组件（底部 TTS 播放栏 + 设置面板 + 缓存管理）
- ✅ useTtsIntegration hook（TTS 启动/停止/seek/睡眠定时器）
- ✅ useBookLoader / useProgressRestore / useOfflineFallback hooks
- ✅ TocDrawer 独立组件 + 虚拟滚动（>200 章）
- ✅ 死代码清理（ttsVolume/savedProgressRef/savedTtsProgressRef）

### Phase 4 未完成子项

- ❌ Design tokens 体系（color/spacing/radius/typography/elevation/motion）
- ❌ 统一组件库（Button/IconButton/SegmentedControl/Modal/BottomSheet/Toast/ProgressBar/MiniPlayer）
- ❌ 无障碍修复（aria-label/焦点管理/触控区域/reduced-motion，当前仅 9 处 aria 引用）
- ❌ SelectionMenu 统一（EPUB iframe + TXT DOM 统一 SelectionContext）
- ❌ ReaderPage 进一步瘦身（目标 <800 行，当前 1987 行）

### 🔜 推荐下一步迭代

**Phase 0 剩余 P0 项（P0-2 + P0-3）**：预合成分段模型统一 + 部分预合成范围限制。

理由：设计文档明确优先级为「安全边界和数据正确性 → 内容模型统一 → TTS 逐段任务」。P0-1 已修复，P0-2/P0-3 是当前最高优先级的未完成数据正确性问题，直接影响 TTS 预合成的进度准确性和任务可靠性。

## 11. 实施计划

### Phase 0：止血与安全，1 到 2 天

- 修复 EPUB 内部资源鉴权和路径校验。
- 修复部分章节预合成范围错误。
- 修复全局 TTS 新资源引用空 ID。
- 增加 source、书籍版本和 contentHash 的最小校验。
- 删除重复 return、修正明显死代码和错误统计。
- 补跨用户资源访问测试。

### Phase 1：统一内容模型，3 到 5 天

- 抽取 EPUB `ChapterManifest` 和 `ContentNormalizer`。
- 修复锚点、OPF 相对路径和离线文本缓存。
- 章节接口同时提供 rawHtml、normalizedText、contentHash。
- 前后端统一 chapterId、spineIndex、fragment 映射。
- ReaderPage 中的 EPUB/TXT 文本清洗逻辑全部迁移。

### Phase 2：重构 TTS 任务，4 到 7 天

- 增加 SegmentManifest 和逐段任务表。
- 将分段结果持久化后再生成。
- 支持 scope、source、profileHash、断点续跑和幂等。
- 重构全局资源和用户引用事务。
- 将进度改为“已完成段/总段”，同时展示章节覆盖率。

### Phase 3：离线包，4 到 7 天

- 建立 OfflineBookPackage 和 downloadSession。
- TXT/EPUB 正文、目录、封面、EPUB 资源和 TTS 音频统一打包。
- 在线/离线统一 Repository 接口。
- 下载续传、容量管理、删除和失效检测。
- Service Worker 只保留 App Shell 和更新机制。

### Phase 4：阅读器拆分与视觉收敛，5 到 8 天

- 拆分 ReaderPage hooks 和渲染器。
- 统一 ReaderToolbar、TOC、MiniPlayer、BottomSheet、SelectionMenu。
- 收敛 tokens、按钮、弹层和安全区样式。
- 修复无障碍、焦点、触控区域和 reduced motion。

### Phase 5：质量与性能，持续迭代

- 增加大书性能基准和移动端真实设备测试。
- 引入结构化日志、错误码和任务监控。
- 检查 SQLite 索引、文件清理和缓存淘汰。
- 将部署、迁移、原生依赖 ABI 和构建产物纳入 CI 检查。

## 12. 验收标准

### 核心功能

- 任意受支持 EPUB 的目录项、正文、搜索、TTS 和离线章节一一对应。
- 同一书籍版本、同一 TTS profile、同一正文段只生成一份有效音频资源。
- 部分预合成只处理指定范围，任务中断后重新启动不会重复已完成段。
- 本地缓存命中时不发起实时 TTS 请求；离线缺段时显示明确缺失位置。
- 完整离线包在断网、刷新、重新打开后仍可阅读和朗读。
- 多用户无法通过任何书籍、章节、EPUB 资源、音频或任务接口互相访问。

### 体验指标

- 已有本地第一段缓存时，用户点击播放到出声不超过 300ms。
- 在线首次播放首段目标不超过 2 秒，超时提供可理解状态。
- 大 EPUB 首屏渲染不永久停留在“加载中”，15 秒内必须成功或给出可操作错误。
- 分页和滚动模式切换不丢失当前位置。
- 阅读页在移动端无整页横向/纵向溢出，控制层不遮挡正文和浮动菜单。
- 所有核心按钮可键盘操作、可读名称完整、触控目标不少于 44px。

### 工程质量

- 前后端类型检查、单元测试、集成测试、核心 E2E 全部通过。
- 数据库迁移可重复执行，旧缓存和旧任务有明确升级策略。
- 关键链路有 requestId、jobId、bookId、chapterId、segmentId 日志。
- ReaderPage 和 BookshelfPage 的业务逻辑可独立测试，不依赖整页渲染。

## 13. 结论

本项目下一阶段不应继续围绕单个按钮、单个缓存 miss 或单个 EPUB 文件打补丁。最优路径是先建立统一的 `ChapterManifest`、`SegmentManifest`、`TTSProfile` 和 `OfflineBookPackage`，再让阅读、搜索、预合成、播放和离线全部消费这些稳定模型。

优先顺序必须是：安全边界和数据正确性 → 内容模型统一 → TTS 逐段任务与缓存一致性 → 完整离线包 → 阅读器拆分与视觉升级。这样既能解决当前功能缺陷，也能避免下一轮继续出现“服务端修一个路径、前端补一个正则、缓存再加一个 key”的重复演进。