import express from 'express';
import { db } from '../db.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { generateEnrollmentCode } from '../auth/enrollmentCodes.js';

const router = express.Router();

async function ensureUniqueEnrollmentCode(): Promise<string | null> {
  for (let i = 0; i < 5; i++) {
    const candidate = generateEnrollmentCode();
    const existing = await db.cohorts.findByEnrollmentCode(candidate);
    if (!existing) return candidate;
  }
  return null;
}

// GET /api/admin/cohorts — list all cohorts this instructor teaches
router.get('/', requireInstructor, async (req, res) => {
  const cohorts = await db.cohorts.listByInstructor(req.user!.id);
  const enriched = await Promise.all(
    cohorts.map(async (c) => ({
      id: c.id,
      name: c.name,
      enrollmentCode: c.enrollmentCode,
      memberCount: await db.cohorts.countMembers(c.id),
      exerciseCount: await db.cohorts.countExercises(c.id),
    }))
  );
  res.json(enriched);
});

// POST /api/admin/cohorts — create a new cohort
router.post('/', requireInstructor, async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Class name must be at least 2 characters.' });
  }

  const code = await ensureUniqueEnrollmentCode();
  if (!code) {
    return res.status(500).json({ error: 'Could not generate an enrollment code.' });
  }

  const cohort = await db.cohorts.create({
    name: name.trim(),
    instructorId: req.user!.id,
    enrollmentCode: code,
  });

  res.status(201).json({
    id: cohort.id,
    name: cohort.name,
    enrollmentCode: cohort.enrollmentCode,
    memberCount: 0,
    exerciseCount: 0,
  });
});

// PATCH /api/admin/cohorts/:id — rename
router.patch('/:id', requireInstructor, async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Class name must be at least 2 characters.' });
  }
  const cohort = await db.cohorts.findById(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Class not found.' });
  if (cohort.instructorId !== req.user!.id) {
    return res.status(403).json({ error: 'You do not teach that class.' });
  }
  await db.cohorts.rename(cohort.id, name.trim());
  res.json({ ok: true, name: name.trim() });
});

// DELETE /api/admin/cohorts/:id — delete (only if empty)
router.delete('/:id', requireInstructor, async (req, res) => {
  const cohort = await db.cohorts.findById(req.params.id);
  if (!cohort) return res.status(404).json({ error: 'Class not found.' });
  if (cohort.instructorId !== req.user!.id) {
    return res.status(403).json({ error: 'You do not teach that class.' });
  }

  const exerciseCount = await db.cohorts.countExercises(cohort.id);
  if (exerciseCount > 0) {
    return res.status(400).json({
      error: `Cannot delete a class with ${exerciseCount} exercise${exerciseCount === 1 ? '' : 's'}. Move or delete them first.`,
    });
  }

  await db.cohorts.delete(cohort.id);
  res.json({ ok: true });
});

export default router;
