import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { sqlite } from '../../db.js';
import { verifyInbound } from './verify/index.js';
import {
  GITHUB_DELIVERY_HEADER,
  GITHUB_EVENT_HEADER,
} from './verify/github.js';

/**
 * Inbound webhook router.
 *
 * Mounted at /webhooks/in BEFORE the global express.json() middleware,
 * so req.body here is a raw Buffer, not parsed JSON. This is required:
 * HMAC signatures are computed over the raw bytes.
 *
 * URL: POST /webhooks/in/:slug
 */

interface EndpointRow {
  id: number;
  slug: string;
  provider: string;
  secret: string;
  cohort_id: string | null;
  active: number;
}

const router = Router();

router.post('/:slug', (req: Request, res: Response) => {
  const slug = String(req.params.slug || '').trim();
  if (!slug) return res.status(404).json({ error: 'not found' });

  const endpoint = sqlite
    .prepare(
      `SELECT id, slug, provider, secret, cohort_id, active
         FROM webhook_endpoints
        WHERE slug = ?`
    )
    .get(slug) as EndpointRow | undefined;

  if (!endpoint || !endpoint.active) {
    return res.status(404).json({ error: 'not found' });
  }

  // express.raw() populates req.body with a Buffer. If we somehow got a
  // parsed object (middleware misconfiguration), fail loudly rather than
  // verifying a signature against garbage.
  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    console.error(
      `[webhooks:inbound] endpoint ${endpoint.slug} received non-Buffer body — ` +
        `check middleware order in server/index.ts`
    );
    return res.status(500).json({ error: 'server misconfigured' });
  }

  const verify = verifyInbound(
    endpoint.provider,
    rawBody,
    req.headers as Record<string, string | string[] | undefined>,
    endpoint.secret
  );

  if (!verify.ok) {
    console.warn(
      `[webhooks:inbound] signature rejected for ${endpoint.slug}: ${verify.reason}`
    );
    return res.status(401).json({ error: 'unauthorized' });
  }

  const externalId = extractExternalId(
    endpoint.provider,
    req.headers as Record<string, string | string[] | undefined>,
    rawBody
  );
  const eventType = extractEventType(
    endpoint.provider,
    req.headers as Record<string, string | string[] | undefined>
  );

  const payload = rawBody.toString('utf8');
  const inserted = sqlite
    .prepare(
      `INSERT OR IGNORE INTO webhook_inbound_events
         (endpoint_id, provider, external_id, event_type, payload, signature_ok, processed)
       VALUES (?, ?, ?, ?, ?, 1, 0)`
    )
    .run(
      endpoint.id,
      endpoint.provider,
      externalId,
      eventType,
      payload
    );

  if (inserted.changes === 0) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  return res.status(200).json({ ok: true, id: externalId });
});

function extractExternalId(
  provider: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer
): string {
  if (provider === 'github') {
    const id = headers[GITHUB_DELIVERY_HEADER];
    if (typeof id === 'string' && id) return id;
    return bodyHash(rawBody);
  }
  if (provider === 'generic') {
    const id = headers['x-webhook-delivery'];
    if (typeof id === 'string' && id) return id;
    return bodyHash(rawBody);
  }
  return bodyHash(rawBody);
}

function extractEventType(
  provider: string,
  headers: Record<string, string | string[] | undefined>
): string | null {
  if (provider === 'github') {
    const t = headers[GITHUB_EVENT_HEADER];
    return typeof t === 'string' && t ? t : null;
  }
  if (provider === 'generic') {
    const t = headers['x-webhook-event'];
    return typeof t === 'string' && t ? t : null;
  }
  return null;
}

function bodyHash(rawBody: Buffer): string {
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

export default router;
