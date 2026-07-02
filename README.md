# iReader 📚

图书阅读与听书 Web 服务端软件。私有化部署，支持 EPUB/TXT 格式，一键启动。

## 快速开始

```bash
# 安装依赖
cd backend && npm install --include=dev
cd ../frontend && npm install --include=dev

# 开发模式
npm run dev          # 同时启动前端(5173)和后端(10000)

# 构建
npm run build        # 构建前后端

# 测试
npm test             # 运行所有测试
```

## 项目结构

```
ireader/
├── backend/             # Express + TypeScript + SQLite
│   ├── src/
│   │   ├── db/          # 数据库初始化与 Schema
│   │   ├── routes/      # API 路由
│   │   ├── middleware/   # 中间件
│   │   └── index.ts     # 入口
│   └── ...
├── frontend/            # Vite + React + TypeScript + TailwindCSS
│   ├── src/
│   │   ├── pages/       # 页面组件
│   │   ├── components/  # 通用组件
│   │   └── ...
│   └── ...
├── package.json         # 根脚本
└── README.md
```

## API 文档

### 健康检查
- `GET /api/health` → `{ success: true, status: "ok", version: "0.1.0" }`

### 图书管理 (Phase 1)
- `GET /api/books` — 图书列表
- `GET /api/books/:id` — 图书详情
- `DELETE /api/books/:id` — 删除图书
- `POST /api/books/upload` — 上传图书 (Phase 1)

### 分类管理 (Phase 1)
- `GET /api/categories` — 分类列表
- `POST /api/categories` — 新增分类
- `PUT /api/categories/:id` — 修改分类
- `DELETE /api/categories/:id` — 删除分类

### 阅读进度 (Phase 1)
- `GET /api/books/:id/progress` — 获取阅读进度
- `PUT /api/books/:id/progress` — 保存阅读进度

### TTS (Phase 2+)
- 路由已预留，当前返回 501 Not Implemented

## 部署

一键部署到生产目录，默认 `~/.ireader/`，默认端口 `10000`。

### 前置条件

- Node.js >= 18
- npm

### 命令参考

```bash
# 默认部署（增量构建）
./deploy.sh

# 自定义部署目录和端口
./deploy.sh --dir /opt/ireader --port 18080

# 全量构建后部署（清理依赖后重装，适合 CI/CD 或环境变更）
./deploy.sh --full-build

# 停止服务并清理部署产物（保留数据库和图书数据）
./deploy.sh --clean

# ⚠️  清理全部数据（包含数据库和图书文件，需手动确认）
./deploy.sh --reset-data

# 显示帮助
./deploy.sh --help
```

### 部署目录结构

部署完成后，目标目录结构如下：

```
~/.ireader/
├── app/                  # 应用代码
│   ├── package.json      # 根配置
│   ├── .env              # 运行时配置（自动生成）
│   ├── start.sh          # 启动脚本（自动生成）
│   ├── backend/
│   │   ├── dist/         # 编译后后端代码
│   │   ├── package.json
│   │   └── node_modules/ # 生产依赖
│   └── frontend/
│       └── dist/         # 前端静态资源
├── data/                 # 运行时数据
│   ├── ireader.sqlite    # SQLite 数据库
│   ├── books/            # 上传的图书文件
│   ├── covers/           # 封面缓存
│   └── tts-cache/        # TTS 音频缓存
├── logs/
│   ├── app.log           # 应用运行日志
│   └── deploy.log        # 部署日志
└── run/
    └── ireader.pid       # 进程 PID 文件
```

### 部署流程

1. 检查 Node.js/npm 环境
2. 创建目标目录结构
3. 停止旧实例（如有）
4. 构建项目（增量或全量）
5. 复制构建产物到目标目录
6. 安装生产依赖
7. 启动服务
8. 健康检查确认服务就绪
9. 输出访问地址
### 部署流程

1. 检查 Node.js/npm 环境
2. 创建目标目录结构
3. 停止旧实例（如有）
4. 构建项目（增量或全量）
5. 复制构建产物到目标目录
6. 安装生产依赖
7. 启动服务
8. 健康检查确认服务就绪
9. 输出访问地址

## 自动部署 & Git 归档（一键流水线）

开发完成后，一条命令完成 **类型检查 → 构建 → 测试 → 部署 → Git 提交并推送** 全流程。

```bash
# 完整流程（推荐）
npm run archive:deploy

# 自定义 commit message
npm run archive:deploy -- "feat: 添加TTS错误提示横幅"
# 或直接传参
bash scripts/auto-archive-deploy.sh "fix: 修复EPUB图片丢失"

# 跳过测试（快速部署归档）
npm run archive:quick

# 跳过部署（仅构建 + 归档）
npm run archive:build

# 预览模式（看看要执行什么，不实际执行）
npm run archive:deploy:dry-run

# 完整参数
bash scripts/auto-archive-deploy.sh --skip-tests --skip-deploy "my message"
```

### 流水线详解

| 步骤 | 命令 | 失败即终止 |
|------|------|-----------|
| 1️⃣ 类型检查 | `npm run typecheck` | ✅ |
| 2️⃣ 构建 | `npm run build` | ✅ |
| 3️⃣ 测试 | `npm test` | ✅ (可用 `--skip-tests` 跳过) |
| 4️⃣ 部署 | `./deploy.sh` | ✅ (可用 `--skip-deploy` 跳过) |
| 5️⃣ Git 归档 | `git add -A && git commit && git push` | ⚠️ push 失败不影响本地 |

> 💡 **最佳实践**：每天结束开发时跑一次 `npm run archive:deploy`，代码自动上线 + 归档，不留手尾。

## 技术栈

| 层 | 技术选型 |
|---|---|
| 前端框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式 | TailwindCSS |
| 后端框架 | Express + TypeScript |
| 数据库 | SQLite (better-sqlite3) |
| ORM | Drizzle ORM |
| 测试 | Vitest + Testing Library |

## 开发路线图

- Phase 0 ✅ 工程骨架与基础契约
- Phase 1 🏗️ 图书管理 + 书架 + 阅读器 MVP
- Phase 2 ⏳ TTS 核心迁移
- Phase 3 ⏳ 阅读器听书闭环
- Phase 4 ⏳ 预生成、队列与缓存
- Phase 5 ⏳ 部署与一期验收

## 许可

MIT
# ireader
