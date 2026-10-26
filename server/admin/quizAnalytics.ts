// ─────────────────────────────────────────────────────────────
// Quiz / exercise performance analytics
// Phase 3.5d — per-exercise and per-student aggregates from
// the answers + quiz_attempts tables.
// ─────────────────────────────────────────────────────────────
import { sqlite } from '../db.js';

export interface QuestionStat {
  questionId: string;
  text: string;
  type: string;
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

    // Look up the exercise's full question list (for text + type)
    const exMeta = sqlite.prepare(
      "SELECT options_json FROM exercises WHERE slug = ?"
    ).get(r.slug) as { options_json: string | null } | undefined;
    let questionsById: Record<string, { text: string; type: string }> = {};
    if (exMeta && exMeta.options_json) {
      try {
        const parsed = JSON.parse(exMeta.options_json);
        if (parsed && Array.isArray(parsed.questions)) {
          for (const q of parsed.questions) {
            if (q && typeof q.id === 'string') {
              questionsById[q.id] = {
                text: typeof q.text === 'string' ? q.text : '',
                type: typeof q.type === 'string' ? q.type : 'multiple_choice',
              };
            }
          }
        }
      } catch { /* ignore bad JSON */ }
    }

    const questions: QuestionStat[] = qRows.map((q) => {
      const meta = questionsById[q.questionId] || { text: '', type: '' };
      return {
        questionId: q.questionId,
        text: meta.text,
        type: meta.type,
        correct: q.correct || 0,
        total: q.total,
        pctCorrect: q.total > 0 ? Math.round((q.correct / q.total) * 1000) / 10 : 0,
      };
    });

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


// ─────────────────────────────────────────────────────────────
// Phase 4.1: Weekly trend analytics
// ─────────────────────────────────────────────────────────────

export interface TrendPoint {
  week: string;          // e.g. '2026-W40'
  pctCorrect: number;
  attempts: number;
}

export interface ExerciseTrend {
  slug: string;
  title: string;
  exerciseType: string;
  totalAttempts: number;
  weeklyData: TrendPoint[];
  direction: 'up' | 'down' | 'flat';
  deltaPct: number;      // percentage points change from first to last week
}

export interface QuestionTrend {
  questionId: string;
  exerciseSlug: string;
  exerciseTitle: string;
  text: string;
  totalAttempts: number;
  weeklyData: TrendPoint[];
  direction: 'up' | 'down' | 'flat';
  deltaPct: number;
}

export interface StudentTrend {
  studentId: string;
  email: string;
  totalAttempts: number;
  weeklyData: TrendPoint[];
  direction: 'up' | 'down' | 'flat';
  deltaPct: number;
}

export interface TrendAnalytics {
  cohortId: string;
  weeks: number;
  includeInstructor: boolean;
  byExercise: ExerciseTrend[];
  byQuestion: QuestionTrend[];
  byStudent: StudentTrend[];
  generatedAt: string;
}

function classifyDirection(weekly: TrendPoint[]): { direction: 'up' | 'down' | 'flat'; deltaPct: number } {
  const points = weekly.filter((w) => w.attempts > 0);
  if (points.length < 2) return { direction: 'flat', deltaPct: 0 };
  const first = points[0].pctCorrect;
  const last = points[points.length - 1].pctCorrect;
  const delta = Math.round((last - first) * 10) / 10;
  if (delta > 5) return { direction: 'up', deltaPct: delta };
  if (delta < -5) return { direction: 'down', deltaPct: delta };
  return { direction: 'flat', deltaPct: delta };
}

/**
 * Weekly bucket aggregation (Sunday of each week as the label).
 * Returns array of week identifiers in ISO format: 'YYYY-Www'
 */
function weekBuckets(weeks: number): string[] {
  const out: string[] = [];
  const now = new Date();
  // Find the Sunday of this week (going back)
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - now.getDay());
  sunday.setHours(0, 0, 0, 0);

  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() - i * 7);
    const year = d.getFullYear();
    // ISO week calculation
    const jan1 = new Date(year, 0, 1);
    const days = Math.floor((d.getTime() - jan1.getTime()) / 86400000);
    const weekNum = Math.ceil((days + jan1.getDay() + 1) / 7);
    out.push(year + '-W' + String(weekNum).padStart(2, '0'));
  }
  return out;
}

/**
 * Get trends for a cohort: by exercise, by question, by student.
 */
export function getQuizTrends(cohortId: string, weeks: number, includeInstructor: boolean): TrendAnalytics {
  const weekList = weekBuckets(weeks);
  const lookbackDays = weeks * 7;

  const roleFilter = includeInstructor ? '' : "AND u.role = 'student'";

  // ── By exercise ──
  const exRows = sqlite.prepare(`
    SELECT e.slug, e.title, e.exercise_type AS exerciseType,
           strftime('%Y-%W', a.created_at) AS weekKey,
           COUNT(*) AS attempts,
           SUM(a.correct) AS correct
    FROM answers a
    JOIN exercises e ON e.slug = a.exercise_id
    LEFT JOIN users u ON u.id = a.student_id
    WHERE e.cohort_id = ?
      ${roleFilter}
      AND a.created_at >= datetime('now', '-${lookbackDays} days')
    GROUP BY e.slug, weekKey
    ORDER BY e.slug, weekKey
  `).all(cohortId) as Array<{ slug: string; title: string; exerciseType: string; weekKey: string; attempts: number; correct: number }>;

  const byExercise = aggregateIntoWeeks(
    exRows.map((r) => ({ ...r, key: r.slug, meta: { title: r.title, exerciseType: r.exerciseType } })),
    weekList
  ).map((row) => {
    const { direction, deltaPct } = classifyDirection(row.weeklyData);
    return {
      slug: row.key,
      title: row.meta.title,
      exerciseType: row.meta.exerciseType,
      totalAttempts: row.totalAttempts,
      weeklyData: row.weeklyData,
      direction,
      deltaPct,
    };
  });

  // ── By question ──
  const qRows = sqlite.prepare(`
    SELECT a.question_id AS questionId,
           a.exercise_id AS exerciseSlug,
           e.title AS exerciseTitle,
           strftime('%Y-%W', a.created_at) AS weekKey,
           COUNT(*) AS attempts,
           SUM(a.correct) AS correct
    FROM answers a
    JOIN exercises e ON e.slug = a.exercise_id
    LEFT JOIN users u ON u.id = a.student_id
    WHERE e.cohort_id = ?
      ${roleFilter}
      AND a.question_id IS NOT NULL
      AND a.created_at >= datetime('now', '-${lookbackDays} days')
    GROUP BY a.question_id, weekKey
    ORDER BY a.question_id, weekKey
  `).all(cohortId) as Array<{ questionId: string; exerciseSlug: string; exerciseTitle: string; weekKey: string; attempts: number; correct: number }>;

  // Also enrich question text from options_json
  const questionTextMap = new Map<string, string>();
  const exMetaRows = sqlite.prepare('SELECT slug, options_json FROM exercises WHERE cohort_id = ? AND options_json IS NOT NULL').all(cohortId) as Array<{ slug: string; options_json: string }>;
  for (const r of exMetaRows) {
    try {
      const parsed = JSON.parse(r.options_json);
      if (parsed && Array.isArray(parsed.questions)) {
        for (const q of parsed.questions) {
          if (q && q.id) questionTextMap.set(r.slug + ':' + q.id, q.text || '');
        }
      }
    } catch {}
  }

  const byQuestion = aggregateIntoWeeks(
    qRows.map((r) => ({ ...r, key: r.questionId, meta: { exerciseSlug: r.exerciseSlug, exerciseTitle: r.exerciseTitle } })),
    weekList
  ).map((row) => {
    const { direction, deltaPct } = classifyDirection(row.weeklyData);
    const textKey = row.meta.exerciseSlug + ':' + row.key;
    return {
      questionId: row.key,
      exerciseSlug: row.meta.exerciseSlug,
      exerciseTitle: row.meta.exerciseTitle,
      text: questionTextMap.get(textKey) || '',
      totalAttempts: row.totalAttempts,
      weeklyData: row.weeklyData,
      direction,
      deltaPct,
    };
  });

  // ── By student ──
  const sRows = sqlite.prepare(`
    SELECT a.student_id AS studentId, u.email AS email,
           strftime('%Y-%W', a.created_at) AS weekKey,
           COUNT(*) AS attempts,
           SUM(a.correct) AS correct
    FROM answers a
    JOIN exercises e ON e.slug = a.exercise_id
    LEFT JOIN users u ON u.id = a.student_id
    WHERE e.cohort_id = ?
      ${roleFilter}
      AND a.created_at >= datetime('now', '-${lookbackDays} days')
    GROUP BY a.student_id, weekKey
    ORDER BY a.student_id, weekKey
  `).all(cohortId) as Array<{ studentId: string; email: string | null; weekKey: string; attempts: number; correct: number }>;

  const byStudent = aggregateIntoWeeks(
    sRows.map((r) => ({ ...r, key: r.studentId, meta: { email: r.email || '(unknown)' } })),
    weekList
  ).map((row) => {
    const { direction, deltaPct } = classifyDirection(row.weeklyData);
    return {
      studentId: row.key,
      email: row.meta.email,
      totalAttempts: row.totalAttempts,
      weeklyData: row.weeklyData,
      direction,
      deltaPct,
    };
  });

  return {
    cohortId,
    weeks,
    includeInstructor,
    byExercise,
    byQuestion,
    byStudent,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Given rows with weekKey + attempts + correct, and a canonical week list,
 * return entries with full weeklyData arrays (with zeros for missing weeks).
 */
function aggregateIntoWeeks<T extends { weekKey: string; attempts: number; correct: number; key: string; meta: any }>(
  rows: T[],
  weekList: string[]
): Array<{ key: string; meta: any; totalAttempts: number; weeklyData: TrendPoint[] }> {
  const grouped = new Map<string, { meta: any; weeks: Map<string, { attempts: number; correct: number }> }>();
  for (const r of rows) {
    if (!grouped.has(r.key)) grouped.set(r.key, { meta: r.meta, weeks: new Map() });
    grouped.get(r.key)!.weeks.set(r.weekKey, { attempts: r.attempts, correct: r.correct });
  }
  const out: Array<{ key: string; meta: any; totalAttempts: number; weeklyData: TrendPoint[] }> = [];
  for (const [key, g] of grouped.entries()) {
    const weeklyData: TrendPoint[] = weekList.map((w) => {
      const data = g.weeks.get(w);
      if (!data || data.attempts === 0) return { week: w, pctCorrect: 0, attempts: 0 };
      return { week: w, pctCorrect: Math.round((data.correct / data.attempts) * 1000) / 10, attempts: data.attempts };
    });
    const totalAttempts = weeklyData.reduce((sum, d) => sum + d.attempts, 0);
    out.push({ key, meta: g.meta, totalAttempts, weeklyData });
  }
  return out.sort((a, b) => b.totalAttempts - a.totalAttempts);
}



// ─────────────────────────────────────────────────────────────
// Phase 4.3: Cohort comparison analytics
// ─────────────────────────────────────────────────────────────

export interface ExerciseCohortSide {
  attempts: number;
  uniqueStudents: number;
  correctCount: number;
  totalCount: number;
  pctCorrect: number;
}

export interface ComparisonExercise {
  slug: string;
  title: string;
  exerciseType: string;
  a: ExerciseCohortSide | null;
  b: ExerciseCohortSide | null;
  delta: number | null;    // b.pct - a.pct
}

export interface ComparisonResult {
  cohortA: { id: string; name: string; studentCount: number };
  cohortB: { id: string; name: string; studentCount: number };
  exercises: ComparisonExercise[];
  generatedAt: string;
}

/**
 * Compare two cohorts' accuracy per exercise, side by side.
 * Exercise list is the union of both cohorts' exercises.
 */
export function getQuizComparison(cohortAId: string, cohortBId: string, days: number): ComparisonResult {
  const daysClause = days > 0 ? `AND a.created_at >= datetime('now', '-${days} days')` : '';

  // Metadata for both cohorts
  const cohortARow = sqlite.prepare('SELECT id, name FROM cohorts WHERE id = ?').get(cohortAId) as { id: string; name: string } | undefined;
  const cohortBRow = sqlite.prepare('SELECT id, name FROM cohorts WHERE id = ?').get(cohortBId) as { id: string; name: string } | undefined;
  if (!cohortARow || !cohortBRow) {
    throw new Error('One or both cohorts not found.');
  }
  const countA = (sqlite.prepare('SELECT COUNT(*) AS n FROM cohort_members WHERE cohort_id = ?').get(cohortAId) as { n: number }).n;
  const countB = (sqlite.prepare('SELECT COUNT(*) AS n FROM cohort_members WHERE cohort_id = ?').get(cohortBId) as { n: number }).n;

  // Union of exercise slugs across both cohorts
  const exRows = sqlite.prepare(`
    SELECT slug, title, exercise_type AS exerciseType, cohort_id AS cohortId
    FROM exercises
    WHERE cohort_id IN (?, ?)
  `).all(cohortAId, cohortBId) as Array<{ slug: string; title: string; exerciseType: string; cohortId: string }>;

  // Group by title (same title across cohorts = compared)
  const bySlug = new Map<string, { title: string; exerciseType: string; hasA: boolean; hasB: boolean }>();
  for (const r of exRows) {
    if (!bySlug.has(r.slug)) {
      bySlug.set(r.slug, { title: r.title, exerciseType: r.exerciseType, hasA: false, hasB: false });
    }
    if (r.cohortId === cohortAId) bySlug.get(r.slug)!.hasA = true;
    if (r.cohortId === cohortBId) bySlug.get(r.slug)!.hasB = true;
  }

  // Get stats per (cohort, slug)
  const statsFor = (cohortId: string, slug: string): ExerciseCohortSide | null => {
    const row = sqlite.prepare(`
      SELECT
        COUNT(*) AS attempts,
        COUNT(DISTINCT a.student_id) AS uniqueStudents,
        SUM(a.correct) AS correctCount,
        COUNT(a.id) AS totalCount
      FROM answers a
      JOIN exercises e ON e.slug = a.exercise_id
      WHERE e.cohort_id = ?
        AND a.exercise_id = ?
        ${daysClause}
    `).get(cohortId, slug) as { attempts: number; uniqueStudents: number; correctCount: number | null; totalCount: number } | undefined;
    if (!row || row.totalCount === 0) return null;
    return {
      attempts: row.attempts,
      uniqueStudents: row.uniqueStudents,
      correctCount: row.correctCount || 0,
      totalCount: row.totalCount,
      pctCorrect: row.totalCount > 0 ? Math.round(((row.correctCount || 0) / row.totalCount) * 1000) / 10 : 0,
    };
  };

  const exercises: ComparisonExercise[] = [];
  for (const [slug, meta] of bySlug.entries()) {
    const a = statsFor(cohortAId, slug);
    const b = statsFor(cohortBId, slug);
    const delta = (a && b) ? Math.round((b.pctCorrect - a.pctCorrect) * 10) / 10 : null;
    exercises.push({
      slug,
      title: meta.title,
      exerciseType: meta.exerciseType,
      a,
      b,
      delta,
    });
  }

  // Sort: exercises with both sides first, then by title
  exercises.sort((x, y) => {
    const bothX = x.a && x.b ? 1 : 0;
    const bothY = y.a && y.b ? 1 : 0;
    if (bothX !== bothY) return bothY - bothX;
    return x.title.localeCompare(y.title);
  });

  return {
    cohortA: { id: cohortARow.id, name: cohortARow.name, studentCount: countA },
    cohortB: { id: cohortBRow.id, name: cohortBRow.name, studentCount: countB },
    exercises,
    generatedAt: new Date().toISOString(),
  };
}

