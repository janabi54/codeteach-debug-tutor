import { sqlite } from '../../db';
import { signBody } from './events';

const TICK_MS = 5_000;
const BATCH = 20;
const TIMEOUT_MS = 10_000;

// Backoff in seconds, indexed by attempt count (attempts starts at 0).
// 1m, 5m, 30m, 2h, 12h, 24h — then dead.
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200, 86400];

interface DeliveryRow {
  id: number;
  subscription_id: number;
  event_type: string;
  event_id: string;
  payload: string;
  attempts: number;
  url: string;
  secret: string;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startDispatcher(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log('[webhooks] outbound dispatcher started');
}

export function stopDispatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = sqlite
      .prepare(
        `SELECT d.id, d.subscription_id, d.event_type, d.event_id, d.payload, d.attempts,
                s.url, s.secret
           FROM webhook_deliveries d
           JOIN webhook_subscriptions s ON s.id = d.subscription_id
          WHERE d.status = 'pending'
            AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= datetime('now'))
            AND s.active = 1
          ORDER BY d.next_attempt_at ASC
          LIMIT ?`
      )
      .all(BATCH) as DeliveryRow[];

    for (const row of rows) {
      await deliverOne(row);
    }
  } catch (err) {
    console.error('[webhooks] tick error', err);
  } finally {
    running = false;
  }
}

async function deliverOne(row: DeliveryRow): Promise<void> {
  const signature = signBody(row.secret, row.payload);
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let httpStatus: number | null = null;
  let errorText: string | null = null;
  let ok = false;

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'CodeTeach-Webhooks/1.0',
        'X-CodeTeach-Event': row.event_type,
        'X-CodeTeach-Delivery': row.event_id,
        'X-CodeTeach-Signature': `sha256=${signature}`,
      },
      body: row.payload,
      signal: controller.signal,
    });
    httpStatus = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) errorText = `HTTP ${res.status}`;
  } catch (err: any) {
    errorText = err?.name === 'AbortError' ? 'timeout' : String(err?.message ?? err);
  } finally {
    clearTimeout(to);
  }

  if (ok) {
    sqlite.prepare(
      `UPDATE webhook_deliveries
          SET status = 'delivered',
              attempts = attempts + 1,
              last_status = ?,
              last_error = NULL,
              delivered_at = datetime('now')
        WHERE id = ?`
    ).run(httpStatus, row.id);
    return;
  }

  const delaySec = BACKOFF_SECONDS[row.attempts];

  if (delaySec === undefined) {
    sqlite.prepare(
      `UPDATE webhook_deliveries
          SET status = 'dead',
              attempts = attempts + 1,
              last_status = ?,
              last_error = ?
        WHERE id = ?`
    ).run(httpStatus, errorText, row.id);
    console.warn(`[webhooks] delivery ${row.id} dead: ${errorText}`);
    return;
  }

  sqlite.prepare(
    `UPDATE webhook_deliveries
        SET status = 'pending',
            attempts = attempts + 1,
            last_status = ?,
            last_error = ?,
            next_attempt_at = datetime('now', '+' || ? || ' seconds')
      WHERE id = ?`
  ).run(httpStatus, errorText, delaySec, row.id);
}
