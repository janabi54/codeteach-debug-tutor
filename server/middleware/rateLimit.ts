/**
 * In-memory rate limiter.
 *
 * Counts failed attempts keyed by a composite string (usually email + IP).
 * After `maxAttempts` failures within `windowMs`, blocks further attempts
 * for `blockMs`. Successful auth calls `clear()` to reset the counter.
 *
 * Not persisted — a server restart resets all counters. Fine for a
 * single-instance classroom app; multi-instance would need Redis.
 */

interface Bucket {
  count: number;
  firstAt: number;
  blockedUntil: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Bucket key — typically `email|ip` or just `ip`. */
  key: string;
  /** Max failures allowed within the window. */
  maxAttempts?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Block duration once the limit is exceeded. */
  blockMs?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

const DEFAULT_MAX = 5;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_BLOCK_MS = 5 * 60 * 1000;

/** Check whether a request is allowed. Does NOT increment. */
export function checkLimit(opts: RateLimitOptions): RateLimitResult {
  const max = opts.maxAttempts ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const now = Date.now();

  const bucket = buckets.get(opts.key);
  if (!bucket) {
    return { allowed: true, remaining: max, retryAfterSeconds: 0 };
  }

  // If blocked, check whether the block has expired
  if (bucket.blockedUntil > now) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
    };
  }

  // If the window has rolled over, reset
  if (now - bucket.firstAt > windowMs) {
    buckets.delete(opts.key);
    return { allowed: true, remaining: max, retryAfterSeconds: 0 };
  }

  const remaining = Math.max(0, max - bucket.count);
  return { allowed: true, remaining, retryAfterSeconds: 0 };
}

/** Record a failed attempt. Returns the new state. */
export function recordFailure(opts: RateLimitOptions): RateLimitResult {
  const max = opts.maxAttempts ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const blockMs = opts.blockMs ?? DEFAULT_BLOCK_MS;
  const now = Date.now();

  const bucket = buckets.get(opts.key);

  if (!bucket || now - bucket.firstAt > windowMs) {
    buckets.set(opts.key, {
      count: 1,
      firstAt: now,
      blockedUntil: 0,
    });
    return { allowed: true, remaining: max - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;

  if (bucket.count > max) {
    bucket.blockedUntil = now + blockMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil(blockMs / 1000),
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, max - bucket.count),
    retryAfterSeconds: 0,
  };
}

/** Clear the counter for a key. Call on successful auth. */
export function clearLimit(key: string): void {
  buckets.delete(key);
}

/** Periodic cleanup to prevent unbounded growth. */
export function pruneStaleBuckets(): number {
  const now = Date.now();
  const windowMs = DEFAULT_WINDOW_MS * 4; // keep buckets up to 20 minutes past
  let removed = 0;
  for (const [key, bucket] of buckets.entries()) {
    const stale =
      bucket.blockedUntil < now &&
      now - bucket.firstAt > windowMs;
    if (stale) {
      buckets.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Extract a client IP from the request. */
export function clientIp(req: any): string {
  // Express behind a proxy sets x-forwarded-for
  const xff = req.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
