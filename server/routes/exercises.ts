import express from 'express';
import { db } from '../db.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { slugify, uniqueSlug } from '../util/slug.js';

const router = express.Router();

const VALID_LANGUAGES = ['javascript', 'typescript', 'python'];

// ─── Helpers ───

async function getInstructorCohort(req: express.Request) {
  const instructorId = req.user?.id;
  if (!instructorId) return null;
  return db.cohorts.ensureForInstructor(instructorId);
}

function exerciseShape(e: any) {
  return {
    id: e.id,
    slug: e.slug,
    title: e.title,
    description: e.description,
    language: e.language,
    starterCode: e.starterCode,
    expectedConcepts: e.expectedConcepts,
    learningObjectives: e.learningObjectives,
    struggleMinutes: e.struggleMinutes,
    cohortId: e.cohortId,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

// ─── List ───

router.get('/', requireInstructor, async (req, res) => {
  const requestedId = typeof req.query.cohortId === 'string' ? req.query.cohortId : null;

  let cohortId: string;
  if (requestedId) {
    const cohort = await db.cohorts.findById(requestedId);
    if (!cohort || cohort.instructorId !== req.user!.id) {
      return res.status(404).json({ error: 'Class not found.' });
    }
    cohortId = cohort.id;
  } else {
    const cohort = await getInstructorCohort(req);
    if (!cohort) return res.status(500).json({ error: 'Could not resolve instructor cohort.' });
    cohortId = cohort.id;
  }

  const exercises = await db.exercises.listByCohort(cohortId);
  res.json(exercises.map(exerciseShape));
});

// ─── Get one ───

router.get('/:slug', requireInstructor, async (req, res) => {
  const cohort = await getInstructorCohort(req);
  if (!cohort) return res.status(500).json({ error: 'Could not resolve instructor cohort.' });

  const exercise = await db.exercises.findBySlug(req.params.slug);
  if (!exercise) return res.status(404).json({ error: 'Exercise not found.' });
  if (exercise.cohortId !== cohort.id) {
    return res.status(403).json({ error: 'That exercise belongs to another cohort.' });
  }
  res.json(exerciseShape(exercise));
});

// ─── Create ───

router.post('/', requireInstructor, async (req, res) => {
  const requestedId = typeof req.body?.cohortId === 'string' ? req.body.cohortId : null;
  let cohort;
  if (requestedId) {
    cohort = await db.cohorts.findById(requestedId);
    if (!cohort || cohort.instructorId !== req.user!.id) {
      return res.status(404).json({ error: 'Class not found.' });
    }
  } else {
    cohort = await getInstructorCohort(req);
  }
  if (!cohort) return res.status(500).json({ error: 'Could not resolve instructor cohort.' });

  const {
    title,
    description,
    language,
    starterCode,
    expectedConcepts,
    learningObjectives,
    struggleMinutes,
  } = req.body ?? {};

  if (typeof title !== 'string' || title.trim().length < 2) {
    return res.status(400).json({ error: 'Title must be at least 2 characters.' });
  }
  const lang = VALID_LANGUAGES.includes(language) ? language : 'javascript';

  const baseSlug = slugify(title.trim());
  const slug = await uniqueSlug(baseSlug, async (candidate) => {
    const existing = await db.exercises.findBySlug(candidate);
    return existing !== null;
  });

  const exercise = await db.exercises.create({
    slug,
    title: title.trim(),
    description: typeof description === 'string' ? description : '',
    language: lang,
    starterCode: typeof starterCode === 'string' ? starterCode : '',
    expectedConcepts: Array.isArray(expectedConcepts) ? expectedConcepts : [],
    learningObjectives: Array.isArray(learningObjectives) ? learningObjectives : [],
    struggleMinutes:
      typeof struggleMinutes === 'number' && struggleMinutes >= 0
        ? Math.min(60, struggleMinutes)
        : 0,
    cohortId: cohort.id,
    createdBy: req.user?.id ?? null,
  });

  res.status(201).json(exerciseShape(exercise));
});

// ─── Update ───

router.put('/:slug', requireInstructor, async (req, res) => {
  const cohort = await getInstructorCohort(req);
  if (!cohort) return res.status(500).json({ error: 'Could not resolve instructor cohort.' });

  const existing = await db.exercises.findBySlug(req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Exercise not found.' });
  if (existing.cohortId !== cohort.id) {
    return res.status(403).json({ error: 'That exercise belongs to another cohort.' });
  }

  const {
    title,
    description,
    language,
    starterCode,
    expectedConcepts,
    learningObjectives,
    struggleMinutes,
  } = req.body ?? {};

  const patch: Record<string, any> = {};

  if (typeof title === 'string' && title.trim().length >= 2) {
    patch.title = title.trim();
  }
  if (typeof description === 'string') patch.description = description;
  if (typeof language === 'string' && VALID_LANGUAGES.includes(language)) {
    patch.language = language;
  }
  if (typeof starterCode === 'string') patch.starterCode = starterCode;
  if (Array.isArray(expectedConcepts)) patch.expectedConcepts = expectedConcepts;
  if (Array.isArray(learningObjectives)) patch.learningObjectives = learningObjectives;
  if (typeof struggleMinutes === 'number' && struggleMinutes >= 0) {
    patch.struggleMinutes = Math.min(60, struggleMinutes);
  }

  await db.exercises.update(existing.id, patch);
  const updated = await db.exercises.findById(existing.id);
  res.json(exerciseShape(updated));
});

// ─── Delete ───

router.delete('/:slug', requireInstructor, async (req, res) => {
  const cohort = await getInstructorCohort(req);
  if (!cohort) return res.status(500).json({ error: 'Could not resolve instructor cohort.' });

  const existing = await db.exercises.findBySlug(req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Exercise not found.' });
  if (existing.cohortId !== cohort.id) {
    return res.status(403).json({ error: 'That exercise belongs to another cohort.' });
  }

  const deleted = await db.exercises.delete(existing.id);
  if (!deleted) {
    return res.status(500).json({ error: 'Could not delete exercise.' });
  }
  res.json({ ok: true });
});

export default router;
