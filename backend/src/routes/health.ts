import { Router, Request, Response } from 'express';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

export default router;
