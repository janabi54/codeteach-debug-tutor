import crypto from 'node:crypto';

export type WebhookEventType =
  | 'exercise.completed'
  | 'student.at_risk'
  | 'message.created'
  | 'nudge.sent'
  | 'announcement.sent';

export const ALL_EVENT_TYPES: WebhookEventType[] = [
  'exercise.completed',
  'student.at_risk',
  'message.created',
  'nudge.sent',
  'announcement.sent',
];

/** Sortable-ish unique id: ms timestamp (base36) + 20 hex chars. */
export function newEventId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = crypto.randomBytes(10).toString('hex');
  return `${ts}${rand}`;
}

/** HMAC-SHA256 hex of the raw body. Sent as `X-CodeTeach-Signature: sha256=<hex>`. */
export function signBody(secret: string, rawBody: string): string {
  return crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/** Generate a per-subscription secret. */
export function newSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}
