/**
 * Cohort-level teaching opportunities.
 *
 * A rule engine over data we already collect. Each rule looks for a
 * signal across the cohort in a rolling time window. Signals are
 * classified by severity and returned sorted (high → medium → info),
 * top N.
 *
 * The goal is to answer: "What should the tutor focus on this week?"
 * — not to profile individual students.
 *
 * Every threshold is a named const so we can tune in one place.
 */

import { sqlite } from '../db.js';

const WINDOW_DAYS = 7;              // rolling window for "this week"
const PATTERN_MIN_STUDENTS = 3;      // rule 1: how many students = signal
const HINT_SPIKE_FACTOR = 1.4;       // rule 2: this week / last week
const HINT_SPIKE_MIN = 5;            // rule 2: ignore tiny numbers
const STALL_MIN_STUDENTS = 3;        // rule 3: exercises with N+ stalled
const REASONING_DROP_PCT = 20;       // rule 4: precise % delta (in pct pts)
const REASONING_MIN_SAMPLE = 4;      // rule 4: how many scored hypotheses
const POST_MORTEM_MIN_SAMPLE = 5;    // rule 5: how many scored PMs
const POST_MORTEM_MIN_STRONG_PCT = 30; // rule 5: below this, flag

export type OpportunityKind =
  | 'pattern'
  | 'hint-spike'
  | 'exercise-stall'
  | 'reasoning-dip'
  | 'post-mortem-quality'
  | 'untouched-exercises'
  | 'never-active'
  | 'no-post-mortems'
  | 'hint-heavy'
  | 'regressed';

export type OpportunitySeverity = 'high' | 'medium' | 'info';

export interface Opportunity {
  kind: OpportunityKind;
  severity: OpportunitySeverity;
  title: string;
  detail: string;
  count: number;
  // Optional navigation hints for the client
  exerciseId?: string;
  pattern?: string;
  // When set, the client renders the card as a clickable link to
  // GET /api/admin/students/filter?by=<by>&value=<value>.
  filter?: {
    by:
      | 'pattern'
      | 'exercise-stall'
      | 'low-post-mortems'
      | 'inactive'
      | 'never-active'
      | 'no-post-mortems'
      | 'hint-heavy'
      | 'regressed'
      | 'streak';
    value: string;
  };
}

export function getCohortOpportunities(cohortId: string): Opportunity[] {
  const opportunities: Opportunity[] = [];

  const exerciseRows = sqlite
    .prepare('SELECT slug FROM exercises WHERE cohort_id = ?')
    .all(cohortId) as Array<{ slug: string }>;
  const exerciseIds = exerciseRows.map((r) => r.slug);

  const studentRows = sqlite
    .prepare('SELECT user_id AS id FROM cohort_members WHERE cohort_id = ?')
    .all(cohortId) as Array<{ id: string }>;
  const studentIds = studentRows.map((r) => r.id);

  if (studentIds.length === 0 || exerciseIds.length === 0) return opportunities;

  const sPh = studentIds.map(() => '?').join(',');
  const ePh = exerciseIds.map(() => '?').join(',');

  // ── Rule 1: common weak pattern ─────────────────────────────────
  const patternRows = sqlite
    .prepare(
      `SELECT pattern, COUNT(DISTINCT student_id) AS students
       FROM mistake_patterns
       WHERE student_id IN (${sPh})
         AND exercise_id IN (${ePh})
         AND recorded_at >= datetime('now', '-${WINDOW_DAYS} days')
       GROUP BY pattern
       HAVING students >= ${PATTERN_MIN_STUDENTS}
       ORDER BY students DESC
       LIMIT 3`
    )
    .all(...studentIds, ...exerciseIds) as Array<{ pattern: string; students: number }>;

  for (const r of patternRows) {
    opportunities.push({
      kind: 'pattern',
      severity: 'high',
      title: r.students + ' students hit "' + r.pattern + '" this week',
      detail: 'Consider reviewing this pattern — it keeps coming up.',
      count: r.students,
      pattern: r.pattern,
      filter: { by: 'pattern', value: r.pattern },
    });
  }

  // ── Rule 2: hint dependency spike ───────────────────────────────
  const thisWeekHints = countHints(studentIds, exerciseIds, 0, WINDOW_DAYS);
  const lastWeekHints = countHints(studentIds, exerciseIds, WINDOW_DAYS, 2 * WINDOW_DAYS);
  if (
    thisWeekHints >= HINT_SPIKE_MIN &&
    lastWeekHints > 0 &&
    thisWeekHints / lastWeekHints >= HINT_SPIKE_FACTOR
  ) {
    const pct = Math.round(((thisWeekHints - lastWeekHints) / lastWeekHints) * 100);
    opportunities.push({
      kind: 'hint-spike',
      severity: 'medium',
      title: 'Hint usage up ' + pct + '% from last week',
      detail:
        thisWeekHints + ' hints served this week vs ' + lastWeekHints + ' last week. ' +
        'Students may be stuck on a specific concept.',
      count: thisWeekHints,
    });
  }

  // ── Rule 3: exercise stall ──────────────────────────────────────
  const stallRows = sqlite
    .prepare(
      `SELECT hs.exercise_id AS exerciseId,
              COUNT(DISTINCT hs.student_id) AS students,
              COALESCE(e.title, hs.exercise_id) AS title
       FROM hint_sessions hs
       LEFT JOIN exercises e ON e.id = hs.exercise_id OR e.slug = hs.exercise_id
       WHERE hs.student_id IN (${sPh})
         AND hs.exercise_id IN (${ePh})
         AND hs.state != 'complete'
         AND hs.created_at >= datetime('now', '-14 days')
       GROUP BY hs.exercise_id
       HAVING students >= ${STALL_MIN_STUDENTS}
       ORDER BY students DESC
       LIMIT 2`
    )
    .all(...studentIds, ...exerciseIds) as Array<{
      exerciseId: string;
      students: number;
      title: string;
    }>;

  for (const r of stallRows) {
    opportunities.push({
      kind: 'exercise-stall',
      severity: 'medium',
      title: r.students + ' students started "' + r.title + '" but not finished',
      detail: 'Consider a live walkthrough or extra time on this exercise.',
      count: r.students,
      exerciseId: r.exerciseId,
      filter: { by: 'exercise-stall', value: r.exerciseId },
    });
  }

  // ── Rule 4: reasoning quality dip ───────────────────────────────
  const thisWeek = reasoningPct(studentIds, exerciseIds, 0, WINDOW_DAYS);
  const lastWeek = reasoningPct(studentIds, exerciseIds, WINDOW_DAYS, 2 * WINDOW_DAYS);
  if (
    thisWeek.sample >= REASONING_MIN_SAMPLE &&
    lastWeek.sample >= REASONING_MIN_SAMPLE &&
    lastWeek.pct - thisWeek.pct >= REASONING_DROP_PCT
  ) {
    const drop = Math.round(lastWeek.pct - thisWeek.pct);
    opportunities.push({
      kind: 'reasoning-dip',
      severity: 'medium',
      title: 'Reasoning quality dropped ' + drop + ' points this week',
      detail:
        'Precise hypotheses went from ' + Math.round(lastWeek.pct) + '% to ' +
        Math.round(thisWeek.pct) + '%. Consider modeling good reasoning on a live example.',
      count: thisWeek.sample,
    });
  }

  // ── Rule 5: post-mortem quality ─────────────────────────────────
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

  if (pmRow && pmRow.total >= POST_MORTEM_MIN_SAMPLE) {
    const strongPct = (pmRow.strong / pmRow.total) * 100;
    if (strongPct < POST_MORTEM_MIN_STRONG_PCT) {
      opportunities.push({
        kind: 'post-mortem-quality',
        severity: 'medium',
        title: 'Only ' + Math.round(strongPct) + '% of post-mortems scored strong',
        detail:
          'Students may be describing symptoms rather than root causes. ' +
          'Consider a mini-lesson on writing post-mortems.',
        count: pmRow.total,
      });
    }
  }

  // ── Rule 6: untouched exercises ─────────────────────────────────
  const untouched = sqlite
    .prepare(
      `SELECT e.slug, e.title FROM exercises e
       WHERE e.cohort_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM hint_sessions hs
           WHERE hs.exercise_id = e.slug
             AND hs.student_id IN (${sPh})
         )`
    )
    .all(cohortId, ...studentIds) as Array<{ slug: string; title: string }>;

  if (untouched.length > 0) {
    const first = untouched[0];
    opportunities.push({
      kind: 'untouched-exercises',
      severity: 'info',
      title: untouched.length + ' exercise' + (untouched.length === 1 ? '' : 's') + ' untouched',
      detail: 'Including "' + first.title + '". Consider assigning one.',
      count: untouched.length,
      exerciseId: first.slug,
    });
  }

  // ── Rule 7: never-active students ───────────────────────────────
  const neverActiveRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM cohort_members cm
       WHERE cm.cohort_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM hint_sessions hs WHERE hs.student_id = cm.user_id
         )`
    )
    .get(cohortId) as { n: number };

  if (neverActiveRow.n > 0) {
    opportunities.push({
      kind: 'never-active',
      severity: 'info',
      title: neverActiveRow.n + ' student' + (neverActiveRow.n === 1 ? '' : 's') + ' never started',
      detail: 'Enrolled but no sessions yet. Consider a nudge or a check-in.',
      count: neverActiveRow.n,
      filter: { by: 'never-active', value: '' },
    });
  }

  // ── Rule 8: completed sessions but no post-mortem ───────────────
  const noPmRow = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT hs.student_id) AS n
       FROM hint_sessions hs
       WHERE hs.student_id IN (${sPh})
         AND hs.exercise_id IN (${ePh})
         AND hs.state = 'complete'
         AND hs.updated_at >= datetime('now', '-${WINDOW_DAYS} days')
         AND NOT EXISTS (
           SELECT 1 FROM post_mortems pm WHERE pm.session_id = hs.id
         )`
    )
    .get(...studentIds, ...exerciseIds) as { n: number };

  if (noPmRow.n > 0) {
    opportunities.push({
      kind: 'no-post-mortems',
      severity: 'info',
      title: noPmRow.n + ' student' + (noPmRow.n === 1 ? '' : 's') + ' finished without a post-mortem',
      detail: 'They completed sessions this week but wrote no reflection.',
      count: noPmRow.n,
      filter: { by: 'no-post-mortems', value: '' },
    });
  }

  // ── Rule 9: hint-heavy students ─────────────────────────────────
  const HINT_HEAVY_THRESHOLD = 2;
  const heavyRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT t.student_id,
                COUNT(*) * 1.0 / NULLIF((
                  SELECT COUNT(*) FROM hint_sessions hs2
                  WHERE hs2.student_id = t.student_id
                    AND hs2.exercise_id IN (${ePh})
                    AND hs2.updated_at >= datetime('now', '-${WINDOW_DAYS} days')
                ), 0) AS avg_hints
         FROM telemetry t
         WHERE t.type = 'hint-served'
           AND t.student_id IN (${sPh})
           AND t.exercise_id IN (${ePh})
           AND t.recorded_at >= datetime('now', '-${WINDOW_DAYS} days')
         GROUP BY t.student_id
       ) WHERE avg_hints > ${HINT_HEAVY_THRESHOLD}`
    )
    .get(...exerciseIds, ...studentIds, ...exerciseIds) as { n: number };

  if (heavyRow.n > 0) {
    opportunities.push({
      kind: 'hint-heavy',
      severity: 'medium',
      title: heavyRow.n + ' student' + (heavyRow.n === 1 ? '' : 's') + ' leaning on hints',
      detail: 'Averaging more than ' + HINT_HEAVY_THRESHOLD + ' hints per session this week.',
      count: heavyRow.n,
      filter: { by: 'hint-heavy', value: String(HINT_HEAVY_THRESHOLD) },
    });
  }

  // ── Rule 10: reasoning regression (per-student count) ───────────
  const regressedRow = sqlite
    .prepare(
      `WITH this_week AS (
         SELECT student_id,
                COUNT(*) AS total,
                SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
         FROM hypotheses
         WHERE student_id IN (${sPh})
           AND exercise_id IN (${ePh})
           AND quality IS NOT NULL
           AND recorded_at >= datetime('now', '-${WINDOW_DAYS} days')
         GROUP BY student_id
       ),
       last_week AS (
         SELECT student_id,
                COUNT(*) AS total,
                SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
         FROM hypotheses
         WHERE student_id IN (${sPh})
           AND exercise_id IN (${ePh})
           AND quality IS NOT NULL
           AND recorded_at >= datetime('now', '-${2 * WINDOW_DAYS} days')
           AND recorded_at <  datetime('now', '-${WINDOW_DAYS} days')
         GROUP BY student_id
       )
       SELECT COUNT(*) AS n
       FROM this_week tw
       JOIN last_week lw ON lw.student_id = tw.student_id
       WHERE tw.total >= ${REASONING_MIN_SAMPLE}
         AND lw.total >= ${REASONING_MIN_SAMPLE}
         AND (lw.precise * 100.0 / lw.total) - (tw.precise * 100.0 / tw.total) >= ${REASONING_DROP_PCT}`
    )
    .get(...studentIds, ...exerciseIds, ...studentIds, ...exerciseIds) as { n: number };

  if (regressedRow.n > 0) {
    opportunities.push({
      kind: 'regressed',
      severity: 'medium',
      title: regressedRow.n + ' student' + (regressedRow.n === 1 ? '' : 's') + ' slipped in reasoning',
      detail: 'Precise-hypothesis rate dropped 20+ points vs last week.',
      count: regressedRow.n,
      filter: { by: 'regressed', value: '' },
    });
  }

  // ── Sort: high → medium → info; then by count desc ──────────────
  const order = { high: 0, medium: 1, info: 2 };
  opportunities.sort((a, b) => {
    const s = order[a.severity] - order[b.severity];
    if (s !== 0) return s;
    return b.count - a.count;
  });

  return opportunities.slice(0, 5);
}

// ── helpers ─────────────────────────────────────────────────────────

function countHints(
  studentIds: string[],
  exerciseIds: string[],
  daysAgoStart: number,
  daysAgoEnd: number
): number {
  const sPh = studentIds.map(() => '?').join(',');
  const ePh = exerciseIds.map(() => '?').join(',');
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry
       WHERE type = 'hint-served'
         AND student_id IN (${sPh})
         AND exercise_id IN (${ePh})
         AND recorded_at >= datetime('now', '-${daysAgoEnd} days')
         AND recorded_at <  datetime('now', '-${daysAgoStart} days')`
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
