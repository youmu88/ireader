/**
 * 用户偏好 KV 路由 — 配置的服务端唯一权威源
 *
 * 设计（语义键扩展结构，新增配置项直接加 key，不改表结构）：
 *   GET  /api/prefs       → 当前用户全部偏好（key → { value, updatedAt }）
 *   PUT  /api/prefs/:key  → upsert 单项（value 字符串 ≤16KB；key 白名单字符）
 *
 * 约定：
 *   - key 使用前端既有 localStorage 键名（如 ireader-theme / ireader_scroll_damping），
 *     服务端只做透明存取，语义由消费方定义
 *   - 所有 API 需登录（用户隔离）；前端未登录/离线时回退 localStorage，不影响离线使用
 */
import { Router, Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth.js';

/** key 白名单字符与长度（防注入/防滥用） */
const PREF_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 单项值上限 16KB（偏好类配置足够） */
const PREF_VALUE_MAX = 16 * 1024;

interface PrefRow {
  pref_key: string;
  pref_value: string;
  updated_at: string;
}

export function createPrefsRouter(db: ReturnType<typeof import('../db/init.js').initDatabase>) {
  const router = Router();

  // ── 读取当前用户全部偏好 ──
  router.get('/', requireAuth, (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const rows = db.all(
      sql`select pref_key, pref_value, updated_at from user_prefs where user_id = ${userId}`,
    ) as unknown as PrefRow[];
    const prefs: Record<string, { value: string; updatedAt: string }> = {};
    for (const r of rows) {
      prefs[r.pref_key] = { value: r.pref_value, updatedAt: r.updated_at };
    }
    res.json({ success: true, data: { prefs } });
  });

  // ── 写入/更新单项偏好 ──
  router.put('/:key', requireAuth, (req: Request, res: Response) => {
    const userId = req.user!.userId;
    const key = String(req.params.key ?? '');
    if (!PREF_KEY_RE.test(key)) {
      res.status(400).json({ success: false, error: 'invalid pref key' });
      return;
    }
    const raw = req.body?.value;
    const value = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
    if (value.length > PREF_VALUE_MAX) {
      res.status(413).json({ success: false, error: 'pref value too large' });
      return;
    }
    const now = new Date().toISOString();
    db.run(
      sql`insert into user_prefs (user_id, pref_key, pref_value, updated_at)
          values (${userId}, ${key}, ${value}, ${now})
          on conflict(user_id, pref_key) do update set pref_value = excluded.pref_value, updated_at = excluded.updated_at`,
    );
    res.json({ success: true, data: { key, updatedAt: now } });
  });

  return router;
}
