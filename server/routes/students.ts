import express from 'express';
import { db } from '../db.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import {
  rosterFor,
  viewableExerciseIdsFor,
  canInstructorViewStudentOnExercise,
} from '../auth/authorization.js';

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
      status: deriveStatus(stats),
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

function deriveStatus(stats: {
  exercisesAttempted: number;
  lastActiveAt: string | null;
}): 'on-track' | 'needs-attention' | 'inactive' | 'new' {
  if (stats.exercisesAttempted === 0) return 'new';
  if (!stats.lastActiveAt) return 'inactive';
  const daysSinceActive = (Date.now() - new Date(stats.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceActive > 14) return 'inactive';
  if (daysSinceActive > 7) return 'needs-attention';
  return 'on-track';
}

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

  res.json(db.students.detailFor(studentId, exerciseIds));
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

export default router;
