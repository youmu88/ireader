/**
 * 认证路由 — 注册 / 登录 / 当前用户信息
 *
 * 安全白名单：注册时 email 必须在 secUserEmail.json 白名单中才允许注册。
 * 登录支持双模式：
 *   - 输入含 @ → 按 email 查询登录（新用户）
 *   - 输入不含 @ → 按 username 查询登录（老用户兼容）
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sql } from 'drizzle-orm';
import { users, categories } from '../db/schema.js';
import { generateToken, requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 从 secUserEmail.json 加载白名单邮箱列表
 */
function loadWhitelist(): Set<string> {
  try {
    const configPath = path.resolve(__dirname, '..', 'secUserEmail.json');
    // 也尝试在 backend 根目录找
    const altPath = path.resolve(__dirname, '..', '..', 'secUserEmail.json');
    let resolvedPath: string;
    if (fs.existsSync(configPath)) {
      resolvedPath = configPath;
    } else if (fs.existsSync(altPath)) {
      resolvedPath = altPath;
    } else {
      console.warn('[安全白名单] secUserEmail.json 未找到，使用空白名单（禁止所有注册）');
      return new Set<string>();
    }
    const raw = fs.readFileSync(resolvedPath, 'utf-8');
    const list: string[] = JSON.parse(raw);
    if (!Array.isArray(list)) {
      console.warn('[安全白名单] secUserEmail.json 格式错误，应为一个字符串数组');
      return new Set<string>();
    }
    const whitelist = new Set(list.map((e: string) => e.trim().toLowerCase()));
    console.log(`[安全白名单] 已加载 ${whitelist.size} 个允许注册的邮箱`);
    return whitelist;
  } catch (err) {
    console.error('[安全白名单] 加载失败:', (err as Error).message);
    return new Set<string>();
  }
}

export function createAuthRouter(db: any): Router {
  const router = Router();

  // 启动时加载白名单
  const emailWhitelist = loadWhitelist();

  /**
   * 密码哈希（PBKDF2 + SHA-512 + 随机盐）
   * 格式：salt:hash
   */
  function hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return `${salt}:${hash}`;
  }

  function verifyPassword(password: string, storedHash: string): boolean {
    const [salt, hash] = storedHash.split(':');
    const computed = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return computed === hash;
  }

  /**
   * 验证邮箱基本格式
   */
  function isValidEmail(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validatePassword(password: string): string | null {
    if (!password || password.length < 6) return '密码至少6个字符';
    if (password.length > 128) return '密码不能超过128个字符';
    return null;
  }

  // ── POST /api/auth/register — 注册（需在白名单邮箱内） ──
  router.post('/register', (req: Request, res: Response) => {
    try {
      const { email, password, displayName } = req.body;

      // ── 校验 email ──
      if (!email || !email.trim()) {
        res.status(400).json({ success: false, error: '请输入邮箱' });
        return;
      }
      const trimmedEmail = email.trim().toLowerCase();
      if (!isValidEmail(trimmedEmail)) {
        res.status(400).json({ success: false, error: '邮箱格式不正确' });
        return;
      }

      // ── 白名单校验 ──
      if (!emailWhitelist.has(trimmedEmail)) {
        res.status(403).json({ success: false, error: '该邮箱不在注册白名单中，请联系管理员' });
        return;
      }

      // ── 检查邮箱是否已被注册 ──
      const existingByEmail = db.select().from(users).where(sql`email = ${trimmedEmail}`).get();
      if (existingByEmail) {
        res.status(409).json({ success: false, error: '该邮箱已被注册' });
        return;
      }

      const passwordErr = validatePassword(password);
      if (passwordErr) {
        res.status(400).json({ success: false, error: passwordErr });
        return;
      }

      // 以邮箱 @ 前的部分作为 username，如果冲突则加 uuid 前缀
      let username = trimmedEmail.split('@')[0];
      let existing = db.select().from(users).where(sql`username = ${username}`).get();
      let suffix = 0;
      const original = username;
      while (existing) {
        suffix++;
        username = `${original}${suffix}`;
        existing = db.select().from(users).where(sql`username = ${username}`).get();
      }

      // 创建用户
      const now = new Date().toISOString();
      const userId = uuidv4();
      const passwordHash = hashPassword(password);

      db.insert(users).values({
        id: userId,
        username,
        email: trimmedEmail,
        passwordHash,
        displayName: displayName || trimmedEmail.split('@')[0],
        createdAt: now,
        updatedAt: now,
      }).run();

      // 为用户创建默认分类
      db.insert(categories).values({
        id: uuidv4(),
        userId,
        name: '未分类',
        sort: 0,
      }).run();

      // 生成 token
      const token = generateToken({ userId, username });

      res.status(201).json({
        success: true,
        data: {
          token,
          user: {
            userId,
            username,
            email: trimmedEmail,
            displayName: displayName || trimmedEmail.split('@')[0],
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: '注册失败：' + (err.message || '未知错误') });
    }
  });

  // ── POST /api/auth/login — 登录（支持 email 或 username） ──
  router.post('/login', (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        res.status(400).json({ success: false, error: '请输入邮箱/用户名和密码' });
        return;
      }

      const input = email.trim();
      let user: any;

      // 判断输入是否含 @ → 按 email 查；否则按 username 查（兼容老用户）
      if (input.includes('@')) {
        user = db.select().from(users).where(sql`email = ${input.toLowerCase()}`).get() as any;
      } else {
        user = db.select().from(users).where(sql`username = ${input}`).get() as any;
      }

      if (!user) {
        res.status(401).json({ success: false, error: '邮箱/用户名或密码错误' });
        return;
      }

      if (!verifyPassword(password, user.passwordHash)) {
        res.status(401).json({ success: false, error: '邮箱/用户名或密码错误' });
        return;
      }

      const token = generateToken({ userId: user.id, username: user.username });

      res.json({
        success: true,
        data: {
          token,
          user: {
            userId: user.id,
            username: user.username,
            email: user.email || null,
            displayName: user.displayName,
          },
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: '登录失败：' + (err.message || '未知错误') });
    }
  });

  // ── GET /api/auth/me — 当前用户信息（需登录） ──
  router.get('/me', requireAuth, (req: Request, res: Response) => {
    try {
      const user = db.select().from(users).where(sql`id = ${req.user!.userId}`).get() as any;
      if (!user) {
        res.status(404).json({ success: false, error: '用户不存在' });
        return;
      }

      res.json({
        success: true,
        data: {
          userId: user.id,
          username: user.username,
          email: user.email || null,
          displayName: user.displayName,
          createdAt: user.createdAt,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: '获取用户信息失败' });
    }
  });

  return router;
}
