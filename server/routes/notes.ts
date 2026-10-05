import express from 'express';
import { db } from '../db.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { viewableExerciseIdsFor } from '../auth/authorization.js';

const router = express.Router();

const MAX_NOTE_LENGTH = 2000;

/**
 * Resolve which cohort the instructor should write notes about for this student.
 *
 * If the student is in exactly one of the instructor's cohorts, that's the one.
 * If the student is in multiple, the request must specify `cohortId`.
 */
async function resolveNoteCohort(
  instructorId: string,
  studentId: string,
  requestedCohortId?: string
): Promise<{ cohortId: string } | { error: string; status: number }> {
  // Find all cohorts the instructor teaches where the student is a member
  const student = await db.users.findById(studentId);
  if (!student) {
    return { error: 'Student not found.', status: 404 };
  }

  // Get instructor's cohorts
  const instructorCohorts = await db.cohorts.listByInstructor(instructorId);
  const instructorCohortIds = new Set(instructorCohorts.map((c) => c.id));

  // Get student's memberships
  const studentCohorts = await db.cohorts.listForUser(studentId);
  const shared = studentCohorts.filter((c) => instructorCohortIds.has(c.id));

  if (shared.length === 0) {
    return { error: 'You do not teach this student.', status: 403 };
  }

  if (requestedCohortId) {
    if (!shared.some((c) => c.id === requestedCohortId)) {
      return { error: 'You do not teach this student in that cohort.', status: 403 };
    }
    return { cohortId: requestedCohortId };
  }

  if (shared.length === 1) {
    return { cohortId: shared[0].id };
  }

  return {
    error: 'Student is in multiple of your cohorts. Specify cohortId.',
    status: 400,
  };
}

// ─────────────────────────────────────────────────────────────
// POST /api/admin/students/:studentId/notes
// ─────────────────────────────────────────────────────────────
router.post('/students/:studentId/notes', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId } = req.params;
  const { text, cohortId } = req.body ?? {};

  if (typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Note text is required.' });
  }
  if (text.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `Note is too long (max ${MAX_NOTE_LENGTH} characters).` });
  }

  const resolved = await resolveNoteCohort(instructorId, studentId, cohortId);
  if ('error' in resolved) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const note = await db.tutorNotes.create({
    instructorId,
    studentId,
    cohortId: resolved.cohortId,
    text: text.trim(),
  });

  res.status(201).json({
    id: note.id,
    studentId: note.studentId,
    cohortId: note.cohortId,
    text: note.text,
    createdAt: note.createdAt,
  });
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/students/:studentId/notes
// ─────────────────────────────────────────────────────────────
router.get('/students/:studentId/notes', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { studentId } = req.params;
  const cohortId = typeof req.query.cohortId === 'string' ? req.query.cohortId : undefined;

  const resolved = await resolveNoteCohort(instructorId, studentId, cohortId);
  if ('error' in resolved) {
    return res.status(resolved.status).json({ error: resolved.error });
  }

  const notes = await db.tutorNotes.list(instructorId, studentId, resolved.cohortId);
  res.json(
    notes.map((n) => ({
      id: n.id,
      studentId: n.studentId,
      cohortId: n.cohortId,
      text: n.text,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    }))
  );
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/admin/notes/:noteId
// ─────────────────────────────────────────────────────────────
router.delete('/notes/:noteId', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { noteId } = req.params;

  const note = await db.tutorNotes.findById(noteId);
  if (!note) {
    return res.status(404).json({ error: 'Note not found.' });
  }
  if (note.instructorId !== instructorId) {
    return res.status(403).json({ error: 'You can only delete your own notes.' });
  }

  const deleted = await db.tutorNotes.delete(noteId, instructorId);
  if (!deleted) {
    return res.status(500).json({ error: 'Could not delete note.' });
  }
  res.json({ ok: true });
});

export default router;
