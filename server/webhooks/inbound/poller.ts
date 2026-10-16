import { sqlite } from '../../db.js';
import { handleInboundEvent } from './handlers/index.js';

const TICK_MS = 5_000;
const BATCH = 20;

interface PendingRow {
  id: number;
  endpoint_id: number;
  provider: string;
  external_id: string;
  event_type: string | null;
  payload: string;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startInboundPoller(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log('[webhooks] inbound poller started');
}

export function stopInboundPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = sqlite
      .prepare(
        `SELECT id, endpoint_id, provider, external_id, event_type, payload
           FROM webhook_inbound_events
          WHERE processed = 0
          ORDER BY received_at ASC
          LIMIT ?`
      )
      .all(BATCH) as PendingRow[];

    for (const row of rows) {
      await processOne(row);
    }
  } catch (err) {
    console.error('[webhooks] inbound tick error', err);
  } finally {
    running = false;
  }
}

async function processOne(row: PendingRow): Promise<void> {
  try {
    await handleInboundEvent({
      endpointId: row.endpoint_id,
      provider: row.provider,
      externalId: row.external_id,
      eventType: row.event_type,
      payload: row.payload,
    });

    sqlite
      .prepare(
        `UPDATE webhook_inbound_events
            SET processed = 1, process_error = NULL
          WHERE id = ?`
      )
      .run(row.id);
  } catch (err: any) {
    // Handler threw. Record the error and mark processed=1 anyway —
    // we don't want a poison row to be retried forever. The raw event
    // is preserved in the row for manual inspection.
    const msg = String(err?.message ?? err).slice(0, 500);
    sqlite
      .prepare(
        `UPDATE webhook_inbound_events
            SET processed = 1, process_error = ?
          WHERE id = ?`
      )
      .run(msg, row.id);
    console.error(`[webhooks] inbound handler failed for event ${row.id}: ${msg}`);
  }
}
