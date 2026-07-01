-- iReader 数据库迁移 v0.1 → v0.2
-- 添加 user_id 列到旧表（Phase 16 账号隔离）
-- 适用于已有数据的旧数据库升级

-- 1. categories 表：添加 user_id
ALTER TABLE categories ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE categories SET user_id = 'default-user' WHERE user_id IS NULL;

-- 2. books 表：添加 user_id
ALTER TABLE books ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE books SET user_id = 'default-user' WHERE user_id IS NULL;

-- 3. reading_progress 表：添加 user_id
ALTER TABLE reading_progress ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE reading_progress SET user_id = 'default-user' WHERE user_id IS NULL;

-- 4. settings 表：添加 user_id
ALTER TABLE settings ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE settings SET user_id = 'default-user' WHERE user_id IS NULL;

-- 5. tts_cache 表：添加 user_id
ALTER TABLE tts_cache ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
UPDATE tts_cache SET user_id = 'default-user' WHERE user_id IS NULL;

-- 6. tts_settings 表：主键和结构完全不同，重建
CREATE TABLE IF NOT EXISTS tts_settings_new (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'kokoro',
  voice_id TEXT NOT NULL DEFAULT 'zf_xiaobei',
  speed REAL NOT NULL DEFAULT 1.0,
  pre_generate_concurrency INTEGER NOT NULL DEFAULT 3,
  first_chunk_max_size INTEGER NOT NULL DEFAULT 32,
  normal_chunk_max_size INTEGER NOT NULL DEFAULT 128,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO tts_settings_new (user_id, enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
SELECT 'default-user', enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at FROM tts_settings;
DROP TABLE IF EXISTS tts_settings;
ALTER TABLE tts_settings_new RENAME TO tts_settings;

-- 7. 确保 tts_settings 中有默认用户的记录
INSERT OR IGNORE INTO tts_settings (user_id, enabled, source, voice_id, speed, pre_generate_concurrency, first_chunk_max_size, normal_chunk_max_size, updated_at)
VALUES ('default-user', 1, 'kokoro', 'zf_xiaobei', 1.0, 3, 32, 128, datetime('now'));
