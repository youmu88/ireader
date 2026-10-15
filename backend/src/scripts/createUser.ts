/**
 * 创建用户 CLI（Phase 0 安全加固 / D7 配套：替代已移除的空库自动建默认管理员弱口令后门）
 *
 * 用法：
 *   pnpm create-user -- <用户名> <邮箱> <密码> [显示名]
 *
 * 行为：
 *   - 全新空库：创建首个账号（含默认分类与默认 TTS 设置）
 *   - 旧版(v0.1)库：创建账号并自动迁移旧数据（凭据由执行者显式提供，不再静态硬编码）
 *   - 已有账号的库：拒绝（追加账号走注册接口的邮箱白名单流程）
 */
import path from 'path';
import { sql } from 'drizzle-orm';
import { initDatabase } from '../db/init.js';
import { users } from '../db/schema.js';
import { hashPassword } from '../routes/auth.js';

const args = process.argv.slice(2);
const [username, email, password, displayName] = args;

if (!username || !email || !password) {
  console.error('用法: pnpm create-user -- <用户名> <邮箱> <密码> [显示名]');
  process.exit(1);
}
if (password.length < 6) {
  console.error('密码至少 6 个字符');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(process.env.HOME || process.cwd(), '.ireader', 'data');
const dbPath = path.join(dataDir, 'ireader.sqlite');

// 空库场景由 initDatabase 消费 initialUser 创建账号（并按需迁移旧数据），见 init.ts D7 逻辑
const db = initDatabase(dbPath, {
  initialUser: { username, email, passwordHash: hashPassword(password), displayName },
});

const user = db.select().from(users).where(sql`username = ${username}`).get() as any;
if (!user) {
  console.error('❌ 数据库已有账号，本命令仅用于创建首个账号。追加新账号请通过注册接口（邮箱白名单）进行。');
  process.exit(1);
}

console.log('✅ 首个账号创建成功');
console.log(`   用户名: ${user.username}`);
console.log(`   邮箱:   ${user.email || '(无)'}`);
console.log(`   数据库: ${dbPath}`);
