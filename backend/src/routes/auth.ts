/**
 * 认证路由 — 注册 / 登录 / 当前用户信息
 */
import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { users, categories } from '../db/schema.js';
import { generateToken, requireAuth } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';

export function createAuthRouter(db: any): Router {
  const router = Router();

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
   * 验证用户名合法性（字母数字下划线，3-30位）
   */
  function validateUsername(username: string): string | null {
    if (!username || username.trim().length < 3) return '用户名至少3个字符';
    if (username.trim().length > 30) return '用户名不能超过30个字符';
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(username.trim())) return '用户名只能包含字母、数字、下划线、中划线和中文';
    return null;
  }

  function validatePassword(password: string): string | null {
    if (!password || password.length < 6) return '密码至少6个字符';
    if (password.length > 128) return '密码不能超过128个字符';
    return null;
  }

  // ── POST /api/auth/register — 注册 ──
  router.post('/register', (req: Request, res: Response) => {
    try {
      const { username, password, displayName } = req.body;

      // 验证输入
      const usernameErr = validateUsername(username);
      if (usernameErr) {
        res.status(400).json({ success: false, error: usernameErr });
        return;
      }

      const passwordErr = validatePassword(password);
      if (passwordErr) {
        res.status(400).json({ success: false, error: passwordErr });
        return;
      }

      // 检查用户名是否已存在
      const existing = db.select().from(users).where(sql`username = ${username.trim()}`).get();
      if (existing) {
        res.status(409).json({ success: false, error: '用户名已被占用' });
        return;
      }

      // 创建用户
      const now = new Date().toISOString();
      const userId = uuidv4();
      const passwordHash = hashPassword(password);

      db.insert(users).values({
        id: userId,
        username: username.trim(),
        passwordHash,
        displayName: displayName || username.trim(),
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
      const token = generateToken({ userId, username: username.trim() });

      res.status(201).json({
        success: true,
        data: {
          userId,
          username: username.trim(),
          displayName: displayName || username.trim(),
          token,
        },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: '注册失败：' + (err.message || '未知错误') });
    }
  });

  // ── POST /api/auth/login — 登录 ──
  router.post('/login', (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        res.status(400).json({ success: false, error: '请输入用户名和密码' });
        return;
      }

      const user = db.select().from(users).where(sql`username = ${username.trim()}`).get() as any;
      if (!user) {
        res.status(401).json({ success: false, error: '用户名或密码错误' });
        return;
      }

      if (!verifyPassword(password, user.passwordHash)) {
        res.status(401).json({ success: false, error: '用户名或密码错误' });
        return;
      }

      const token = generateToken({ userId: user.id, username: user.username });

      res.json({
        success: true,
        data: {
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          token,
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
