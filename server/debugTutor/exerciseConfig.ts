/**
 * Per-exercise configuration.
 *
 * `struggleMinutes` — how long the student must spend on the exercise
 * (with at least one code submission) before the first hint unlocks.
 * 0 means no timer.
 *
 * For v1, this is a static map. When exercise authoring gets built out,
 * this moves to an `exercises` table in SQLite and this file becomes
 * the seed data.
 */
export const EXERCISE_STRUGGLE_MINUTES: Record<string, number> = {
  // Example entries — adjust or remove as needed.
  'ex-1': 3,
  'ex-hard-loop': 5,
  'ex-nested-loops': 4,
};

export const DEFAULT_STRUGGLE_MINUTES = 0;

export function getStruggleMinutes(exerciseId: string): number {
  const configured = EXERCISE_STRUGGLE_MINUTES[exerciseId];
  return typeof configured === 'number' ? configured : DEFAULT_STRUGGLE_MINUTES;
}
