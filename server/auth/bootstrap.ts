import { db } from '../db.js';
import { hashPassword } from './passwords.js';

export async function bootstrapInstructor(): Promise<void> {
  const existing = await db.users.countByRole('instructor');
  if (existing > 0) return;

  const email = process.env.SEED_INSTRUCTOR_EMAIL;
  const password = process.env.SEED_INSTRUCTOR_PASSWORD;
  const displayName = process.env.SEED_INSTRUCTOR_NAME ?? 'Instructor';

  if (!email || !password) {
    console.warn(
      '[auth] no instructor exists and SEED_INSTRUCTOR_EMAIL/PASSWORD are not set — skipping seed'
    );
    return;
  }

  if (password === 'change-me-in-env' || password === 'CHOOSE-A-PASSWORD-HERE') {
    console.warn(
      '[auth] SEED_INSTRUCTOR_PASSWORD is still the placeholder value — refusing to seed. Update .env and restart.'
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await db.users.create({
    email,
    passwordHash,
    displayName,
    role: 'instructor',
  });
  console.log(`[auth] seeded instructor: ${user.email} (${user.displayName})`);
}
