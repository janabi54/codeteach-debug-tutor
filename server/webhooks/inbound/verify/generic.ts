import crypto from 'node:crypto';

/**
 * Generic HMAC verification.
 *
 * Signed message is: `<timestamp>.<raw_body>`
 * Signature header:  `X-Webhook-Signature: sha256=<hex>`
 * Timestamp header:  `X-Webhook-Timestamp: <unix seconds>`
 *
 * Timestamp must be within REPLAY_WINDOW_SECONDS of now, otherwise
 * the request is rejected (protects against captured-and-replayed bodies).
 */

export const GENERIC_SIG_HEADER = 'x-webhook-signature';
export const GENERIC_TS_HEADER = 'x-webhook-timestamp';
export const REPLAY_WINDOW_SECONDS = 5 * 60;

export interface GenericVerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyGeneric(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  now = Math.floor(Date.now() / 1000)
): GenericVerifyResult {
  const sigHeader = headers[GENERIC_SIG_HEADER];
  const tsHeader = headers[GENERIC_TS_HEADER];

  if (typeof sigHeader !== 'string' || !sigHeader) {
    return { ok: false, reason: 'missing signature header' };
  }
  if (typeof tsHeader !== 'string' || !tsHeader) {
    return { ok: false, reason: 'missing timestamp header' };
  }

  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || !Number.isInteger(ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }

  const skew = Math.abs(now - ts);
  if (skew > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: `timestamp outside window (skew ${skew}s)` };
  }

  // Strip the "sha256=" prefix if present.
  const provided = sigHeader.startsWith('sha256=')
    ? sigHeader.slice('sha256='.length)
    : sigHeader;

  const message = `${tsHeader}.${rawBody.toString('utf8')}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(message, 'utf8')
    .digest('hex');

  const ok = safeEqualHex(provided, expected);
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

/**
 * Constant-time hex comparison. Uses Buffer.compare on equal-length buffers,
 * plus a length pre-check. Returns false on any malformation.
 */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(a, 'hex'),
      Buffer.from(b, 'hex')
    );
  } catch {
    return false;
  }
}
