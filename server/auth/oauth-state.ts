/**
 * One-time CSRF state tokens for OAuth flows.
 *
 * In-memory Map with TTL cleanup. For a single-process dev app this is
 * sufficient. In multi-instance production, replace with Redis or a
 * DB-backed store — the public API here is stable.
 *
 * Usage:
 *   const state = issueState();
 *   // ... redirect to GitHub with state ...
 *   // ... callback receives state ...
 *   if (!consumeState(state)) return res.status(400)...
 *
 * consumeState() is destructive: a valid state can only be used once.
 */

import { randomBytes } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SWEEP_INTERVAL_MS = 60 * 1000; // sweep expired every minute

interface StateEntry {
  expiresAt: number;
}

const states = new Map<string, StateEntry>();

let sweeper: NodeJS.Timeout | null = null;

function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of states.entries()) {
      if (entry.expiresAt < now) states.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

/**
 * Issue a new state token. The caller stores it in the redirect URL
 * and expects to see it back in the callback.
 */
export function issueState(): string {
  startSweeper();
  const token = randomBytes(24).toString('hex');
  states.set(token, { expiresAt: Date.now() + STATE_TTL_MS });
  return token;
}

/**
 * Consume a state token. Returns true if the token was issued by us
 * and hasn't expired or been used. The token is deleted regardless of
 * outcome, so a replayed callback always fails.
 *
 * Constant-time-ish: for a 48-char hex token, timing attacks on the
 * Map lookup are infeasible. We don't bother with timingSafeEqual.
 */
export function consumeState(token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const entry = states.get(token);
  if (!entry) return false;
  states.delete(token);
  if (entry.expiresAt < Date.now()) return false;
  return true;
}

/**
 * For tests: clear all pending states and stop the sweeper.
 */
export function _resetForTests(): void {
  states.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/**
 * For tests: number of pending states. Not for production use.
 */
export function _pendingCount(): number {
  return states.size;
}
