import express from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { db } from '../db.js';
import { slugify } from '../util/slug.js';

const router = express.Router();
const VALID_LANGUAGES = ['javascript', 'typescript', 'python'];

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base;
  let i = 1;
  while (await db.exercises.findBySlug(candidate)) {
    candidate = base + '-' + (++i);
  }
  return candidate;
}

// POST /api/me/exercises — create a practice exercise (cohort_id NULL)
router.post('/', requireAuth, async (req, res) => {
  const {
    title, description, language, starterCode, expectedOutput,
  } = req.body ?? {};

  if (typeof title !== 'string' || title.trim().length < 2) {
    return res.status(400).json({ error: 'Title must be at least 2 characters.' });
  }

  const lang = VALID_LANGUAGES.includes(language) ? language : 'python';
  const slug = await uniqueSlug(slugify(title.trim()));

  const exercise = await db.exercises.create({
    slug,
    title: title.trim(),
    description: typeof description === 'string' ? description : '',
    language: lang,
    starterCode: typeof starterCode === 'string' ? starterCode : '',
    expectedConcepts: [],
    requiredConcepts: [],
    learningObjectives: [],
    expectedOutput: typeof expectedOutput === 'string' ? expectedOutput : '',
    struggleMinutes: 0,
    cohortId: null,
    createdBy: req.user!.id,
  });

  res.status(201).json(exercise);
});

// DELETE /api/me/exercises/:slug — delete own practice exercise
router.delete('/:slug', requireAuth, async (req, res) => {
  const ex = await db.exercises.findBySlug(String(req.params.slug));
  if (!ex) return res.status(404).json({ error: 'Not found.' });
  if (ex.cohortId !== null) {
    return res.status(403).json({ error: 'Not a practice exercise.' });
  }
  if (ex.createdBy !== req.user!.id) {
    return res.status(403).json({ error: 'Not yours.' });
  }
  await db.exercises.delete(ex.id);
  res.json({ ok: true });
});

export default router;
