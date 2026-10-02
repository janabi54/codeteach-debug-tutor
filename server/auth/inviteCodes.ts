import { randomBytes } from 'node:crypto';

/**
 * Generate a human-friendly invite code: 12 chars from an unambiguous set.
 * No 0/O/1/I/l to reduce transcription errors.
 * Format as XXXX-XXXX-XXXX for readability.
 */
export function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let code = '';
  for (let i = 0; i < 12; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`;
}
