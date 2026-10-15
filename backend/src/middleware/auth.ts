/**
 * JWT 鉴权中间件
 * 验证请求中的 Bearer Token，将用户信息附加到 request 上
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

/**
 * JWT 密钥（安全加固 D6：无默认兜底，启动前必须通过 assertJwtSecret 校验）
 * 部署环境由 deploy.sh 自动生成并持久化到 .env；本地开发见 .env.example
 */
const JWT_SECRET = process.env.JWT_SECRET as string; // 运行时由 assertJwtSecret() 在服务启动前保证非空（index.ts）
const JWT_EXPIRES_IN = '7d';

/**
 * 启动前置校验（D6）：JWT_SECRET 缺失或过短时拒绝启动。
 * 必须在服务监听端口前调用（见 index.ts），防可离线伪造任意用户 token。
 */
export function assertJwtSecret(): void {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('━'.repeat(60));
    console.error('[启动失败] 安全校验未通过：JWT_SECRET 未配置或长度不足 32 字符');
    console.error('  生成命令:  openssl rand -hex 32');
    console.error('  配置方式:  写入 backend/.env 或部署目录 .env：');
    console.error('             JWT_SECRET=<生成的密钥>');
    console.error('  说明: https://github.com/youmu88/ireader → docs/comprehensive-audit-and-upgrade-plan.md §7.1 D6');
    console.error('━'.repeat(60));
    process.exit(1);
  }
}

export interface AuthPayload {
  userId: string;
  username: string;
}

// 扩展 Express Request 类型
declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

/**
 * 生成 JWT Token
 */
export function generateToken(payload: AuthPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * 验证 JWT Token
 */
export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

/**
 * 必选鉴权中间件 — 未登录返回 401
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: '未登录，请先登录' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ success: false, error: '登录已过期，请重新登录' });
    } else {
      res.status(401).json({ success: false, error: '无效的登录凭证' });
    }
  }
}

/**
 * 可选鉴权中间件 — 有 token 则解析用户，无 token 也不拒绝
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      req.user = verifyToken(token);
    } catch {
      // token 无效则忽略
    }
  }
  next();
}
