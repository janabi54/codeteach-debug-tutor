import { sqlite } from '../db.js';

/**
 * Authorization rules for the instructor "Students" view.
 *
 * An instructor may view a student's work on a specific exercise ONLY if:
 *   1. The exercise belongs to a cohort the instructor teaches, AND
 *   2. The student is a member of that same cohort.
 *
 * This means: a student in two different instructors' cohorts has their
 * work for cohort A visible only to instructor A, and their work for
 * cohort B visible only to instructor B.
 *
 * Every query in the students endpoints MUST go through one of these
 * helpers. Never trust the client-supplied IDs.
 */

export interface CohortedExercise {
  cohortId: string;
  exerciseId: string;
}

/** Returns the cohort IDs this instructor teaches. */
export function instructorCohortIds(instructorId: string): string[] {
  const rows = sqlite
    .prepare('SELECT id FROM cohorts WHERE instructor_id = ?')
    .all(instructorId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/**
 * Returns true if the instructor teaches the cohort that owns this exercise.
 * Used as a first gate before any per-student check.
 */
export function instructorTeachesExercise(
  instructorId: string,
  exerciseSlug: string
): CohortedExercise | null {
  // The param is a slug — that's what the API and hint_sessions use.
  const row = sqlite
    .prepare(
      `SELECT e.cohort_id AS cohortId, e.slug AS exerciseId
       FROM exercises e
       JOIN cohorts c ON c.id = e.cohort_id
       WHERE e.slug = ? AND c.instructor_id = ?`
    )
    .get(exerciseSlug, instructorId) as CohortedExercise | undefined;
  return row ?? null;
}

/**
 * Returns true if the student is a member of the given cohort.
 */
export function studentInCohort(studentId: string, cohortId: string): boolean {
  const row = sqlite
    .prepare(
      'SELECT 1 AS ok FROM cohort_members WHERE user_id = ? AND cohort_id = ? LIMIT 1'
    )
    .get(studentId, cohortId) as { ok: number } | undefined;
  return !!row;
}

/**
 * The composite check. True only when the instructor teaches the exercise's
 * cohort AND the student is a member of that cohort.
 */
export function canInstructorViewStudentOnExercise(
  instructorId: string,
  studentId: string,
  exerciseId: string
): boolean {
  const cohorted = instructorTeachesExercise(instructorId, exerciseId);
  if (!cohorted) return false;
  return studentInCohort(studentId, cohorted.cohortId);
}

/**
 * For the student detail page: returns the set of exercises the instructor
 * teaches that the student is eligible to have work on (i.e., the
 * intersection of "instructor's exercises" and "student's cohorts").
 *
 * Used to filter every query that shows a student's work.
 */
export function viewableExerciseIdsFor(
  instructorId: string,
  studentId: string
): string[] {
  // NOTE: hint_sessions.exercise_id stores the *slug*, not the UUID.
  // We must return slugs here so the downstream IN (...) filter matches.
  const rows = sqlite
    .prepare(
      `SELECT e.slug AS exerciseSlug
       FROM exercises e
       JOIN cohorts c ON c.id = e.cohort_id
       JOIN cohort_members cm ON cm.cohort_id = c.id
       WHERE c.instructor_id = ?
         AND cm.user_id = ?`
    )
    .all(instructorId, studentId) as Array<{ exerciseSlug: string }>;
  return rows.map((r) => r.exerciseSlug);
}

/**
 * For the roster: returns every (student, cohort) pair the instructor can
 * see — i.e., students who are members of any cohort the instructor teaches.
 */
export function rosterFor(instructorId: string): Array<{
  studentId: string;
  cohortId: string;
  cohortName: string;
  joinedAt: string;
}> {
  return sqlite
    .prepare(
      `SELECT
         cm.user_id AS studentId,
         c.id AS cohortId,
         c.name AS cohortName,
         cm.joined_at AS joinedAt
       FROM cohort_members cm
       JOIN cohorts c ON c.id = cm.cohort_id
       WHERE c.instructor_id = ?`
    )
    .all(instructorId) as Array<{
      studentId: string;
      cohortId: string;
      cohortName: string;
      joinedAt: string;
    }>;
}
