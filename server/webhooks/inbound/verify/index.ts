import { verifyGeneric } from './generic.js';
import { verifyGithub } from './github.js';

export type InboundProvider = 'generic' | 'github';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Dispatch to the right verifier based on the endpoint's provider.
 * Unknown providers are rejected — this is a closed set.
 */
export function verifyInbound(
  provider: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string
): VerifyResult {
  switch (provider) {
    case 'generic':
      return verifyGeneric(rawBody, headers, secret);
    case 'github':
      return verifyGithub(rawBody, headers, secret);
    default:
      return { ok: false, reason: `unsupported provider: ${provider}` };
  }
}
