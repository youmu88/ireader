# iReader 阅读模式重构设计文档 & 迭代计划

**版本**：v2.0  
**日期**：2026-07-28  
**范围**：阅读器前端架构（阅读模式、翻页、TTS 朗读、进度系统）  
**原则**：干净方案，不接受补丁；必要时重构

---

## 第一部分：现状诊断（深度代码审计结论）

### 1. 核心数据

| 文件 | 行数 | 职责 |
|------|------|------|
| ReaderPage.tsx | 3228 | 阅读页全部逻辑（God Component） |
| ttsPlayer.ts | 1762 | TTS 播放引擎 |
| EpubViewer.tsx | 442 | EPUB 渲染（epub.js 封装） |
| InputSurface.ts | 126 | 手势输入层 |
| InteractionController.ts | 83 | 手势状态机 |
| PageTurnCanvas.tsx | 0 | 空文件（死代码） |

ReaderPage.tsx 内含 **117 个 React Hooks**（useState/useRef/useCallback/useMemo），承担数据请求、分页计算、TTS 控制、搜索、缓存、进度保存、手势、弹层、设置面板等全部职责。

### 2. 已确认的结构性缺陷

#### 缺陷 A：TXT 翻页模式——估算分页，永远不准

**根因**：分页使用 CSS column-width 让浏览器排版，但 JS 侧用字符数比例（charOffsetRatio）估算页码和总页数。两套系统独立运行，永远对不齐。

**具体表现**：

- charsPerPage = (containerHeight / (fontSize * lineHeight)) * 2.2 — 硬编码系数 2.2，不考虑段落间距、标题、对话换行
- totalPages = Math.ceil(content.length / charsPerPage) — 纯字符数除法，与实际 CSS column 分页结果不一致
- 翻页用 translateX(-currentPage * 100%)，但 column 实际宽度受 column-gap 影响，累积误差随页数增大
- 进度恢复用 charOffsetRatio（0~1 比例），切回时只能"大致跳到附近"，无法精确到页

**为什么补丁修不好**：问题不在系数不准，而在于"浏览器排版"和"JS 估算"是两个独立系统。无论怎么调系数，混合内容（短对话、长段落、标题）下必然偏差。

#### 缺陷 B：TTS 朗读——双模式状态机 + 启发式进度同步

**根因**：ttsPlayer.ts 实现了两套播放模式（逐段顺序播放 + 拼接单音频播放），在 visibilitychange 时切换。进度同步依赖 4 种不同来源的启发式推算。

**具体表现**：

- 逐段模式：每段一个 Blob URL，audio 播完一段再加载下一段，段间有 50-200ms 间隙
- 拼接模式：后台把所有段拼成一个大 WAV，用 currentTime 定位——但拼接需要 Web Audio API decode，大章节（>500 段）内存峰值高
- 模式切换时机：visibilitychange → switchToConcatInBackground()，等 5 秒超时后强制拼接，切换瞬间可能丢 0.5 秒音频
- 进度同步 4 路来源：savedTtsProgressRef（API 保存）、charOffsetRatioRef（翻页估算）、epubChapterRatioRef（EPUB CFI）、scrollTop（滚动模式）——互相覆盖，正负 5 段容差
- jumpToSegment(n) 在非拼接模式下会 fetch 前 n 段全部音频（O(n) 网络请求）

#### 缺陷 C：EPUB 与 TXT 零抽象，两套完全独立的代码路径

**根因**：EPUB 用 epub.js iframe 渲染，TXT 用自定义 CSS column。两者在 ReaderPage 中通过 book?.format === 'epub' 分支，没有统一的阅读器接口。

**具体表现**：

- 进度：EPUB 用 CFI 字符串，TXT 用 charOffsetRatio / scrollTop / pageIndex（三套！）
- 章节跳转：EPUB 用 rendition.display(href)，TXT 用 loadChapterContent() + 重新分页
- TTS 文本提取：EPUB 要 stripHtml()，TXT 直接用
- 翻页：EPUB 用 rendition.next()/prev()，TXT 用 translateX 或 scrollTo
- 手势：EPUB 在 iframe document 上注入，TXT 在外层 DOM 上绑定

#### 缺陷 D：进度持久化散落四处，存在竞态

**根因**：进度保存有 4 条独立路径，没有统一的 ProgressStore。

| 路径 | 触发 | 存储 |
|------|------|------|
| debounceSaveProgress | 翻页/滚动 800ms 防抖 | PUT /api/books/:id/progress |
| startTtsProgressSaver | TTS 播放中每 5s | PUT /api/books/:id/progress + localStorage |
| scrollProgressSaveTimer | 滚动模式 1s 防抖 | PUT /api/books/:id/progress |
| persistPlaybackState | TTS 状态变更 | localStorage |

竞态场景：用户快速翻页 → debounce 800ms 内 TTS saver 先写 → 翻页 debounce 覆盖 → 进度回退。

#### 缺陷 E：手势系统架构干净但被架空

InputSurface + InteractionController + useReaderInteraction 是一套设计良好的手势架构（状态机 + 事件委托），但 ReaderPage 中还有：

- 独立的 keydown 监听（键盘翻页）
- EPUB iframe 内独立的 touch 注入
- 点击区域判断（左 1/3 上一页、右 1/3 下一页）散落在 JSX onClick 中
- performPageTurnRef 作为全局翻页出口，被 5 个不同调用方引用

#### 缺陷 F：PageTurnCanvas.tsx 空文件

0 字节，从未实现。应删除或纳入重构计划。

---

## 第二部分：重构设计方案

### 设计原则

1. **单一数据源**：阅读位置只有一个权威来源（ReadingPosition），所有消费方从它读取
2. **策略模式**：TXT/EPUB 差异封装在 ReaderEngine 策略中，上层不感知格式
3. **分页由浏览器负责，JS 只读取结果**：不再估算，用 DOM 测量
4. **TTS 是阅读器的一个"视图"**：不是独立系统，而是跟随 ReadingPosition 的音频投影
5. **渐进式重构**：每个迭代可独立交付，不需要一次性重写

### 架构总览

    ReaderPage (瘦壳, <300行)
    ├── useReaderEngine(book) → ReaderEngine
    │   ├── TxtEngine (CSS column + DOM 测量分页)
    │   └── EpubEngine (epub.js 封装)
    ├── useReadingPosition(engine) → ReadingPosition (唯一进度源)
    ├── useTtsController(position) → TtsController
    ├── useReaderGestures(engine, position) → 手势绑定
    ├── useProgressPersistence(position) → 统一进度保存
    └── UI 组件
        ├── ReaderToolbar
        ├── TocPanel
        ├── SearchPanel
        ├── TtsPanel
        └── SettingsPanel

### 模块设计

#### 模块 1：ReaderEngine 接口（策略模式）

    interface ReaderEngine {
      readonly format: 'txt' | 'epub';
      mount(container: HTMLElement): void;
      unmount(): void;
      loadChapter(chapter: Chapter, position?: ReadingPosition): Promise<void>;
      getPageCount(): number;
      getCurrentPage(): number;
      goToPage(page: number): void;
      nextPage(): boolean;
      prevPage(): boolean;
      scrollToRatio(ratio: number): void;
      getScrollRatio(): number;
      getVisibleText(): string;
      getFullChapterText(): Promise<string>;
      onPositionChange(cb: (pos: ReadingPosition) => void): () => void;
      onChapterBoundary(cb: (dir: 'next' | 'prev') => void): () => void;
    }

#### 模块 2：TxtEngine——DOM 测量分页（替代估算）

**核心改变**：不再用字符数估算页数，而是渲染后从 DOM 读取实际 column 数。

    class TxtEngine implements ReaderEngine {
      private measurePages(): number {
        const style = getComputedStyle(this.contentEl);
        const colWidth = parseFloat(style.columnWidth) || this.container.clientWidth;
        const colGap = parseFloat(style.columnGap) || 0;
        const totalWidth = this.contentEl.scrollWidth;
        this.pageCount = Math.max(1, Math.round((totalWidth + colGap) / (colWidth + colGap)));
        return this.pageCount;
      }
      goToPage(page: number): void {
        this.currentPage = Math.max(0, Math.min(page, this.pageCount - 1));
        const offset = this.currentPage * (colWidth + colGap);
        this.contentEl.style.transform = 'translateX(-' + offset + 'px)';
        this.emitPositionChange();
      }
    }

**进度表示**：ReadingPosition = { chapterId, page, pageCount, ratio }

- ratio = page / (pageCount - 1)，精确到实际页
- 恢复时：goToPage(Math.round(ratio * (measurePages() - 1)))

**字体/窗口变化**：监听 ResizeObserver + 字体加载完成事件，重新 measurePages() 并保持 ratio 不变。

#### 模块 3：ReadingPosition——唯一进度模型

    interface ReadingPosition {
      bookId: string;
      chapterId: string;
      chapterIndex: number;
      page?: number;
      pageCount?: number;
      scrollRatio?: number;
      cfi?: string;
      ratio: number;
      timestamp: number;
    }

**规则**：

- 所有组件只通过 useReadingPosition() 读写位置
- 写入自动触发持久化（统一 debounce，单一路径）
- TTS 起点 = position.ratio * totalSegments，不再有多路启发式

#### 模块 4：TtsController——简化为单模式

**核心改变**：删除拼接模式，只保留逐段顺序播放 + 预取缓冲。

理由：

- 拼接模式的唯一收益是后台播放无缝，但 Media Session API + audio 逐段播放已经能后台播放
- 拼接引入 Web Audio decode 内存峰值、模式切换状态机、currentTime 定位复杂度
- 段间间隙通过"预取下 3 段 + 段尾提前创建下段 ObjectURL"消除（<20ms）

    class TtsController {
      private player: SequentialPlayer;
      async startFromPosition(pos: ReadingPosition): Promise<void> {
        const text = await this.engine.getFullChapterText();
        const segments = splitText(text);
        const startIdx = Math.floor(pos.ratio * segments.length);
        await this.player.load(segments, startIdx);
        this.player.play();
      }
      private onSegmentChange(idx: number): void {
        // 通知 UI 高亮 + 自动翻页
      }
    }

#### 模块 5：useProgressPersistence——单一路径

    function useProgressPersistence(position: ReadingPosition, bookId: string) {
      // 单一 debounce（1s），单一出口：PUT /api/books/:id/progress
      // 同时写 localStorage 作为离线 fallback
      // 不再有 ttsProgressSaveTimer / scrollProgressSaveTimer / debounceSaveProgress 三路
    }

#### 模块 6：手势统一

- 键盘、触摸、鼠标统一走 InteractionController
- EPUB iframe 内事件通过 rendition.on('keydown') + getContents() 转发到同一个 Controller
- 删除 ReaderPage 中所有独立的 keydown/onClick 翻页逻辑
- 点击区域（左/中/右）配置化，由 Controller 的 tap 回调处理

---

## 第三部分：迭代计划（TODO List）

### Phase 1：基础设施（预计 3-4 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 1.1 | 定义 ReaderEngine 接口 + ReadingPosition 类型 | P0 | 低 | 类型文件通过 tsc |
| 1.2 | 实现 useReadingPosition hook（单一进度源） | P0 | 中 | 单元测试覆盖读写 |
| 1.3 | 实现 useProgressPersistence（统一保存） | P0 | 中 | 删除旧 3 路保存代码 |
| 1.4 | 删除 PageTurnCanvas.tsx 空文件 | P2 | 低 | 文件不存在 |
| 1.5 | 定义 TtsController 接口（不含实现） | P0 | 低 | 类型文件通过 tsc |

### Phase 2：TXT 翻页重构（预计 4-5 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 2.1 | 实现 TxtEngine（mount/loadChapter/measurePages） | P0 | 高 | 渲染后 DOM 测量页数正确 |
| 2.2 | TxtEngine 分页翻页（goToPage/next/prev） | P0 | 中 | 翻页无累积误差 |
| 2.3 | TxtEngine 滚动模式（scrollToRatio/getScrollRatio） | P0 | 中 | 滚动比例精确 |
| 2.4 | ResizeObserver + 字体加载后重新测量 | P1 | 中 | 窗口缩放后页码正确 |
| 2.5 | 章节边界事件（末尾自动提示加载下章） | P1 | 低 | 到最后一页触发回调 |
| 2.6 | 从 ReaderPage 中剥离 TXT 渲染逻辑到 TxtEngine | P0 | 高 | ReaderPage 减少 800+ 行 |

### Phase 3：EPUB 引擎封装（预计 3-4 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 3.1 | 将 EpubViewer.tsx 重构为 EpubEngine（实现 ReaderEngine） | P0 | 高 | 接口对齐 |
| 3.2 | EpubEngine 进度统一为 ReadingPosition（CFI → ratio 映射） | P0 | 中 | 进度恢复精确 |
| 3.3 | EpubEngine 章节跳转通过 engine 接口暴露 | P1 | 低 | 目录点击正常 |
| 3.4 | EPUB 上下章按钮逻辑移入 EpubEngine | P1 | 低 | 按钮行为不变 |

### Phase 4：TTS 重构（预计 4-5 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 4.1 | 实现 SequentialPlayer（删除拼接模式） | P0 | 高 | 段间间隙 <30ms |
| 4.2 | 实现 TtsController（startFromPosition/stop/pause） | P0 | 中 | 从阅读位置精确起播 |
| 4.3 | 高亮跟随 + 自动翻页联动 | P1 | 中 | 朗读时页面跟随 |
| 4.4 | 章节自动续播（通过 engine.onChapterBoundary） | P1 | 中 | 章末自动加载下章继续 |
| 4.5 | 删除 ttsPlayer.ts 中拼接模式代码（约400 行） | P0 | 中 | 代码量减少 |
| 4.6 | 删除 ReaderPage 中 TTS 启发式进度同步（约120 行） | P0 | 低 | 只用 position.ratio |

### Phase 5：ReaderPage 瘦身（预计 3-4 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 5.1 | 搜索功能抽取为 useBookSearch hook | P1 | 中 | ReaderPage 减少约200 行 |
| 5.2 | 缓存管理抽取为 useCacheManager hook | P1 | 中 | ReaderPage 减少约150 行 |
| 5.3 | 设置面板抽取为独立 SettingsPanel 组件 | P1 | 低 | ReaderPage 减少约200 行 |
| 5.4 | 目录面板抽取为 TocPanel 组件 | P1 | 低 | ReaderPage 减少约100 行 |
| 5.5 | 手势统一：删除 ReaderPage 中独立 keydown/onClick | P0 | 中 | 所有输入走 Controller |
| 5.6 | 最终验证：ReaderPage < 400 行 | P0 | — | wc -l 验证 |

### Phase 6：集成测试 + 清理（预计 2-3 天）

| # | 任务 | 优先级 | 复杂度 | 验收标准 |
|---|------|--------|--------|----------|
| 6.1 | TXT 翻页 E2E 测试（翻页精度、进度恢复） | P0 | 中 | Playwright 通过 |
| 6.2 | TTS 朗读 E2E 测试（起播位置、章节续播） | P1 | 中 | 自动化验证 |
| 6.3 | 删除所有死代码和注释掉的旧逻辑 | P1 | 低 | grep 无残留 |
| 6.4 | 更新 docs/ 下旧设计文档标记为 archived | P2 | 低 | 文档状态清晰 |

---

## 第四部分：风险与约束

### 技术风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| CSS column 测量在 Safari 上 scrollWidth 不准 | 分页错误 | 增加 fallback：用 getClientRects() 逐 column 测量 |
| epub.js iframe 内 ResizeObserver 不触发 | 窗口缩放后 EPUB 不重排 | 用 rendition.resize() 强制重排 |
| 删除拼接模式后，极弱网环境段间间隙变大 | 听感不连续 | 预取缓冲从 3 段增加到 5 段 |
| 重构期间功能回归 | 用户体验中断 | Phase 2-5 每步可独立部署，旧代码用 feature flag 切换 |

### 不做什么（明确排除）

- 不重写 epub.js 渲染层（它是成熟的第三方库）
- 不改变后端 TTS API 接口（只重构前端消费方式）
- 不改变 IndexedDB 缓存结构（offlineCacheService 保持不动）
- 不引入新的状态管理库（Redux/Zustand）——React hooks + 策略模式足够

---

## 第五部分：成功标准

重构完成后，系统应满足：

1. **ReaderPage.tsx < 400 行**（当前 3228 行）
2. **TXT 翻页精度**：任何内容下，页码显示与实际 CSS column 分页一致，误差 = 0
3. **进度恢复**：关闭浏览器重新打开，精确恢复到上次阅读页（不是"附近"）
4. **TTS 起播**：点击朗读按钮，从当前可见段落第一句开始，偏差小于等于 1 句
5. **TTS 段间间隙**：< 30ms（人耳不可感知）
6. **代码量**：前端阅读相关总代码量减少 30%+（当前约5600 行 → 目标 < 3900 行）
7. **零启发式**：不存在 * 2.2、正负 5 段容差、Math.round(ratio * 10000) 等魔法数字

---

## 附录：文件变更预览

### 新增文件

    frontend/src/reader/
    ├── types.ts              (ReaderEngine, ReadingPosition 接口)
    ├── TxtEngine.ts          (TXT 分页/滚动引擎)
    ├── EpubEngine.ts         (EPUB 引擎，封装 epub.js)
    ├── useReaderEngine.ts    (引擎选择 + 生命周期)
    ├── useReadingPosition.ts (进度状态管理)
    ├── useProgressPersistence.ts (统一保存)
    ├── TtsController.ts      (朗读控制器)
    ├── SequentialPlayer.ts   (简化播放器)
    └── useReaderGestures.ts  (统一手势绑定)

### 删除文件

    frontend/src/components/PageTurnCanvas.tsx  (空文件)

### 大幅缩减文件

    frontend/src/pages/ReaderPage.tsx     3228 → 约350 行
    frontend/src/services/ttsPlayer.ts    1762 → 约600 行（删除拼接模式）

### 保持不变

    frontend/src/services/ttsService.ts        (API 封装，不动)
    frontend/src/services/offlineCacheService.ts (缓存层，不动)
    frontend/src/interaction/*                  (手势基础库，不动)
    backend/src/**                              (后端全部不动)
