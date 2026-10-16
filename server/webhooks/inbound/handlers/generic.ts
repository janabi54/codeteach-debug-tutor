/**
 * Generic inbound handler.
 *
 * The generic provider has no defined schema — anyone can POST anything
 * signed with the endpoint's secret. So the handler is intentionally a
 * no-op: the event is already recorded in webhook_inbound_events, and
 * that's the entire contract for v1.
 *
 * Later, per-endpoint "actions" could be added (e.g. "if event_type ===
 * 'build.failed', open a nudge"), but that's a future extension.
 */

export interface GenericEvent {
  endpointId: number;
  externalId: string;
  eventType: string | null;
  payload: string;
}

export async function handleGenericEvent(_event: GenericEvent): Promise<void> {
  // No-op. The event is durably recorded in webhook_inbound_events.
  // This function exists so the dispatcher has a uniform interface.
}
