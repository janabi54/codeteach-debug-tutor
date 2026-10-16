/**
 * GitHub inbound handler (capture-only for v1).
 *
 * Handles the two most common events:
 *   - `ping`  → GitHub's "test this webhook" event. Just log it.
 *   - `push`  → a push to a branch. Log the ref + commit count.
 *
 * For any other event type, we log a single line and return.
 * No database writes here — the row is already in webhook_inbound_events.
 */

export interface GithubEvent {
  endpointId: number;
  externalId: string;
  eventType: string | null;
  payload: string;
}

export async function handleGithubEvent(event: GithubEvent): Promise<void> {
  const { eventType, externalId } = event;

  if (eventType === 'ping') {
    try {
      const body = JSON.parse(event.payload);
      console.log(
        `[webhooks:github] ping from endpoint ${event.endpointId} ` +
          `(zen: ${body?.zen ?? 'n/a'})`
      );
    } catch {
      console.log(`[webhooks:github] ping (unparseable) delivery=${externalId}`);
    }
    return;
  }

  if (eventType === 'push') {
    try {
      const body = JSON.parse(event.payload);
      const ref = body?.ref ?? '?';
      const commits = Array.isArray(body?.commits) ? body.commits.length : 0;
      const repo = body?.repository?.full_name ?? '?';
      console.log(
        `[webhooks:github] push ${repo} ${ref} (${commits} commits) ` +
          `delivery=${externalId}`
      );
    } catch (err) {
      console.log(
        `[webhooks:github] push (unparseable) delivery=${externalId}: ${String(err)}`
      );
    }
    return;
  }

  console.log(
    `[webhooks:github] unhandled event type "${eventType ?? 'unknown'}" ` +
      `delivery=${externalId}`
  );
}
