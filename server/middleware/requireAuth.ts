import type { Request, Response, NextFunction } from 'express';
import { resolveSession, type SessionUser } from '../auth/sessions.js';
import { getSessionTokenFromRequest } from '../auth/cookies.js';

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

function bypassEnabled(): boolean {
  return process.env.DEV_BYPASS_AUTH === 'true';
}

const BYPASS_USER: SessionUser = {
  id: 'dev-bypass-user',
  email: 'dev@localhost',
  displayName: 'Dev Bypass',
  role: 'instructor',
};

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (bypassEnabled()) {
    req.user = BYPASS_USER;
    return next();
  }

  const token = getSessionTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const user = await resolveSession(token);
  if (!user) {
    return res.status(401).json({ error: 'Session expired or invalid.' });
  }

  req.user = user;
  next();
}

export async function requireInstructor(
  req: Request,
  res: Response,
  next: NextFunction
) {
  await requireAuth(req, res, () => {
    if (req.user?.role !== 'instructor') {
      return res.status(403).json({ error: 'Instructor access required.' });
    }
    next();
  });
}

/**
 * Resolve which studentId the caller is allowed to act on.
 * - Students: always their own ID. Any client-supplied studentId is ignored.
 * - Instructors: may impersonate via ?asStudentId=xyz or body.studentId,
 *   otherwise they act as themselves (useful for testing as an instructor).
 */
export function resolveActingStudentId(
  req: Request,
  requested?: string
): string {
  if (req.user?.role === 'instructor') {
    const impersonate =
      (req.query?.asStudentId as string) ||
      (typeof requested === 'string' && requested.length > 0 ? requested : '') ||
      req.user.id;
    return impersonate;
  }
  return req.user!.id;
}
