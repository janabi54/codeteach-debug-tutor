import type { Request, Response, NextFunction } from 'express';
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY)
    return res.status(403).json({ error: 'Forbidden' });
  next();
}
