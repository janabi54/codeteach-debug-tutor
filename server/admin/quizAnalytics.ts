// ─────────────────────────────────────────────────────────────
// Quiz / exercise performance analytics
// Phase 3.5d — per-exercise and per-student aggregates from
// the answers + quiz_attempts tables.
// ─────────────────────────────────────────────────────────────
import { sqlite } from '../db.js';

export interface QuestionStat {
  questionId: string;
  text: string;
  correct: number;
  total: number;
  pctCorrect: number;
}

export interface ExerciseStat {
  slug: string;
  title: string;
  exerciseType: string;
  attempts: number;
  uniqueStudents: number;
  correctCount: number;
  totalCount: number;
  pctCorrect: number;
  questions: QuestionStat[];
}

export interface StudentStat {
  studentId: string;
  email: string;
  attempts: number;
  uniqueExercises: number;
  avgScore: number | null;
  correctAnswers: number;
  totalAnswers: number;
  pctCorrect: number;
  lastAttempt: string | null;
}

export interface QuizAnalytics {
  cohortId: string;
  range: number;
  includeInstructor: boolean;
  byExercise: ExerciseStat[];
  byStudent: StudentStat[];
  generatedAt: string;
}

/**
 * Aggregate exercise-level and student-level performance stats
 * for a cohort, optionally limited to the last N days (0 = all time).
 */
export function getQuizAnalytics(
  cohortId: string,
  days: number,
  includeInstructor: boolean = false
): QuizAnalytics {
  const daysClause = days > 0
    ? `AND a.created_at >= datetime('now', '-${days} days')`
    : '';

  // ── By exercise ──
  const exerciseRows = sqlite.prepare(`
    SELECT e.slug, e.title, e.exercise_type AS exerciseType,
           COUNT(*) AS attempts,
           COUNT(DISTINCT a.student_id) AS uniqueStudents,
           SUM(a.correct) AS correctCount,
           COUNT(a.id) AS totalCount
    FROM answers a
    JOIN exercises e ON e.slug = a.exercise_id
    LEFT JOIN users u ON u.id = a.student_id
    WHERE e.cohort_id = ?
      ${!includeInstructor ? "AND u.role = 'student'" : ''}
      ${daysClause}
    GROUP BY e.slug
    ORDER BY totalCount DESC
  `).all(cohortId) as Array<{
    slug: string;
    title: string;
    exerciseType: string;
    attempts: number;
    uniqueStudents: number;
    correctCount: number;
    totalCount: number;
  }>;

  // ── Per-question stats for each exercise (only quiz type has question breakdowns) ──
  const byExercise: ExerciseStat[] = exerciseRows.map((r) => {
    const qRows = sqlite.prepare(`
      SELECT a.question_id AS questionId,
             COUNT(*) AS total,
             SUM(a.correct) AS correct
      FROM answers a
      JOIN users u ON u.id = a.student_id
      WHERE a.exercise_id = ?
        AND a.question_id IS NOT NULL
        ${!includeInstructor ? "AND u.role = 'student'" : ''}
        ${daysClause}
      GROUP BY a.question_id
      ORDER BY a.question_id
    `).all(r.slug) as Array<{ questionId: string; total: number; correct: number }>;

    const questions: QuestionStat[] = qRows.map((q) => ({
      questionId: q.questionId,
      text: '',
      correct: q.correct || 0,
      total: q.total,
      pctCorrect: q.total > 0 ? Math.round((q.correct / q.total) * 1000) / 10 : 0,
    }));

    return {
      slug: r.slug,
      title: r.title,
      exerciseType: r.exerciseType,
      attempts: r.attempts,
      uniqueStudents: r.uniqueStudents,
      correctCount: r.correctCount || 0,
      totalCount: r.totalCount || 0,
      pctCorrect: r.totalCount > 0 ? Math.round((r.correctCount / r.totalCount) * 1000) / 10 : 0,
      questions,
    };
  });

  // ── By student ──
  const studentRows = sqlite.prepare(`
    SELECT a.student_id AS studentId, u.email AS email,
           COUNT(*) AS attempts,
           COUNT(DISTINCT a.exercise_id) AS uniqueExercises,
           SUM(a.correct) AS correctAnswers,
           COUNT(a.id) AS totalAnswers,
           MAX(a.created_at) AS lastAttempt
    FROM answers a
    JOIN exercises e ON e.slug = a.exercise_id
    LEFT JOIN users u ON u.id = a.student_id
    WHERE e.cohort_id = ?
      ${!includeInstructor ? "AND u.role = 'student' AND a.student_id IN (SELECT user_id FROM cohort_members WHERE cohort_id = ?)" : ''}
      ${daysClause}
    GROUP BY a.student_id
    ORDER BY totalAnswers DESC
  `).all(...(includeInstructor ? [cohortId] : [cohortId, cohortId])) as Array<{
    studentId: string;
    email: string | null;
    attempts: number;
    uniqueExercises: number;
    correctAnswers: number;
    totalAnswers: number;
    lastAttempt: string | null;
  }>;

  // Enrich with average quiz score from quiz_attempts
  const byStudent: StudentStat[] = studentRows.map((r) => {
    const scoreRow = sqlite.prepare(`
      SELECT AVG(CAST(score AS REAL) / NULLIF(total, 0)) AS avgScore
      FROM quiz_attempts
      WHERE student_id = ? AND exercise_id IN (
        SELECT slug FROM exercises WHERE cohort_id = ?
      )
      ${days > 0 ? `AND submitted_at >= datetime('now', '-${days} days')` : ''}
    `).get(r.studentId, cohortId) as { avgScore: number | null } | undefined;

    return {
      studentId: r.studentId,
      email: r.email || '(unknown)',
      attempts: r.attempts,
      uniqueExercises: r.uniqueExercises,
      avgScore: scoreRow?.avgScore ?? null,
      correctAnswers: r.correctAnswers || 0,
      totalAnswers: r.totalAnswers || 0,
      pctCorrect: r.totalAnswers > 0 ? Math.round((r.correctAnswers / r.totalAnswers) * 1000) / 10 : 0,
      lastAttempt: r.lastAttempt,
    };
  });

  return {
    cohortId,
    range: days,
    includeInstructor,
    byExercise,
    byStudent,
    generatedAt: new Date().toISOString(),
  };
}
