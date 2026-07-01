/**
 * JWT 鉴权中间件
 * 验证请求中的 Bearer Token，将用户信息附加到 request 上
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// JWT 密钥（生产环境请通过环境变量配置）
const JWT_SECRET = process.env.JWT_SECRET || 'ireader-jwt-secret-dev-only';
const JWT_EXPIRES_IN = '7d';

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
