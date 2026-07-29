# Phase 1：语音预合成调度优化设计

**版本**：v1.0  
**日期**：2026-07-28  
**前置**：Phase 0 P0-1~P0-4 已全部完成（commit 884f977）

## 1. 目标

将 TTS 预合成链路从"功能可用"提升为"精确、可靠、可恢复、可观测"：

- P1-4：断点续跑真正基于逐段状态恢复，job 级进度从 segment 实际状态计算
- P1-5：任务持久化 source + engineConfigHash，消除执行时读取设置导致的身份漂移
- P1-6：服务端缓存写入增加唯一索引 + 占位竞争，消除并发重复合成
- P1-7：前端 IndexedDB 缓存按 profile 统计，区分"已缓存变体"和"当前可播放覆盖率"
- P1-8：前端离线下载引入 downloadSession 事务，支持续传和完整性校验

## 2. 验收标准

| ID | 验收项 | 判定标准 |
|----|--------|----------|
| AC-4 | recoverStuckJobs 恢复后 job.progress 反映已完成段数 | progress = completedSegments/total*100，非 0 |
| AC-5a | tts_generation_jobs 表含 source 列 | schema + init.ts 迁移 |
| AC-5b | 创建任务时持久化 source + engineConfigHash | createFullBook/createPartial 写入 |
| AC-5c | processJob 使用 job.source 而非实时读取 settings | 代码审查 |
| AC-6a | tts_cache 表有唯一索引 | UNIQUE(text_hash, voice, speed, source, user_id) |
| AC-6b | saveToCache 使用 INSERT OR IGNORE 占位 | 并发安全 |
| AC-7a | getBookCacheStatus 按当前 profile 统计音频覆盖率 | 传入 voice/speed/source 参数 |
| AC-7b | 缓存条目含 schemaVersion 字段 | 升级时可识别旧条目 |
| AC-8a | IndexedDB 含 downloadSessions store | DB_VERSION 升级 |
| AC-8b | 下载中断后重启可续传 | 只下载未完成项 |
| AC-8c | 只有全部完成才标记 ready | status 状态机 |

## 3. 实现方案

### 3.1 P1-4：修正断点续跑进度计算

**问题**：`recoverStuckJobs` 将 job 的 progress/completedChunks 重置为 0，但 segment 表中已完成的段仍为 completed。恢复后 processPersistedSegments 只处理 pending 段，但 job 级进度显示为 0%。

**修复**：在 `recoverStuckJobs` 中，重置 running segments 后，从 segment 表重新计算已完成数，更新 job 的 progress 和 completedChunks。

### 3.2 P1-5：任务持久化 source + engineConfigHash

**问题**：`processJob` 在执行时从 `ttsSettings` 读取 source/model/apiUrl，若用户在任务排队期间修改设置，任务会使用新配置，导致缓存身份与预期不符。

**修复**：
- `tts_generation_jobs` 表新增 `source TEXT` 和 `engine_config_hash TEXT` 列
- `createFullBookGenerationJob` / `createPartialGenerationJob` 创建时读取当前 settings 并写入
- `engineConfigHash = md5(source|model|apiUrl)`（不含 apiKey）
- `processJob` 优先使用 job.source，fallback 到 settings（兼容旧任务）
- 任务去重检查增加 source 条件

### 3.3 P1-6：缓存并发写入保护

**问题**：`saveToCache` 先查后写，并发时两个请求可能同时发现缓存不存在，重复合成并写入。

**修复**：
- `tts_cache` 表增加唯一索引：`UNIQUE(text_hash, voice, speed, source, user_id)`
- `saveToCache` 改为：先写文件（幂等，同 hash 同内容）→ INSERT OR IGNORE 占位 → 若已存在则 UPDATE
- SQLite WAL 模式下 INSERT OR IGNORE 天然串行化

### 3.4 P1-7：前端缓存按 profile 统计

**问题**：`cachedAudioSegments` 统计所有 voice/speed/source 变体的总数，不代表当前设置下的可播放覆盖率。

**修复**：
- `getBookCacheStatus` 增加可选参数 `profile?: { voice, speed, source }`
- 传入 profile 时，只统计匹配当前 profile 的音频段数
- 返回新增 `currentProfileCoverage` 字段
- 缓存条目增加 `schemaVersion: 4` 字段（与 DB_VERSION 对齐）
- 旧条目无 schemaVersion 视为 v3，升级时不删除但标记为 legacy

### 3.5 P1-8：离线下载事务（downloadSession）

**问题**：`downloadBatchCachedAudio` 一次性下载所有段，中断后无法知道哪些已完成、哪些待续传。

**修复**：
- IndexedDB 新增 `downloadSessions` store（DB_VERSION 4→5）
- 下载前创建 session：`{ sessionId, bookId, profileHash, totalItems, completedItems, status, itemKeys[], updatedAt }`
- 每完成一批写入后更新 completedItems
- 全部完成后 status → 'ready'，同时更新 OfflineBookPackageMeta
- 重启时检查 status='downloading' 的 session，跳过已完成项继续下载
- 失败时 status → 'failed'，保留已完成项供续传

## 4. 开发执行计划

### 迭代 1：后端 P1-4 + P1-5 + P1-6
- [x] 1.1 修复 recoverStuckJobs 进度计算
- [x] 1.2 schema.ts 增加 source + engine_config_hash 列
- [x] 1.3 init.ts 增加迁移 SQL
- [x] 1.4 createFullBook/createPartial 持久化 source + engineConfigHash
- [x] 1.5 processJob 使用 job.source
- [x] 1.6 tts_cache 唯一索引 + saveToCache 占位竞争
- [x] 1.7 tsc --noEmit 验证

### 迭代 2：前端 P1-7 + P1-8
- [x] 2.1 offlineCacheService DB_VERSION 4→5，新增 downloadSessions store
- [x] 2.2 getBookCacheStatus 增加 profile 过滤
- [x] 2.3 实现 downloadSession 创建/更新/续传/完成
- [x] 2.4 downloadBatchCachedAudio 集成 session
- [x] 2.5 tsc --noEmit 验证

### 迭代 3：集成验证 + 归档
- [x] 3.1 全量 tsc 检查
- [x] 3.2 版本号更新
- [x] 3.3 git commit + push
- [x] 3.4 deploy.sh
