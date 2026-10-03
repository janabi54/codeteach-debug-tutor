import { randomBytes } from 'node:crypto';

/**
 * Enrollment codes are persistent per cohort — one code, many students use it
 * to join. Different from invite codes, which are single-use.
 *
 * Uses the same human-friendly alphabet: no 0/O/1/I/l.
 */
export function generateEnrollmentCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4, 8)}`;
}
