import { handleGenericEvent, GenericEvent } from './generic.js';
import { handleGithubEvent, GithubEvent } from './github.js';

export interface InboundEvent {
  endpointId: number;
  provider: string;
  externalId: string;
  eventType: string | null;
  payload: string;
}

/**
 * Dispatch to the right handler based on provider.
 *
 * Unknown providers resolve to a no-op that logs — never throws. The
 * row is already durably recorded, so a missing handler is not a failure.
 */
export async function handleInboundEvent(event: InboundEvent): Promise<void> {
  const base = {
    endpointId: event.endpointId,
    externalId: event.externalId,
    eventType: event.eventType,
    payload: event.payload,
  };

  switch (event.provider) {
    case 'generic':
      return handleGenericEvent(base as GenericEvent);
    case 'github':
      return handleGithubEvent(base as GithubEvent);
    default:
      console.warn(
        `[webhooks:inbound] no handler for provider "${event.provider}" ` +
          `(endpoint ${event.endpointId})`
      );
      return;
  }
}
