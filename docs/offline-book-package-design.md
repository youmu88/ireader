# P0-5 OfflineBookPackage 完整离线包设计

**版本**：v1.0
**日期**：2026-07-28
**状态**：实施中

## 1. 问题背景

当前离线 EPUB 阅读有一条"能走通"的路径：`downloadOfflineEpubPackage` 下载原始 EPUB zip 到 IndexedDB，`EpubViewer` 在离线时从 `getCachedEpubArchive` 加载 Blob URL 给 epub.js。但这条路径存在结构性缺陷：

1. **无结构化资源清单** — 无法验证哪些资源已下载、哪些缺失
2. **无封面独立缓存** — 书架离线时无法显示封面
3. **无 TOC 层级结构** — 离线目录只有扁平章节列表
4. **无阅读进度快照** — 离线包不包含最后阅读位置
5. **无失效检测** — 书籍重新上传后旧包不会标记 stale
6. **无字节统计** — 存储管理无法显示每本书占用空间
7. **无续传能力** — 大 EPUB 下载中断后必须从头来
8. **无 manifestVersion** — 包格式升级时无法迁移

## 2. 设计目标

- 定义完整 `OfflineBookPackage` 类型，覆盖设计文档 3.3 节所有字段
- 下载产出完整包（封面、TOC、资源清单、字节统计）
- 包完整性校验 + 失效检测
- downloadSession 续传
- 向后兼容旧包格式
- IndexedDB v5→v6 平滑迁移

## 3. 类型设计

```typescript
/** 离线包状态机 */
type OfflinePackageStatus = 'downloading' | 'ready' | 'failed' | 'stale';

/** 资源清单条目 */
interface OfflineResourceEntry {
  path: string;          // EPUB 内相对路径
  contentType: string;   // MIME 类型
  size: number;          // 字节数
  hash: string;          // SHA-256
  cached: boolean;       // 是否已下载到 IndexedDB
}

/** TOC 节点 */
interface OfflineTocNode {
  id: string;
  title: string;
  href: string;
  fragment: string | null;
  spineIndex: number;
  level: number;
  children: OfflineTocNode[];
}

/** 完整离线包元数据（替代旧 OfflineBookPackageMeta） */
interface OfflineBookPackage {
  // ── 身份 ──
  packageId: string;           // `${bookId}:${versionHash}` 唯一标识
  bookId: string;
  bookVersionHash: string | null;  // 书籍 fileHash
  manifestVersion: number;     // 包格式版本，当前 = 1

  // ── 元数据 ──
  metadata: {
    title: string;
    author: string;
    format: 'epub' | 'txt';
    coverPath: string | null;  // EPUB 内封面相对路径
  };

  // ── 章节结构 ──
  chapters: {
    total: number;
    cached: number;
  };

  // ── EPUB 资源 ──
  epubResources: {
    total: number;
    cached: number;
    totalBytes: number;
    cachedBytes: number;
    manifest: OfflineResourceEntry[];  // 完整资源清单
  };

  // ── TOC ──
  toc: OfflineTocNode[];

  // ── 阅读进度快照 ──
  progress: {
    cfi: string | null;
    chapterId: string | null;
    percentage: number;
    savedAt: number;
  } | null;

  // ── 状态 ──
  status: OfflinePackageStatus;
  totalBytes: number;        // 包总字节（archive + resources + chapters）
  updatedAt: number;
  error?: string;            // 失败时的错误信息
}

/** 下载会话（续传） */
interface DownloadSession {
  sessionId: string;
  bookId: string;
  status: 'active' | 'completed' | 'failed';
  totalItems: number;
  completedItems: number;
  completedKeys: string[];   // 已完成的资源 key 列表
  createdAt: number;
  updatedAt: number;
}
```

## 4. 实现方案

### 4.1 IndexedDB 升级（v5→v6）

- `cacheMeta` store 中 `offlinePackage` 字段从 `OfflineBookPackageMeta` 升级为 `OfflineBookPackage`
- 旧格式兼容：读取时检测 `manifestVersion` 字段，缺失则视为旧格式，仍可被 EpubViewer 加载（archive 路径不变）
- 新增 `offlineCovers` store（keyPath: bookId）存储封面 ArrayBuffer

### 4.2 下载流程增强

```
downloadOfflineEpubPackage(bookId, bookTitle, chapters, options?)
  1. 获取资源清单 GET /api/books/:id/resources
  2. 创建/恢复 DownloadSession
  3. 下载原始 EPUB archive → epubArchives
  4. 缓存章节文本 → bookChapters
  5. 逐个下载资源（跳过 session 中已完成的）→ epubResources
  6. 下载封面（从 manifest 中识别 cover 路径）→ offlineCovers
  7. 构建 TOC（从章节列表构建层级）
  8. 组装完整 OfflineBookPackage → cacheMeta.offlinePackage
  9. 标记 session completed
```

### 4.3 完整性校验

```typescript
validateOfflinePackage(bookId): Promise<{
  valid: boolean;
  missing: string[];      // 缺失资源路径
  corrupted: string[];    // hash 不匹配的资源
}>
```

### 4.4 失效检测

```typescript
checkPackageStaleness(bookId, currentFileHash): Promise<boolean>
// 比对 cacheMeta.offlinePackage.bookVersionHash !== currentFileHash → 标记 stale
```

### 4.5 向后兼容

- `getOfflinePackageMeta()` 保留，返回类型升级为 `OfflineBookPackage | OfflineBookPackageMeta | null`
- EpubViewer 的 `resolveSource` 逻辑不变：只要 `status === 'ready'` 且 archive 存在就加载
- 旧包（无 manifestVersion）视为 `manifestVersion: 0`，功能不受影响

## 5. 开发执行计划

### 迭代 1：类型定义 + 核心下载增强
- [x] 定义 OfflineBookPackage / OfflineResourceEntry / OfflineTocNode / DownloadSession 类型
- [x] IndexedDB v6 升级（新增 offlineCovers store）
- [x] 重写 downloadOfflineEpubPackage 产出完整包
- [x] 新增 getOfflinePackage() 返回完整结构
- [x] 新增 getCachedCover() 获取离线封面

### 迭代 2：校验 + 失效 + 续传
- [x] validateOfflinePackage() 完整性校验
- [x] checkPackageStaleness() 失效检测
- [x] DownloadSession 续传逻辑
- [x] 向后兼容旧包格式

### 迭代 3：集成 + 验证
- [x] tsc --noEmit 通过
- [x] 现有测试不回归
- [x] 版本号更新 + git commit + deploy
