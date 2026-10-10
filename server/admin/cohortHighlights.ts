/**
 * Cohort-level positive highlights.
 *
 * Mirror of cohortOpportunities.ts, but for good news: what went
 * well this week? Used by the Analytics tab's Highlights panel.
 *
 * Rules are cheap aggregate queries — no per-student loops.
 */

import { sqlite, db } from '../db.js';

const WINDOW_DAYS = 7;
const PM_STRONG_MIN = 2;
const PM_STRONG_PCT = 60;
const BEST_WEEK_FACTOR = 1.2;
const REASONING_IMPROVE_PCT = 20;
const REASONING_MIN_SAMPLE = 4;
const STREAK_MIN_DAYS = 5;

export interface Highlight {
  kind: 'pm-strong' | 'best-week' | 'reasoning-improved' | 'streak-milestone';
  title: string;
  detail: string;
  count: number;
}

export function getCohortHighlights(cohortId: string): Highlight[] {
  const out: Highlight[] = [];

  const exerciseRows = sqlite
    .prepare('SELECT slug FROM exercises WHERE cohort_id = ?')
    .all(cohortId) as Array<{ slug: string }>;
  const exerciseIds = exerciseRows.map((r) => r.slug);

  const studentRows = sqlite
    .prepare('SELECT user_id AS id FROM cohort_members WHERE cohort_id = ?')
    .all(cohortId) as Array<{ id: string }>;
  const studentIds = studentRows.map((r) => r.id);

  if (studentIds.length === 0 || exerciseIds.length === 0) return out;

  const sPh = studentIds.map(() => '?').join(',');
  const ePh = exerciseIds.map(() => '?').join(',');

  // ── Rule 1: strong post-mortems ─────────────────────────────────
  const pmRow = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN score = 'strong' THEN 1 ELSE 0 END) AS strong
       FROM post_mortems
       WHERE student_id IN (${sPh})
         AND exercise_id IN (${ePh})
         AND recorded_at >= datetime('now', '-${WINDOW_DAYS} days')`
    )
    .get(...studentIds, ...exerciseIds) as { total: number; strong: number };

  if (pmRow && pmRow.total >= 2 && pmRow.strong >= PM_STRONG_MIN) {
    const pct = Math.round((pmRow.strong / pmRow.total) * 100);
    if (pct >= PM_STRONG_PCT) {
      out.push({
        kind: 'pm-strong',
        title: pmRow.strong + ' strong post-mortem' + (pmRow.strong === 1 ? '' : 's') + ' this week',
        detail: Math.round(pct) + '% of this week\'s post-mortems scored strong.',
        count: pmRow.strong,
      });
    }
  }

  // ── Rule 2: best week for completions ───────────────────────────
  // Compare this week's completions against the max of the previous
  // three weeks.
  const sessionsThisWeek = countCompletions(studentIds, exerciseIds, 0, WINDOW_DAYS);
  const prevWeeks = [
    countCompletions(studentIds, exerciseIds, WINDOW_DAYS, 2 * WINDOW_DAYS),
    countCompletions(studentIds, exerciseIds, 2 * WINDOW_DAYS, 3 * WINDOW_DAYS),
    countCompletions(studentIds, exerciseIds, 3 * WINDOW_DAYS, 4 * WINDOW_DAYS),
  ];
  const maxPrior = Math.max(...prevWeeks, 0);
  if (
    sessionsThisWeek >= 3 &&
    sessionsThisWeek > maxPrior * BEST_WEEK_FACTOR
  ) {
    out.push({
      kind: 'best-week',
      title: 'Best week for completions in a month',
      detail:
        sessionsThisWeek + ' sessions completed this week' +
        (maxPrior > 0 ? ' (previous best was ' + maxPrior + ').' : '.'),
      count: sessionsThisWeek,
    });
  }

  // ── Rule 3: reasoning improved ──────────────────────────────────
  const thisWeek = reasoningPct(studentIds, exerciseIds, 0, WINDOW_DAYS);
  const lastWeek = reasoningPct(studentIds, exerciseIds, WINDOW_DAYS, 2 * WINDOW_DAYS);
  if (
    thisWeek.sample >= REASONING_MIN_SAMPLE &&
    lastWeek.sample >= REASONING_MIN_SAMPLE &&
    thisWeek.pct - lastWeek.pct >= REASONING_IMPROVE_PCT
  ) {
    const gain = Math.round(thisWeek.pct - lastWeek.pct);
    out.push({
      kind: 'reasoning-improved',
      title: 'Reasoning improved ' + gain + ' points this week',
      detail:
        'Precise hypotheses went from ' + Math.round(lastWeek.pct) + '% to ' +
        Math.round(thisWeek.pct) + '%.',
      count: thisWeek.sample,
    });
  }

  // ── Rule 4: streak milestone ────────────────────────────────────
  // A student with a 5+ day streak means they have activity on each
  // of the last N UTC days. db.students.activityForMany computes the
  // current + longest streaks per student over a 30-day window.
  try {
    const activityMap = db.students.activityForMany(studentIds, exerciseIds, 30);
    let count = 0;
    for (const sid of studentIds) {
      const act = activityMap.get(sid);
      if (act && act.currentStreak >= STREAK_MIN_DAYS) count++;
    }
    if (count > 0) {
      out.push({
        kind: 'streak-milestone',
        title: count + ' student' + (count === 1 ? '' : 's') + ' on a ' + STREAK_MIN_DAYS + '+ day streak',
        detail: 'Consistent practice is paying off.',
        count,
      });
    }
  } catch {
    // activityForMany unavailable — skip this rule
  }

  // Sort by count desc (the biggest positive signals first)
  out.sort((a, b) => b.count - a.count);
  return out.slice(0, 4);
}

// ── helpers ─────────────────────────────────────────────────────────

function countCompletions(
  studentIds: string[],
  exerciseIds: string[],
  daysAgoStart: number,
  daysAgoEnd: number
): number {
  const sPh = studentIds.map(() => '?').join(',');
  const ePh = exerciseIds.map(() => '?').join(',');
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM hint_sessions
       WHERE state = 'complete'
         AND student_id IN (${sPh})
         AND exercise_id IN (${ePh})
         AND updated_at >= datetime('now', '-${daysAgoEnd} days')
         AND updated_at <  datetime('now', '-${daysAgoStart} days')`
    )
    .get(...studentIds, ...exerciseIds) as { n: number };
  return row?.n ?? 0;
}

function reasoningPct(
  studentIds: string[],
  exerciseIds: string[],
  daysAgoStart: number,
  daysAgoEnd: number
): { pct: number; sample: number } {
  const sPh = studentIds.map(() => '?').join(',');
  const ePh = exerciseIds.map(() => '?').join(',');
  const row = sqlite
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
       FROM hypotheses
       WHERE student_id IN (${sPh})
         AND exercise_id IN (${ePh})
         AND quality IS NOT NULL
         AND recorded_at >= datetime('now', '-${daysAgoEnd} days')
         AND recorded_at <  datetime('now', '-${daysAgoStart} days')`
    )
    .get(...studentIds, ...exerciseIds) as { total: number; precise: number };
  const total = row?.total ?? 0;
  const precise = row?.precise ?? 0;
  return {
    pct: total > 0 ? (precise / total) * 100 : 0,
    sample: total,
  };
}
