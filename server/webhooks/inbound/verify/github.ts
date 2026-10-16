import crypto from 'node:crypto';

/**
 * GitHub webhook verification.
 *
 * Header:  `X-Hub-Signature-256: sha256=<hex>`
 * Signed:  raw request body only
 * Secret:  the webhook secret configured in the repo settings
 *
 * GitHub does not send a timestamp header, so there is no replay window
 * to check. GitHub's own delivery ID (X-GitHub-Delivery) serves as the
 * idempotency key instead.
 */

export const GITHUB_SIG_HEADER = 'x-hub-signature-256';
export const GITHUB_DELIVERY_HEADER = 'x-github-delivery';
export const GITHUB_EVENT_HEADER = 'x-github-event';

export interface GithubVerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyGithub(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string
): GithubVerifyResult {
  const sigHeader = headers[GITHUB_SIG_HEADER];

  if (typeof sigHeader !== 'string' || !sigHeader) {
    return { ok: false, reason: 'missing X-Hub-Signature-256 header' };
  }
  if (!sigHeader.startsWith('sha256=')) {
    return { ok: false, reason: 'unexpected signature prefix' };
  }

  const provided = sigHeader.slice('sha256='.length);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const ok = safeEqualHex(provided, expected);
  return ok ? { ok: true } : { ok: false, reason: 'signature mismatch' };
}

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
