import express from 'express';
import { db } from '../db.js';
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
  if (peerIds.length > 0) {
    const peerRows = db.students.cohortPeerMetricsFor(peerIds, exerciseIds);

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
