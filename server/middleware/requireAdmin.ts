import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './requireAuth.js';

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, () => {
    if (req.user?.role !== 'instructor') {
      return res.status(403).json({ error: 'Instructor access required.' });
    }
    if (!req.user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    next();
  });
}
