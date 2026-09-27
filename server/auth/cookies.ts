import type { Response } from 'express';

const COOKIE_NAME = 'ct_session';

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days, matches SESSION_TTL_DAYS default
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function getSessionTokenFromRequest(req: any): string | null {
  const fromCookie = req.cookies?.[COOKIE_NAME];
  if (typeof fromCookie === 'string' && fromCookie.length > 0) return fromCookie;
  return null;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
