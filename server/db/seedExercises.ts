import { sqlite, db } from '../db.js';
import { EXERCISE_STRUGGLE_MINUTES } from '../debugTutor/exerciseConfig.js';

/**
 * One-time seed: migrates the static `exerciseConfig.ts` map into real
 * exercise rows, owned by the first instructor.
 *
 * Idempotent — if a slug already exists, it's skipped.
 */
export async function seedExercisesFromConfig(): Promise<void> {
  const entries = Object.entries(EXERCISE_STRUGGLE_MINUTES);
  if (entries.length === 0) return;

  // Find any instructor to attribute the seed rows to
  const instructorRow = sqlite
    .prepare("SELECT id FROM users WHERE role = 'instructor' ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string } | undefined;

  if (!instructorRow) {
    console.warn('[seed] no instructor found — skipping exercise seed');
    return;
  }
  const instructorId = instructorRow.id;

  const cohort = await db.cohorts.ensureForInstructor(instructorId);

  let seeded = 0;
  for (const [exerciseId, minutes] of entries) {
    const existing = await db.exercises.findBySlug(exerciseId);
    if (existing) continue;
    await db.exercises.create({
      slug: exerciseId,
      title: exerciseId,
      description: '',
      language: 'javascript',
      starterCode: '',
      expectedConcepts: [],
      learningObjectives: [],
      struggleMinutes: minutes,
      cohortId: cohort.id,
      createdBy: instructorId,
    });
    seeded += 1;
  }

  if (seeded > 0) {
    console.log(`[seed] migrated ${seeded} exercise(s) from exerciseConfig.ts`);
  }
}
