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
 * Same join as viewableExerciseIdsFor, but returns full exercise rows
 * for the exercises an instructor can see for a given student. Used
 * by the "recommended next action" engine.
 */
export function viewableExercisesFor(
  instructorId: string,
  studentId: string
): Array<{ slug: string; title: string; expectedConcepts: string[] }> {
  const rows = sqlite
    .prepare(
      `SELECT e.slug AS slug,
              e.title AS title,
              e.expected_concepts AS expectedConceptsJson
       FROM exercises e
       JOIN cohorts c ON c.id = e.cohort_id
       JOIN cohort_members cm ON cm.cohort_id = c.id
       WHERE c.instructor_id = ?
         AND cm.user_id = ?
       ORDER BY e.slug`
    )
    .all(instructorId, studentId) as Array<{
      slug: string;
      title: string;
      expectedConceptsJson: string;
    }>;

  return rows.map((r) => {
    let concepts: string[] = [];
    try {
      const parsed = JSON.parse(r.expectedConceptsJson || '[]');
      if (Array.isArray(parsed)) concepts = parsed.filter((x) => typeof x === 'string');
    } catch {
      concepts = [];
    }
    return { slug: r.slug, title: r.title, expectedConcepts: concepts };
  });
}

/**
 * For the cohort comparison panel: given a target student and an
 * instructor, return the IDs of other students in the cohorts they
 * share (excluding the target student), plus the names of those
 * cohorts.
 *
 * We deliberately do NOT cross cohorts — same-cohort peers only.
 */
export function cohortPeersFor(
  instructorId: string,
  studentId: string
): { peerIds: string[]; cohortNames: string[] } {
  // Step 1: which cohorts do the instructor and this student share?
  // This uses only the target student's membership — it must succeed
  // even when the cohort has no other members (in which case the
  // client shows a "not enough peers yet" note).
  const cohortRows = sqlite
    .prepare(
      `SELECT DISTINCT c.id AS cohortId, c.name AS cohortName
       FROM cohort_members cm_target
       JOIN cohorts c ON c.id = cm_target.cohort_id
       WHERE cm_target.user_id = ?
         AND c.instructor_id = ?`
    )
    .all(studentId, instructorId) as Array<{
      cohortId: string;
      cohortName: string;
    }>;

  if (cohortRows.length === 0) {
    return { peerIds: [], cohortNames: [] };
  }

  const cohortIds = Array.from(new Set(cohortRows.map((r) => r.cohortId)));
  const cohortNames = Array.from(new Set(cohortRows.map((r) => r.cohortName)));
  const placeholders = cohortIds.map(() => '?').join(',');

  // Step 2: which other users are members of those cohorts?
  const peerRows = sqlite
    .prepare(
      `SELECT DISTINCT user_id AS peerId
       FROM cohort_members
       WHERE cohort_id IN (${placeholders})
         AND user_id != ?`
    )
    .all(...cohortIds, studentId) as Array<{ peerId: string }>;

  const peerIds = Array.from(new Set(peerRows.map((r) => r.peerId)));

  return { peerIds, cohortNames };
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
