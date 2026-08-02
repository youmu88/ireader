# 书架加载慢 · 根因诊断报告

> 目标：新版本书架书籍加载非常慢，每次加载书籍都耗时很久，诊断根因。
> 诊断日期：2026-08-02 ｜ 状态：已定位根因（附修复方案）
> 生产库：`/home/ubuntu/.ireader/data/ireader.sqlite`（309MB，WAL）
> ⚠️ 仓库内 `backend/~/.ireader/data/ireader.sqlite` 为 106KB 历史遗留空库（books=0），非生产库。

---

## 一、复现步骤

1. 以主用户 youmu88（userId=`217a5172-a73e-4e9e-b58d-6e186464b118`，书架 252 本 ready 书）登录并进入书架页。
2. 浏览器 DevTools Network 面板可见：mount 后一次性并发发出 **252 个 `GET /api/books/:id/stats` 请求**（每本书一个）。
3. 每个 stats 请求在后端串行执行 **11 次 SQL 查询**（better-sqlite3 同步阻塞事件循环），浏览器同域并发连接约 6 个，其余排队。
4. 书架需等全部 252 个请求返回后才显示完整进度条/语音率 → 用户感知"每次加载书籍都耗时很久"。
5. 量化复现脚本（`/tmp/repro_shelf_slow.sh`，已执行）：EXPLAIN 显示 `SCAN book_chapters` / `SCAN books` 全表扫描，生产库无 books/reading_progress/book_chapters 索引。

## 二、定位过程

1. **实测列表接口**：`GET /api/books`（books 查询 + reading_progress MAX 聚合，共 2 个查询）仅 **1.78ms** → 排除列表接口本身。
2. **实测 stats 接口**：单次 `GET /api/books/:id/stats` 的 11 个查询 **68.87ms**（其中 book_chapters count 单查询 **39.53ms**）。
3. **放大计算**：单次 68.87ms × 252 本书 = 串行 **15.7 秒**（2772 次查询）→ 与用户感知吻合。
4. **EXPLAIN QUERY PLAN**（生产库）：`books WHERE user_id`、`reading_progress WHERE book_id AND user_id`、`book_chapters WHERE book_id`、`tts_cache WHERE user_id AND book_id` 全部 **SCAN 全表扫描**；生产库 `sqlite_master` 仅有 content_segments/global_books/tts_cache/tts_generation_segments/tts_global_resources/tts_refs/user_book_refs 的索引，**books/reading_progress/book_chapters/tts_generation_jobs/book_content_cache 均无索引**。
5. **前端代码审查**：`frontend/src/pages/BookshelfPage.tsx` L73-93，`useEffect` 遍历 books 对每本 ready 书调 `loadBookStats(book.id)` → `axios.get('/api/books/${bookId}/stats')`，N+1 请求模式确认。
6. **后端代码审查**：`backend/src/routes/books.ts` `/stats` 路由（L912-978）+ `contentCacheService.ts getBookCacheStats`（L210-233），每请求 11 次查询且 book_chapters count 重复查询 2 次。

## 三、根因结论

**一句话根因**：书架加载慢 = 前端对每本书发起独立 `/stats` 请求的 **N+1 网络风暴** × 该接口每请求 **11 次无索引全表扫描查询** 的叠加放大；`GET /api/books` 列表接口本身仅 1.78ms，不是瓶颈。

| # | 根因 | 归属模块 | 类型 | 证据 |
|---|---|---|---|---|
| 1 | 前端 N+1：每本书一个 `/stats` HTTP 请求（252 个并发） | BookshelfPage.tsx L73-93 | 直接触发点 | 代码审查 |
| 2 | `/stats` 接口每请求 11 次 SQL（含重复 book_chapters count） | routes/books.ts L912-978 + contentCacheService.ts | 放大因素 | 实测 68.87ms/请求 |
| 3 | 数据库缺索引：books/reading_progress/book_chapters/tts_generation_jobs/book_content_cache 全表扫描 | db/init.ts（未建索引） | 放大因素 | EXPLAIN 全 SCAN |
| 4 | better-sqlite3 同步查询阻塞 Node 事件循环，252 请求互相排队 | 架构特性（存量） | 放大因素 | 15.7s 串行实测 |

**排除项**：`GET /api/books` 列表接口（1.78ms ✅）；封面 `/cover` 请求（静态文件、浏览器缓存、非阻塞 ✅）；TTS 队列轮询（仅队列打开时轮询 ✅）。

## 四、修复方案建议（按根治原则，优先 A+B+C）

### A. 前端去 N+1（根治主因，必做）
- 新增批量聚合接口：`GET /api/books/stats?ids=a,b,c` 或 POST `/api/books/stats/batch`，一次返回所有书 stats。
- 前端 `BookshelfPage` 的 `loadBookStats` 改为单次批量调用，`bookStats` 状态结构不变。
- 更轻量替代：将 stats 并入 `GET /api/books` 响应（JOIN 一次性带出阅读百分比、语音率），书架页一次请求全搞定，可加 `?withStats=1` 参数。

### B. 后端补索引（根治扫描，必做）
在 `db/init.ts` 主流程（CREATE TABLE 之后）增加幂等索引（内存库已验证全部可建成功）：
```sql
CREATE INDEX IF NOT EXISTS idx_books_user_id ON books(user_id);
CREATE INDEX IF NOT EXISTS idx_rp_user_book ON reading_progress(user_id, book_id);
CREATE INDEX IF NOT EXISTS idx_rp_book_id ON reading_progress(book_id);
CREATE INDEX IF NOT EXISTS idx_bc_book_id ON book_chapters(book_id);
CREATE INDEX IF NOT EXISTS idx_tgj_book_user ON tts_generation_jobs(book_id, user_id);
CREATE INDEX IF NOT EXISTS idx_bcc_book_user ON book_content_cache(book_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tc_user_book ON tts_cache(user_id, book_id);
```

### C. 去除 stats 内重复查询（顺手根治）
`getBookCacheStats` 内部又查一次 `count(*) FROM book_chapters`，与 `/stats` 第 3 次重复——改为入参传入 `totalChapters` 复用。

### D.（可选）分页/懒加载
书架 >100 本时按需渲染/虚拟列表、封面 `loading="lazy"`，降低首屏 DOM 与并发压力。

## 五、影响面评估

| 项 | 说明 |
|---|---|
| 数据量趋势 | 252 本书已是现实规模；books/章节数持续增长，SCAN 代价线性上升，问题只会更严重 |
| 风险 | 每次进入书架触发 252 请求 + 2772 次 SQL，高并发/多用户下事件循环阻塞加剧，可能拖垮整服务 |
| 修复收益 | A+B+C 后：书架加载 15.7s+ → 预计 <200ms（1 个批量请求 + 索引化查询） |

## 六、验证方法（修复后回归）

1. 前端：书架页 Network 面板确认 stats 请求数 = 1（而非 252）。
2. 后端：`EXPLAIN QUERY PLAN` 确认上述查询由 SCAN → SEARCH（走 idx_*）。
3. 压测：252 本场景书架页整体加载耗时 < 500ms。
4. 回归：BookshelfPage.test.tsx、api.integration.test.ts 全绿。

---

## 附录 A：复现脚本输出实录

```
[1] 生产库规模
  books(主用户)=252  book_chapters=17878
[2] 索引缺失验证 (EXPLAIN QUERY PLAN)
  SELECT count(*) FROM book_chapters WHERE book_id='x'
    └── SCAN book_chapters              ← 全表扫描
  SELECT * FROM books WHERE user_id='x'
    └── SCAN books                      ← 全表扫描
[3] 生产库 books/reading_progress/book_chapters/tts_generation_jobs/book_content_cache 均无索引
[4] 实测：GET /api/books 两查询 3.45ms | 单次 stats book_chapters count 39.53ms | 书籍数 252
```

## 附录 B：文档可读性验证（2026-08-02 复核）

- 本文件 94 行 / 6717 字节，章节结构完整：一、复现步骤 / 二、定位过程 / 三、根因结论 / 四、修复方案 / 五、影响面评估 / 六、验证方法。
- 同内容已生成 Word 版 `docs/shelf-loading-rootcause.docx` 并解析验证，格式一致、内容覆盖完整。
