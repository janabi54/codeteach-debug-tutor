import { sqlite } from '../../db';
import { WebhookEventType, newEventId } from './events';

interface SubscriptionRow {
  id: number;
  event_types: string;
}

/**
 * Enqueue a webhook event for every cohort the student belongs to.
 * No-op if the student is in no cohorts, or no matching subscriptions exist.
 *
 * Synchronous (better-sqlite3). One SELECT for memberships,
 * one for subscriptions, N INSERTs. Never throws on "no subscribers".
 */
export function emit(
  studentId: string,
  eventType: WebhookEventType,
  data: Record<string, unknown>
): void {
  const cohortRows = sqlite
    .prepare('SELECT cohort_id FROM cohort_members WHERE user_id = ?')
    .all(studentId) as Array<{ cohort_id: string }>;

  if (cohortRows.length === 0) return;

  const cohortIds = cohortRows.map((r) => r.cohort_id);
  const placeholders = cohortIds.map(() => '?').join(',');

  const subs = sqlite
    .prepare(
      `SELECT id, event_types
         FROM webhook_subscriptions
        WHERE cohort_id IN (${placeholders}) AND active = 1`
    )
    .all(...cohortIds) as SubscriptionRow[];

  if (subs.length === 0) return;

  const eventId = newEventId();
  const occurredAt = new Date().toISOString();
  const envelope = {
    id: eventId,
    type: eventType,
    student_id: studentId,
    occurred_at: occurredAt,
    data,
  };
  const payload = JSON.stringify(envelope);

  const insert = sqlite.prepare(
    `INSERT INTO webhook_deliveries
       (subscription_id, event_type, event_id, payload, status, attempts, next_attempt_at)
     VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'))`
  );

  for (const sub of subs) {
    let types: string[] = [];
    try {
      types = JSON.parse(sub.event_types);
    } catch {
      continue;
    }
    if (!types.includes(eventType)) continue;
    insert.run(sub.id, eventType, eventId, payload);
  }
}
