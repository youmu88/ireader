import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * 判断是否为 Multer 错误（上传文件相关）
 * MulterError 有 `code` 和 `field` 属性，提供比默认更具体的错误信息
 */
function isMulterError(err: Error): boolean {
  return err.name === 'MulterError' || err.message?.includes('Multipart');
}

/**
 * 将 Multer 错误码转为用户友好的中文提示
 */
function formatMulterError(err: Error): string {
  const msg = err.message || '';
  if (msg.includes('File too large')) return '文件大小超过限制（最大 500MB）';
  if (msg.includes('Unexpected field')) return '上传字段名不正确';
  if (msg.includes('Boundary not found')) return '请求格式错误（缺少 multipart boundary）';
  if (msg.includes('Invalid multipart')) return '请求格式无效';
  return `文件上传错误: ${msg}`;
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(`[Error] ${err.message}`, err.stack);

  // Multer 错误 — 返回 400 并附带具体说明
  if (isMulterError(err)) {
    res.status(400).json({
      success: false,
      error: formatMulterError(err),
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
    return;
  }

  res.status(500).json({
    success: false,
    error: '服务器内部错误，请稍后重试',
  });
}
