import { randomBytes } from 'node:crypto';
import { db } from '../db.js';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'student' | 'instructor';
  isAdmin: boolean;
}

const DEFAULT_TTL_DAYS = 30;

function ttlDays(): number {
  const raw = Number(process.env.SESSION_TTL_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_DAYS;
}

export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await db.authSessions.create({ token, userId, ttlDays: ttlDays() });
  return token;
}

export async function resolveSession(token: string): Promise<SessionUser | null> {
  const session = await db.authSessions.findValid(token);
  if (!session) return null;
  const user = await db.users.findById(session.userId);
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    isAdmin: user.isAdmin === true,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db.authSessions.delete(token);
}

export async function pruneExpiredSessions(): Promise<void> {
  try {
    const removed = await db.authSessions.deleteExpired();
    if (removed > 0) {
      console.log(`[auth] pruned ${removed} expired session(s)`);
    }
  } catch (err: any) {
    console.error('[auth] prune failed:', err?.message ?? err);
  }
}
