import express from 'express';
import { db } from '../db.js';
import { requireAuth, requireInstructor } from '../middleware/requireAuth.js';
import { generateEnrollmentCode } from '../auth/enrollmentCodes.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/cohorts/me
// Instructor-only. Returns the instructor's cohort, enrollment
// code (generated on first access), and member count.
// ─────────────────────────────────────────────────────────────
router.get('/me', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const cohort = await db.cohorts.ensureForInstructor(instructorId);

  // Generate an enrollment code lazily if one doesn't exist
  let enrollmentCode = cohort.enrollmentCode;
  if (!enrollmentCode) {
    // Try a few times in case of collision
    for (let i = 0; i < 5; i++) {
      const candidate = generateEnrollmentCode();
      const existing = await db.cohorts.findByEnrollmentCode(candidate);
      if (existing) continue;
      await db.cohorts.setEnrollmentCode(cohort.id, candidate);
      enrollmentCode = candidate;
      break;
    }
  }

  const memberCount = await db.cohorts.countMembers(cohort.id);

  res.json({
    id: cohort.id,
    name: cohort.name,
    enrollmentCode,
    memberCount,
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/cohorts/join
// Student-facing. Adds the caller as a member of the cohort
// identified by the supplied code.
// ─────────────────────────────────────────────────────────────
router.post('/join', requireAuth, async (req, res) => {
  const { code } = req.body ?? {};
  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ error: 'Enrollment code is required.' });
  }

  const normalized = code.trim().toUpperCase();
  const cohort = await db.cohorts.findByEnrollmentCode(normalized);
  if (!cohort) {
    return res.status(400).json({ error: 'That enrollment code is not valid.' });
  }

  // Can't join as yourself if you're the instructor of this cohort
  if (cohort.instructorId === req.user!.id) {
    return res.status(400).json({ error: 'You are the instructor of this cohort.' });
  }

  await db.cohortMembers.add(cohort.id, req.user!.id);

  res.json({
    ok: true,
    cohort: {
      id: cohort.id,
      name: cohort.name,
    },
  });
});

// ─────────────────────────────────────────────────────────────
// DELETE /api/cohorts/:cohortId/leave
// Student-facing. Removes the caller from the specified cohort.
// ─────────────────────────────────────────────────────────────
router.delete('/:cohortId/leave', requireAuth, async (req, res) => {
  const removed = await db.cohortMembers.remove(
    req.params.cohortId,
    req.user!.id
  );
  if (!removed) {
    return res.status(404).json({ error: 'You are not a member of that cohort.' });
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// GET /api/cohorts/mine
// Student-facing (also works for instructors). Lists all cohorts
// the caller belongs to.
// ─────────────────────────────────────────────────────────────
router.get('/mine', requireAuth, async (req, res) => {
  const cohorts = await db.cohorts.listForUser(req.user!.id);
  res.json(
    cohorts.map((c) => ({
      id: c.id,
      name: c.name,
      joinedAt: c.joinedAt,
    }))
  );
});

export default router;
