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
    exerciseType: e.exerciseType || 'code',
    options: e.options || [],
    starterCode: e.starterCode,
    expectedConcepts: e.expectedConcepts,
    requiredConcepts: e.requiredConcepts ?? [],
    expectedOutput: e.expectedOutput || '',
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
  const slugs = exercises.map((e) => e.slug);
  const difficulty = db.exercises.difficultyFor(slugs);
  res.json(exercises.map((e) => ({
    ...exerciseShape(e),
    difficulty: difficulty[e.slug] ?? null,
  })));
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
    requiredConcepts,
    learningObjectives,
    expectedOutput,
    struggleMinutes,
    exerciseType,
    options,
  } = req.body ?? {};

  if (typeof title !== 'string' || title.trim().length < 2) {
    return res.status(400).json({ error: 'Title must be at least 2 characters.' });
  }
  const lang = VALID_LANGUAGES.includes(language) ? language : 'javascript';

  // Phase 3.4a: exercise type + options (canonical: multiple_choice + object array)
  const CANONICAL_TYPES = ['code', 'multiple_choice', 'predict_output', 'quiz'] as const;
  const exType = CANONICAL_TYPES.includes(exerciseType) ? exerciseType : 'code';
  let optionsJson: string | null = null;
  if (exType === 'multiple_choice') {
    const clean = Array.isArray(options)
      ? options
          .filter((o: any) => o && typeof o.text === 'string' && o.text.trim().length > 0)
          .map((o: any, i: number) => ({
            id: typeof o.id === 'string' && o.id.length ? o.id : String.fromCharCode(97 + i),
            text: o.text.trim(),
            ...(o.correct === true ? { correct: true } : {}),
          }))
      : [];
    if (clean.length < 2) {
      return res.status(400).json({ error: 'Multiple-choice requires at least 2 options.' });
    }
    if (!clean.some((o) => o.correct === true)) {
      return res.status(400).json({ error: 'Multiple-choice requires at least one correct option.' });
    }
    optionsJson = JSON.stringify(clean);
  } else if (exType === 'predict_output') {
    const rawAnswer = typeof req.body.answer === 'string' ? req.body.answer.trim() : '';
    if (!rawAnswer) {
      return res.status(400).json({ error: 'Predict-output requires an answer.' });
    }
    optionsJson = JSON.stringify([{ correct: rawAnswer }]);
  } else if (exType === 'quiz') {
    const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
    if (!qs || qs.length === 0) {
      return res.status(400).json({ error: 'Quiz requires at least one question.' });
    }
    for (const q of qs) {
      if (!q || typeof q !== 'object') {
        return res.status(400).json({ error: 'Each quiz question must be an object.' });
      }
      if (!q.id || typeof q.id !== 'string') {
        return res.status(400).json({ error: 'Each question needs an id.' });
      }
      if (q.type === 'multiple_choice') {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          return res.status(400).json({ error: 'MC questions need at least 2 options.' });
        }
        if (!q.options.some((o: any) => o.correct === true)) {
          return res.status(400).json({ error: 'MC questions need a correct option.' });
        }
      } else if (q.type === 'predict_output') {
        if (typeof q.answer !== 'string' || !q.answer.trim()) {
          return res.status(400).json({ error: 'Predict questions need an answer.' });
        }
      } else {
        return res.status(400).json({ error: 'Unknown question type: ' + q.type });
      }
    }
    optionsJson = JSON.stringify({ questions: qs });
  }


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
    requiredConcepts: Array.isArray(requiredConcepts) ? requiredConcepts : [],
    learningObjectives: Array.isArray(learningObjectives) ? learningObjectives : [],
    expectedOutput: typeof expectedOutput === 'string' ? expectedOutput : '',
    struggleMinutes:
      typeof struggleMinutes === 'number' && struggleMinutes >= 0
        ? Math.min(60, struggleMinutes)
        : 0,
    cohortId: cohort.id,
    createdBy: req.user?.id ?? null,
    exerciseType: exType,
    options: optionsJson,
  });

  db.audit.record({
    actorId: req.user!.id,
    actorEmail: req.user!.email ?? null,
    action: 'exercise.create',
    targetType: 'exercise',
    targetId: exercise.slug,
    targetLabel: exercise.title,
    metadata: { cohortId: cohort.id },
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
    requiredConcepts,
    learningObjectives,
    expectedOutput,
    struggleMinutes,
    exerciseType,
    options,
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
  if (Array.isArray(requiredConcepts)) patch.requiredConcepts = requiredConcepts;
  if (Array.isArray(learningObjectives)) patch.learningObjectives = learningObjectives;
  if (typeof expectedOutput === 'string') patch.expectedOutput = expectedOutput;
  if (typeof struggleMinutes === 'number' && struggleMinutes >= 0) {
    patch.struggleMinutes = Math.min(60, struggleMinutes);
  }
  // Phase 3.4a: exercise type + options (canonical: multiple_choice + object array)
  if (exerciseType === 'code' || exerciseType === 'multiple_choice' || exerciseType === 'predict_output' || exerciseType === 'quiz') {
    patch.exerciseType = exerciseType;
    if (exerciseType === 'quiz') {
      const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
      if (!qs || qs.length === 0) {
        return res.status(400).json({ error: 'Quiz requires at least one question.' });
      }
      for (const q of qs) {
        if (!q || typeof q !== 'object' || !q.id || typeof q.id !== 'string') {
          return res.status(400).json({ error: 'Each question needs an id.' });
        }
        if (q.type === 'multiple_choice') {
          if (!Array.isArray(q.options) || q.options.length < 2 || !q.options.some((o: any) => o.correct === true)) {
            return res.status(400).json({ error: 'MC questions need ≥2 options and one correct.' });
          }
        } else if (q.type === 'predict_output') {
          if (typeof q.answer !== 'string' || !q.answer.trim()) {
            return res.status(400).json({ error: 'Predict questions need an answer.' });
          }
        } else {
          return res.status(400).json({ error: 'Unknown question type: ' + q.type });
        }
      }
      patch.options = JSON.stringify({ questions: qs });
    } else if (exerciseType === 'predict_output') {
      const rawAnswer = typeof req.body.answer === 'string' ? req.body.answer.trim() : '';
      if (!rawAnswer) {
        return res.status(400).json({ error: 'Predict-output requires an answer.' });
      }
      patch.options = JSON.stringify([{ correct: rawAnswer }]);
    } else if (exerciseType === 'multiple_choice') {
      const clean = Array.isArray(options)
        ? options
            .filter((o: any) => o && typeof o.text === 'string' && o.text.trim().length > 0)
            .map((o: any, i: number) => ({
              id: typeof o.id === 'string' && o.id.length ? o.id : String.fromCharCode(97 + i),
              text: o.text.trim(),
              ...(o.correct === true ? { correct: true } : {}),
            }))
        : [];
      if (clean.length < 2) {
        return res.status(400).json({ error: 'Multiple-choice requires at least 2 options.' });
      }
      if (!clean.some((o) => o.correct === true)) {
        return res.status(400).json({ error: 'Multiple-choice requires at least one correct option.' });
      }
      patch.options = JSON.stringify(clean);
    } else {
      patch.options = null;
    }
  }

  await db.exercises.update(existing.id, patch);
  const updated = await db.exercises.findById(existing.id);
  db.audit.record({
    actorId: req.user!.id,
    actorEmail: req.user!.email ?? null,
    action: 'exercise.update',
    targetType: 'exercise',
    targetId: existing.slug,
    targetLabel: updated?.title ?? existing.title,
    metadata: { fields: Object.keys(patch) },
  });
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
  db.audit.record({
    actorId: req.user!.id,
    actorEmail: req.user!.email ?? null,
    action: 'exercise.delete',
    targetType: 'exercise',
    targetId: existing.slug,
    targetLabel: existing.title,
  });
  res.json({ ok: true });
});

export default router;
