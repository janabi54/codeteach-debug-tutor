import express from 'express';
import { db, sqlite } from '../db.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import {
  rosterFor,
  viewableExerciseIdsFor,
  viewableExercisesFor,
  cohortPeersFor,
  canInstructorViewStudentOnExercise,
} from '../auth/authorization.js';
import { median, type CohortComparison } from '../util/cohortComparison.js';
import { deriveNextAction } from '../util/nextAction.js';
import { deriveRosterStatus, escalateWithTrends } from '../util/status.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students
// Roster: every student in any cohort the instructor teaches,
// with summary stats scoped to the instructor's exercises.
// ─────────────────────────────────────────────────────────────
router.get('/', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const roster = rosterFor(instructorId);

  // Deduplicate: a student in two of this instructor's cohorts
  // appears once. (Their work in both cohorts is still visible.)
  const byStudent = new Map<string, {
    studentId: string;
    cohortIds: Set<string>;
    cohortNames: Set<string>;
    joinedAt: string;
  }>();

  for (const entry of roster) {
    if (!byStudent.has(entry.studentId)) {
      byStudent.set(entry.studentId, {
        studentId: entry.studentId,
        cohortIds: new Set(),
        cohortNames: new Set(),
        joinedAt: entry.joinedAt,
      });
    }
    const s = byStudent.get(entry.studentId)!;
    s.cohortIds.add(entry.cohortId);
    s.cohortNames.add(entry.cohortName);
    // Keep the earliest joined date
    if (entry.joinedAt < s.joinedAt) s.joinedAt = entry.joinedAt;
  }

  // Batch: compute activity for all students in one go
  const studentIds = Array.from(byStudent.keys());
  const allExercisesByStudent = new Map<string, string[]>();
  for (const sid of studentIds) {
    allExercisesByStudent.set(sid, viewableExerciseIdsFor(instructorId, sid));
  }
  // Union of all exercises across students — used as the IN list. Since a
  // student only counts events on their own viewable exercises, having a
  // shared exercise set here is fine (extra IDs on the list are harmless).
  const allExercises = Array.from(new Set(
    Array.from(allExercisesByStudent.values()).flat()
  ));
  const activityMap = db.students.activityForMany(studentIds, allExercises, 30);

  const students = [];
  for (const s of byStudent.values()) {
    const user = await db.users.findById(s.studentId);
    if (!user) continue;

    const exerciseIds = viewableExerciseIdsFor(instructorId, s.studentId);
    if (exerciseIds.length === 0) continue;

    const placeholders = exerciseIds.map(() => '?').join(',');
    const stats = db.students.statsFor(s.studentId, exerciseIds);

    students.push({
      studentId: s.studentId,
      displayName: user.displayName,
      email: user.email,
      cohortNames: Array.from(s.cohortNames),
      cohortIds: Array.from(s.cohortIds),
      joinedAt: s.joinedAt,
      exercisesAttempted: stats.exercisesAttempted,
      exercisesCompleted: stats.exercisesCompleted,
      lastActiveAt: stats.lastActiveAt,
      ...(() => {
        const r = deriveRosterStatus({
          exercisesAttempted: stats.exercisesAttempted,
          exercisesCompleted: stats.exercisesCompleted,
          lastActiveAt: stats.lastActiveAt,
        });
        return { status: r.status, statusReasons: r.reasons };
      })(),
      assigned: exerciseIds.length,
      activity30d: activityMap.get(s.studentId) || null,
    });
  }

  // Sort: recently active first, then by name
  students.sort((a, b) => {
    const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.displayName.localeCompare(b.displayName);
  });

  res.json(students);
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/filter?by=<type>&value=<value>
// Returns a roster-shaped list of students matching a given filter.
// Used by the Analytics tab's teaching-opportunities links.
// Registered BEFORE /:studentId so Express doesn't route 'filter'
// as a student ID.
// ─────────────────────────────────────────────────────────────
const FILTER_TYPES = new Set([
  'pattern',
  'exercise-stall',
  'low-post-mortems',
  'inactive',
]);

router.get('/filter', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const by = String(req.query.by ?? '').trim();
  const value = String(req.query.value ?? '').trim();

  if (!FILTER_TYPES.has(by)) {
    return res.status(400).json({ error: 'Unknown filter type.' });
  }
  if (!value) {
    return res.status(400).json({ error: 'Filter value is required.' });
  }

  // Which cohort students is this instructor allowed to see?
  const roster = rosterFor(instructorId);
  const allowedStudentIds = Array.from(new Set(roster.map((r) => r.studentId)));
  if (allowedStudentIds.length === 0) {
    return res.json({
      filter: { by, value, label: filterLabel(by, value) },
      students: [],
    });
  }

  // Query the matching students for this filter
  const matchingIds = getFilteredStudentIds(by, value, allowedStudentIds);
  if (matchingIds.length === 0) {
    return res.json({
      filter: { by, value, label: filterLabel(by, value) },
      students: [],
    });
  }

  // Build roster rows for the matching students, reusing the same
  // shape and derivation the roster view uses.
  const matchingSet = new Set(matchingIds);
  const byStudent = new Map<string, {
    studentId: string;
    cohortIds: Set<string>;
    cohortNames: Set<string>;
    joinedAt: string;
  }>();
  for (const entry of roster) {
    if (!matchingSet.has(entry.studentId)) continue;
    if (!byStudent.has(entry.studentId)) {
      byStudent.set(entry.studentId, {
        studentId: entry.studentId,
        cohortIds: new Set(),
        cohortNames: new Set(),
        joinedAt: entry.joinedAt,
      });
    }
    const s = byStudent.get(entry.studentId)!;
    s.cohortIds.add(entry.cohortId);
    s.cohortNames.add(entry.cohortName);
    if (entry.joinedAt < s.joinedAt) s.joinedAt = entry.joinedAt;
  }

  // Batch activity for these students
  const studentIds = Array.from(byStudent.keys());
  const allExercises = Array.from(new Set(
    studentIds.flatMap((sid) => viewableExerciseIdsFor(instructorId, sid))
  ));
  const activityMap = db.students.activityForMany(studentIds, allExercises, 30);

  const students = [];
  for (const s of byStudent.values()) {
    const user = await db.users.findById(s.studentId);
    if (!user) continue;
    const exerciseIds = viewableExerciseIdsFor(instructorId, s.studentId);
    if (exerciseIds.length === 0) continue;

    const stats = db.students.statsFor(s.studentId, exerciseIds);
    const statusResult = deriveRosterStatus({
      exercisesAttempted: stats.exercisesAttempted,
      exercisesCompleted: stats.exercisesCompleted,
      lastActiveAt: stats.lastActiveAt,
    });

    students.push({
      studentId: s.studentId,
      displayName: user.displayName,
      email: user.email,
      cohortNames: Array.from(s.cohortNames),
      cohortIds: Array.from(s.cohortIds),
      joinedAt: s.joinedAt,
      exercisesAttempted: stats.exercisesAttempted,
      exercisesCompleted: stats.exercisesCompleted,
      lastActiveAt: stats.lastActiveAt,
      status: statusResult.status,
      statusReasons: statusResult.reasons,
      assigned: exerciseIds.length,
      activity30d: activityMap.get(s.studentId) || null,
    });
  }

  students.sort((a, b) => {
    const aTime = a.lastActiveAt ? new Date(a.lastActiveAt).getTime() : 0;
    const bTime = b.lastActiveAt ? new Date(b.lastActiveAt).getTime() : 0;
    if (aTime !== bTime) return bTime - aTime;
    return a.displayName.localeCompare(b.displayName);
  });

  res.json({
    filter: { by, value, label: filterLabel(by, value) },
    students,
  });
});

/**
 * Human-readable label for a filter, shown as the page title.
 */
function filterLabel(by: string, value: string): string {
  switch (by) {
    case 'pattern':         return 'Students who hit "' + value + '" this week';
    case 'exercise-stall':  return 'Students stalled on "' + value + '"';
    case 'low-post-mortems':return 'Students with weak post-mortems this week';
    case 'inactive':        return 'Students with no activity in 10+ days';
    default:                return 'Filtered students';
  }
}

/**
 * Resolve a filter to a list of matching student IDs, scoped to the
 * instructor's allowed students.
 */
function getFilteredStudentIds(
  by: string,
  value: string,
  allowedStudentIds: string[]
): string[] {
  if (allowedStudentIds.length === 0) return [];
  const sPh = allowedStudentIds.map(() => '?').join(',');

  if (by === 'pattern') {
    return (sqlite
      .prepare(
        `SELECT DISTINCT student_id AS id FROM mistake_patterns
         WHERE student_id IN (${sPh})
           AND pattern = ?
           AND recorded_at >= datetime('now','-7 days')`
      )
      .all(...allowedStudentIds, value) as Array<{ id: string }>).map((r) => r.id);
  }

  if (by === 'exercise-stall') {
    return (sqlite
      .prepare(
        `SELECT DISTINCT student_id AS id FROM hint_sessions
         WHERE student_id IN (${sPh})
           AND exercise_id = ?
           AND state != 'complete'`
      )
      .all(...allowedStudentIds, value) as Array<{ id: string }>).map((r) => r.id);
  }

  if (by === 'low-post-mortems') {
    return (sqlite
      .prepare(
        `SELECT DISTINCT student_id AS id FROM post_mortems
         WHERE student_id IN (${sPh})
           AND recorded_at >= datetime('now','-7 days')
           AND (score IS NULL OR score != 'strong')`
      )
      .all(...allowedStudentIds) as Array<{ id: string }>).map((r) => r.id);
  }

  if (by === 'inactive') {
    return (sqlite
      .prepare(
        `SELECT student_id AS id FROM (
           SELECT hs.student_id, MAX(hs.updated_at) AS last_active
           FROM hint_sessions hs
           WHERE hs.student_id IN (${sPh})
           GROUP BY hs.student_id
         )
         WHERE last_active < datetime('now','-10 days')`
      )
      .all(...allowedStudentIds) as Array<{ id: string }>).map((r) => r.id);
  }

  return [];
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/export.csv
// Download a CSV of the instructor's roster. Registered BEFORE
// /:studentId so Express doesn't treat "export.csv" as an id.
// ─────────────────────────────────────────────────────────────
router.get('/export.csv', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const days = Number(req.query.days ?? 30) || 30;

  const roster = rosterFor(instructorId);
  const byStudent = new Map<string, {
    studentId: string;
    cohortNames: Set<string>;
    joinedAt: string;
  }>();
  for (const entry of roster) {
    if (!byStudent.has(entry.studentId)) {
      byStudent.set(entry.studentId, {
        studentId: entry.studentId,
        cohortNames: new Set(),
        joinedAt: entry.joinedAt,
      });
    }
    const s = byStudent.get(entry.studentId)!;
    s.cohortNames.add(entry.cohortName);
    if (entry.joinedAt < s.joinedAt) s.joinedAt = entry.joinedAt;
  }

  const studentIds = Array.from(byStudent.keys());
  const allExercises = Array.from(new Set(
    studentIds.flatMap((sid) => viewableExerciseIdsFor(instructorId, sid))
  ));
  const activityMap = db.students.activityForMany(studentIds, allExercises, days);

  const rows: string[][] = [];
  rows.push([
    'Name', 'Email', 'Classes', 'Status', 'Reasons',
    'Attempted', 'Completed', 'Assigned', 'Progress %',
    'Time (min)', 'Last active', 'Streak (days)',
  ]);

  for (const s of byStudent.values()) {
    const user = await db.users.findById(s.studentId);
    if (!user) continue;

    const exerciseIds = viewableExerciseIdsFor(instructorId, s.studentId);
    if (exerciseIds.length === 0) continue;

    const stats = db.students.statsFor(s.studentId, exerciseIds);
    const rosterStatus = deriveRosterStatus({
      exercisesAttempted: stats.exercisesAttempted,
      exercisesCompleted: stats.exercisesCompleted,
      lastActiveAt: stats.lastActiveAt,
    });

    const detail = db.students.detailFor(s.studentId, exerciseIds);

    const assigned = exerciseIds.length;
    const completedSlugs = new Set(
      detail.sessionHistory.filter((r) => r.state === 'complete').map((r) => r.exerciseId)
    );
    const completed = exerciseIds.filter((slug) => completedSlugs.has(slug)).length;
    const progressPct = assigned > 0 ? Math.round((completed / assigned) * 100) : 0;

    const totalTime = detail.timeMetrics.totalStruggleMinutes;
    const act = activityMap.get(s.studentId);
    const streak = act ? act.currentStreak : 0;

    rows.push([
      user.displayName,
      user.email,
      Array.from(s.cohortNames).join('; '),
      rosterStatus.status,
      rosterStatus.reasons.join('; '),
      String(stats.exercisesAttempted),
      String(completed),
      String(assigned),
      String(progressPct),
      String(totalTime),
      stats.lastActiveAt ?? '',
      String(streak),
    ]);
  }

  const csv = rows
    .map((row) =>
      row
        .map((cell) => '"' + String(cell).replace(/"/g, '""') + '"')
        .join(',')
    )
    .join('\r\n');

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="students-' + stamp + '.csv"');
  res.send('\uFEFF' + csv);
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId
// Full detail for one student, scoped to the instructor's cohorts.
// ─────────────────────────────────────────────────────────────
router.get('/:studentId', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId } = req.params;

  const user = await db.users.findById(studentId);
  if (!user) return res.status(404).json({ error: 'Student not found.' });

  const exerciseIds = viewableExerciseIdsFor(instructorId, studentId);
  if (exerciseIds.length === 0) {
    return res.status(403).json({ error: 'You do not teach this student.' });
  }

  const detail = db.students.detailFor(studentId, exerciseIds);
  const stats = db.students.statsFor(studentId, exerciseIds);

  const rosterStatus = deriveRosterStatus({
    exercisesAttempted: stats.exercisesAttempted,
    exercisesCompleted: stats.exercisesCompleted,
    lastActiveAt: stats.lastActiveAt,
  });
  const statusResult = escalateWithTrends(rosterStatus, detail.trends);

  const viewableExercises = viewableExercisesFor(instructorId, studentId);
  const nextAction = deriveNextAction({
    status: statusResult.status,
    statusReasons: statusResult.reasons,
    studentName: user.displayName,
    viewableExercises,
    sessionHistory: detail.sessionHistory,
    weakSpots: detail.weakSpots,
  });

  // Progress: completed / assigned (assigned = count of viewable exercises)
  const completedSlugs = new Set(
    detail.sessionHistory
      .filter((s) => s.state === 'complete')
      .map((s) => s.exerciseId)
  );
  const assigned = viewableExercises.length;
  const completed = viewableExercises.filter((e) => completedSlugs.has(e.slug)).length;
  const progress = {
    completed,
    assigned,
    percent: assigned > 0 ? completed / assigned : 0,
  };

  // Activity heatmap (90 days)
  const activityMap = db.students.activityForMany([studentId], exerciseIds, 90);
  const activity = activityMap.get(studentId) || null;

  // Cohort comparison: same-cohort peers only
  const { peerIds, cohortNames } = cohortPeersFor(instructorId, studentId);
  let cohortComparison: CohortComparison | null = null;
  // Build the comparison whenever the student is in a shared cohort —
  // even when peerCount is 0 the client shows a "not enough peers"
  // note instead of hiding the whole panel.
  if (cohortNames.length > 0) {
    const peerRows = peerIds.length > 0
      ? db.students.cohortPeerMetricsFor(peerIds, exerciseIds)
      : [];

    const reasoningValues = peerRows
      .map((r) => r.reasoningQuality)
      .filter((v): v is number => v !== null);
    const hintValues = peerRows
      .map((r) => r.hintDependency)
      .filter((v): v is number => v !== null);
    const progressValues = peerRows
      .map((r) => r.progress)
      .filter((v): v is number => v !== null);

    cohortComparison = {
      cohortNames,
      peerCount: peerRows.length,
      metrics: {
        reasoningQuality: {
          student: detail.metrics.reasoningQuality.total > 0
            ? detail.metrics.reasoningQuality.precise / detail.metrics.reasoningQuality.total
            : null,
          median: median(reasoningValues),
          higherIsBetter: true,
          unit: '% precise',
        },
        hintDependency: {
          student: detail.metrics.hintDependency.sessions > 0
            ? detail.metrics.hintDependency.avgHintsPerSession
            : null,
          median: median(hintValues),
          higherIsBetter: false,
          unit: 'hints / session',
        },
        progress: {
          student: assigned > 0 ? completed / assigned : null,
          median: median(progressValues),
          higherIsBetter: true,
          unit: '% complete',
        },
      },
    };
  }

  res.json({
    ...detail,
    name: user.displayName,
    email: user.email,
    joinedAt: user.createdAt ? user.createdAt.toISOString() : null,
    classes: db.students.cohortNamesFor(studentId),
    status: statusResult.status,
    statusReasons: statusResult.reasons,
    nextAction,
    progress,
    cohortComparison,
    activity,
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/students/:studentId/data
// Permanently delete all work data for one student, scoped to
// exercises the calling instructor teaches. The user row and
// cohort membership are preserved — the student stays enrolled.
//
// Runs through a single transaction (via db.deletion) so a failure
// rolls back cleanly, then writes an audit row.
// ─────────────────────────────────────────────────────────────
router.delete('/:studentId/data', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId } = req.params;

  const user = await db.users.findById(studentId);
  if (!user) return res.status(404).json({ error: 'Student not found.' });

  const exerciseIds = viewableExerciseIdsFor(instructorId, studentId);
  if (exerciseIds.length === 0) {
    return res.status(403).json({ error: 'You do not teach this student.' });
  }

  const counts = db.deletion.purgeStudentData(studentId, exerciseIds);

  db.deletion.recordAudit({
    actorId: instructorId,
    actorEmail: req.user!.email ?? null,
    scope: 'student',
    targetId: studentId,
    targetLabel: user.displayName,
    counts,
  });

  res.json({ ok: true, removed: counts });
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId/export.csv
// Download a per-student CSV: identity + metrics summary,
// then a session-history table.
// ─────────────────────────────────────────────────────────────
router.get('/:studentId/export.csv', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId } = req.params;

  const user = await db.users.findById(studentId);
  if (!user) return res.status(404).json({ error: 'Student not found.' });

  const exerciseIds = viewableExerciseIdsFor(instructorId, studentId);
  if (exerciseIds.length === 0) {
    return res.status(403).json({ error: 'You do not teach this student.' });
  }

  const detail = db.students.detailFor(studentId, exerciseIds);
  const stats = db.students.statsFor(studentId, exerciseIds);
  const rosterStatus = deriveRosterStatus({
    exercisesAttempted: stats.exercisesAttempted,
    exercisesCompleted: stats.exercisesCompleted,
    lastActiveAt: stats.lastActiveAt,
  });
  const statusResult = escalateWithTrends(rosterStatus, detail.trends);

  const assigned = exerciseIds.length;
  const completedSlugs = new Set(
    detail.sessionHistory.filter((r) => r.state === 'complete').map((r) => r.exerciseId)
  );
  const completed = exerciseIds.filter((slug) => completedSlugs.has(slug)).length;
  const progressPct = assigned > 0 ? Math.round((completed / assigned) * 100) : 0;

  const rq = detail.metrics.reasoningQuality;
  const rqPct = rq.total > 0 ? Math.round((rq.precise / rq.total) * 100) : 0;
  const rqSummary = rq.total > 0
    ? rqPct + '% (' + rq.precise + ' precise, ' + rq.plausible + ' plausible, ' + rq.vague + ' vague)'
    : '—';

  const hd = detail.metrics.hintDependency;
  const hdSummary = hd.sessions > 0
    ? hd.avgHintsPerSession.toFixed(1) + ' hints / session (' + hd.sessions + ' session' + (hd.sessions === 1 ? '' : 's') + ')'
    : '—';

  const tm = detail.timeMetrics;
  const timeSummary = tm.sessionsWithTime > 0
    ? tm.totalStruggleMinutes + ' min total, ' + tm.avgStruggleMinutes + ' min avg'
    : '—';

  const act = db.students.activityForMany([studentId], exerciseIds, 90).get(studentId);
  const currentStreak = act ? act.currentStreak : 0;
  const longestStreak = act ? act.longestStreak : 0;

  const classes = db.students.cohortNamesFor(studentId);

  // CSV rows
  const rows: string[][] = [];
  rows.push(['# Summary']);
  rows.push(['Field', 'Value']);
  rows.push(['Name', user.displayName]);
  rows.push(['Email', user.email]);
  rows.push(['Classes', classes.join('; ')]);
  rows.push(['Joined', user.createdAt ? user.createdAt.toISOString().slice(0, 10) : '']);
  rows.push(['Status', statusResult.status]);
  rows.push(['Reasons', statusResult.reasons.join('; ')]);
  rows.push(['Reasoning quality', rqSummary]);
  rows.push(['Hint dependency', hdSummary]);
  rows.push(['Progress', completed + ' / ' + assigned + ' (' + progressPct + '%)']);
  rows.push(['Time on task', timeSummary]);
  rows.push(['Current streak (days)', String(currentStreak)]);
  rows.push(['Longest streak (days)', String(longestStreak)]);
  rows.push([]);
  rows.push(['# Session history']);
  rows.push([
    'Exercise',
    'State',
    'Level',
    'Attempts',
    'Struggle (min)',
    'Duration (min)',
    'Last activity',
  ]);
  for (const s of detail.sessionHistory) {
    rows.push([
      s.exerciseTitle || s.exerciseId,
      s.state,
      String(s.currentLevel),
      String(s.totalAttempts),
      String(s.struggleMinutes || 0),
      s.durationMinutes !== null ? String(s.durationMinutes) : '',
      s.updatedAt || '',
    ]);
  }

  const csv = rows
    .map((row) =>
      row.map((cell) => '"' + String(cell).replace(/"/g, '""') + '"').join(',')
    )
    .join('\r\n');

  const slug = user.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'student';
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + slug + '-' + stamp + '.csv"');
  res.send('\uFEFF' + csv);
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId/exercises/:exerciseId
// Detailed view of one (student, exercise) pair.
// ─────────────────────────────────────────────────────────────
router.get('/:studentId/exercises/:exerciseId', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId, exerciseId } = req.params;

  if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
    return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
  }

  const detail = db.students.exerciseDetailFor(studentId, exerciseId);
  if (!detail) {
    return res.status(404).json({ error: 'No work found for this exercise.' });
  }
  res.json(detail);
});

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/students/:studentId/exercises/:exerciseId/hypotheses/:hypothesisId/outcome
// Set or clear the outcome for one hypothesis. Body:
//   { outcome: 'confirmed' | 'refuted' | 'unclear' | null }
// ─────────────────────────────────────────────────────────────
router.patch(
  '/:studentId/exercises/:exerciseId/hypotheses/:hypothesisId/outcome',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId, exerciseId, hypothesisId } = req.params;
    const { outcome } = req.body as { outcome?: string | null };

    if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
      return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
    }

    const allowed = ['confirmed', 'refuted', 'unclear', null];
    if (!allowed.includes(outcome ?? null)) {
      return res.status(400).json({ error: 'outcome must be confirmed, refuted, unclear, or null.' });
    }

    const parsed = Number(hypothesisId);
    if (!Number.isFinite(parsed)) {
      return res.status(400).json({ error: 'Invalid hypothesis id.' });
    }

    const ok = db.students.updateHypothesisOutcome(
      studentId,
      exerciseId,
      parsed,
      (outcome ?? null) as 'confirmed' | 'refuted' | 'unclear' | null
    );
    if (!ok) {
      return res.status(404).json({ error: 'Hypothesis not found.' });
    }
    res.json({ ok: true, outcome: outcome ?? null });
  }
);

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId/exercises/:exerciseId/session-events
// The captured event log for one (student, exercise) session. Used by
// the tutor's Replay panel.
// ─────────────────────────────────────────────────────────────
router.get(
  '/:studentId/exercises/:exerciseId/session-events',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId, exerciseId } = req.params;

    if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
      return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
    }

    const session = await db.hintSessions.find(studentId, exerciseId);
    if (!session) {
      return res.json({ session: null, events: [] });
    }
    const events = db.sessionEvents.listForSession(session.id);
    res.json({ session, events });
  }
);

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/students/:studentId/exercises/:exerciseId/progress
// Reset a student's progress on one exercise. Removes their sessions,
// hypotheses, post-mortems, and mistake patterns for that exercise.
// ─────────────────────────────────────────────────────────────
router.delete(
  '/:studentId/exercises/:exerciseId/progress',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId, exerciseId } = req.params;

    if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
      return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
    }

    const removed = db.students.resetProgress(studentId, exerciseId);
    res.json({ ok: true, removed });
  }
);

// ─────────────────────────────────────────────────────────────
// POST /api/admin/students/:studentId/exercises/:exerciseId/feedback
// Create tutor feedback on a hypothesis or post-mortem.
// ─────────────────────────────────────────────────────────────
router.post(
  '/:studentId/exercises/:exerciseId/feedback',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId, exerciseId } = req.params;
    const { targetType, targetId, text } = req.body as {
      targetType?: string;
      targetId?: string | number;
      text?: string;
    };

    if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
      return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
    }

    if (targetType !== 'hypothesis' && targetType !== 'post_mortem') {
      return res.status(400).json({ error: 'targetType must be "hypothesis" or "post_mortem".' });
    }
    if (targetId === undefined || targetId === null || String(targetId).length === 0) {
      return res.status(400).json({ error: 'targetId is required.' });
    }
    const trimmed = (text ?? '').trim();
    if (trimmed.length === 0) {
      return res.status(400).json({ error: 'text is required.' });
    }
    if (trimmed.length > 2000) {
      return res.status(400).json({ error: 'text must be 2000 characters or fewer.' });
    }

    const feedback = db.tutorFeedback.create({
      instructorId,
      studentId,
      targetType,
      targetId: String(targetId),
      text: trimmed,
    });
    res.status(201).json(feedback);
  }
);

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/students/:studentId/exercises/:exerciseId/feedback/:id
// Only the author can delete their own feedback.
// ─────────────────────────────────────────────────────────────
router.delete(
  '/:studentId/exercises/:exerciseId/feedback/:id',
  requireInstructor,
  async (req, res) => {
    const instructorId = req.user!.id;
    const { studentId, exerciseId, id } = req.params;

    if (!canInstructorViewStudentOnExercise(instructorId, studentId, exerciseId)) {
      return res.status(403).json({ error: 'You do not teach this student on this exercise.' });
    }

    const ok = db.tutorFeedback.delete(id, instructorId);
    if (!ok) {
      return res.status(404).json({ error: 'Feedback not found, or you are not its author.' });
    }
    res.json({ ok: true });
  }
);

export default router;
