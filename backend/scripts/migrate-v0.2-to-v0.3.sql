-- iReader 数据库迁移 v0.2 → v0.3
-- 添加 pinned 字段到 books 表（书籍置顶功能）
-- 适用于已有数据的旧数据库升级

-- 1. books 表：添加 pinned 字段（默认 0 = 未置顶）
ALTER TABLE books ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

-- 2. 更新版本元数据（如果有版本表则更新）
-- 本迁移兼容 drizzle-orm 自动 schema 同步
