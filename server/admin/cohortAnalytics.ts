/**
 * Cohort-level analytics — bird's-eye dashboard of a single cohort.
 *
 * Aggregates:
 *   - Summary metrics: avg reasoning %, median progress %, avg hints/session,
 *     total sessions
 *   - Status breakdown (using the same derivation as the roster, escalated
 *     by the per-student trend classification so we don't miss slipping
 *     students whose raw stats look fine)
 *   - 12-week weekly trends: reasoning quality (precise / total) and
 *     completed sessions per week
 *
 * The heavy work (detailFor per student) is acceptable for the small
 * cohorts this app supports. If it becomes slow, add a 60-second cache.
 */

import { sqlite, db } from '../db.js';
import { deriveRosterStatus, escalateWithTrends } from '../util/status.js';
import { fillWeeks, lastNWeekStarts } from '../util/weeks.js';
import { getCohortOpportunities, type Opportunity } from './cohortOpportunities.js';
import { getCohortHighlights, type Highlight } from './cohortHighlights.js';

export interface TrendPoint {
  weekStart: string;
  value: number | null;
  sample: number;
}

export interface CohortAnalytics {
  cohortId: string;
  cohortName: string;
  studentCount: number;
  exerciseCount: number;

  summary: {
    avgReasoningPct: number | null;
    medianProgressPct: number | null;
    avgHintsPerSession: number | null;
    totalSessions: number;
  };

  statusBreakdown: {
    new: number;
    onTrack: number;
    slipping: number;
    atRisk: number;
  };

  weeklyTrends: {
    reasoningQuality: TrendPoint[];
    sessions: TrendPoint[];
  };

  /** Ranked teaching opportunities — see cohortOpportunities.ts. */
  opportunities: Opportunity[];

  /** Positive highlights — see cohortHighlights.ts. */
  highlights: Highlight[];
}

function median(values: number[]): number | null {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

export function getCohortAnalytics(cohortId: string): CohortAnalytics {
  // 1. Resolve cohort
  const cohort = sqlite
    .prepare('SELECT id, name FROM cohorts WHERE id = ?')
    .get(cohortId) as { id: string; name: string } | undefined;
  if (!cohort) {
    throw new Error('Cohort not found.');
  }

  // 2. Exercises for this cohort (by slug — matches how hint_sessions etc
  //    store exercise_id)
  const exerciseRows = sqlite
    .prepare('SELECT slug FROM exercises WHERE cohort_id = ?')
    .all(cohortId) as Array<{ slug: string }>;
  const exerciseIds = exerciseRows.map((r) => r.slug);

  // 3. Students in this cohort
  const studentRows = sqlite
    .prepare('SELECT user_id AS id FROM cohort_members WHERE cohort_id = ?')
    .all(cohortId) as Array<{ id: string }>;
  const studentIds = studentRows.map((r) => r.id);

  // 4. Per-student aggregates + status
  const statusCounts = { new: 0, onTrack: 0, slipping: 0, atRisk: 0 };
  const progressPcts: number[] = [];
  let totalPrecise = 0;
  let totalScoredHypotheses = 0;
  let totalHints = 0;
  let totalSessions = 0;

  for (const studentId of studentIds) {
    const stats = db.students.statsFor(studentId, exerciseIds);
    const rosterStatus = deriveRosterStatus({
      exercisesAttempted: stats.exercisesAttempted,
      exercisesCompleted: stats.exercisesCompleted,
      lastActiveAt: stats.lastActiveAt,
    });

    // Trend escalation — detailFor gives us .trends for the classifier
    let finalStatus = rosterStatus.status;
    try {
      const detail = db.students.detailFor(studentId, exerciseIds);
      const escalated = escalateWithTrends(rosterStatus, detail.trends);
      finalStatus = escalated.status;
    } catch {
      // detailFor may fail on edge cases — fall back to roster status
    }

    if (finalStatus === 'new') statusCounts.new++;
    else if (finalStatus === 'on-track') statusCounts.onTrack++;
    else if (finalStatus === 'slipping') statusCounts.slipping++;
    else if (finalStatus === 'at-risk') statusCounts.atRisk++;

    // Progress percentage
    if (exerciseIds.length > 0) {
      const pct = (stats.exercisesCompleted / exerciseIds.length) * 100;
      progressPcts.push(pct);
    }

    // Reasoning + hints + sessions
    const detail = db.students.detailFor(studentId, exerciseIds);
    const rq = detail.metrics.reasoningQuality;
    totalPrecise += rq.precise;
    totalScoredHypotheses += rq.precise + rq.plausible + rq.vague;

    const hd = detail.metrics.hintDependency;
    totalHints += hd.totalHints;
    totalSessions += hd.sessions;
  }

  const avgReasoningPct = totalScoredHypotheses > 0
    ? Math.round((totalPrecise / totalScoredHypotheses) * 100)
    : null;

  const medianProgressPct = median(progressPcts);

  const avgHintsPerSession = totalSessions > 0
    ? totalHints / totalSessions
    : null;

  // 5. Weekly trends — aggregate across all students in the cohort
  const weekStarts = lastNWeekStarts(12);
  const weeklyTrends = {
    reasoningQuality: fillWeeks(cohortReasoningTrendFor(cohortId, exerciseIds), weekStarts),
    sessions: fillWeeks(cohortSessionsTrendFor(cohortId, exerciseIds), weekStarts),
  };

  const opportunities = getCohortOpportunities(cohortId);
  const highlights = getCohortHighlights(cohortId);

  return {
    cohortId: cohort.id,
    cohortName: cohort.name,
    studentCount: studentIds.length,
    exerciseCount: exerciseIds.length,
    summary: {
      avgReasoningPct,
      medianProgressPct,
      avgHintsPerSession,
      totalSessions,
    },
    statusBreakdown: statusCounts,
    weeklyTrends,
    opportunities,
    highlights,
  };
}

/**
 * Reasoning quality per week across the whole cohort: value = precise / total.
 */
function cohortReasoningTrendFor(
  cohortId: string,
  exerciseIds: string[]
): Array<{ week_start: string; value: number | null; sample: number }> {
  if (exerciseIds.length === 0) return [];
  const placeholders = exerciseIds.map(() => '?').join(',');
  const since = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const rows = sqlite
    .prepare(
      `SELECT
         date(recorded_at, 'weekday 1', '-7 days') AS week_start,
         COUNT(*) AS total,
         SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
       FROM hypotheses
       WHERE student_id IN (SELECT user_id FROM cohort_members WHERE cohort_id = ?)
         AND exercise_id IN (${placeholders})
         AND quality IS NOT NULL
         AND recorded_at >= ?
       GROUP BY week_start
       ORDER BY week_start`
    )
    .all(cohortId, ...exerciseIds, since) as Array<{
      week_start: string;
      total: number;
      precise: number;
    }>;

  return rows.map((r) => ({
    week_start: r.week_start,
    value: r.total > 0 ? r.precise / r.total : null,
    sample: r.total,
  }));
}

/**
 * Completed sessions per week across the cohort.
 */
function cohortSessionsTrendFor(
  cohortId: string,
  exerciseIds: string[]
): Array<{ week_start: string; value: number | null; sample: number }> {
  if (exerciseIds.length === 0) return [];
  const placeholders = exerciseIds.map(() => '?').join(',');
  const since = new Date(Date.now() - 12 * 7 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const rows = sqlite
    .prepare(
      `SELECT
         date(created_at, 'weekday 1', '-7 days') AS week_start,
         COUNT(*) AS sessions
       FROM hint_sessions
       WHERE student_id IN (SELECT user_id FROM cohort_members WHERE cohort_id = ?)
         AND exercise_id IN (${placeholders})
         AND state = 'complete'
         AND created_at >= ?
       GROUP BY week_start
       ORDER BY week_start`
    )
    .all(cohortId, ...exerciseIds, since) as Array<{
      week_start: string;
      sessions: number;
    }>;

  return rows.map((r) => ({
    week_start: r.week_start,
    value: r.sessions,
    sample: r.sessions,
  }));
}
