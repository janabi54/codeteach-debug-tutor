import express from 'express';
import crypto from 'crypto';
import { db } from '../db.js';
import { sqlite } from '../db.js';
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
  const CANONICAL_TYPES = ['code', 'multiple_choice', 'predict_output', 'quiz', 'fill_in_blank', 'trace_execution'] as const;
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
  } else if (exType === 'fill_in_blank') {
    const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
    if (!qs || qs.length === 0) {
      return res.status(400).json({ error: 'Fill-in-blank requires at least one question.' });
    }
    for (const q of qs) {
      if (!q || typeof q !== 'object' || !q.id || typeof q.id !== 'string') {
        return res.status(400).json({ error: 'Each question needs an id.' });
      }
      if (typeof q.code !== 'string' || !q.code.trim()) {
        return res.status(400).json({ error: 'Fill-in-blank questions need a code block.' });
      }
      const blankCount = (q.code.match(/___/g) || []).length;
      if (blankCount === 0) {
        return res.status(400).json({ error: 'Code block must contain ___ markers.' });
      }
      if (!Array.isArray(q.blanks) || q.blanks.length !== blankCount) {
        return res.status(400).json({ error: 'Mismatch between ___ markers and blank answers.' });
      }
      for (const b of q.blanks) {
        if (!b || typeof b.correct !== 'string' || !b.correct.trim()) {
          return res.status(400).json({ error: 'Each blank needs a correct answer.' });
        }
      }
    }
    optionsJson = JSON.stringify({ questions: qs });
  } else if (exType === 'trace_execution') {
    const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
    if (!qs || qs.length === 0) {
      return res.status(400).json({ error: 'Trace-execution requires at least one question.' });
    }
    for (const q of qs) {
      if (!q || typeof q !== 'object' || !q.id || typeof q.id !== 'string') {
        return res.status(400).json({ error: 'Each question needs an id.' });
      }
      if (typeof q.code !== 'string' || !q.code.trim()) {
        return res.status(400).json({ error: 'Trace-execution questions need code.' });
      }
      if (!Array.isArray(q.variables) || q.variables.length === 0) {
        return res.status(400).json({ error: 'Trace-execution questions need variables.' });
      }
      if (!Array.isArray(q.steps) || q.steps.length === 0) {
        return res.status(400).json({ error: 'Trace-execution questions need steps.' });
      }
      for (const v of q.variables) {
        if (!v || typeof v.name !== 'string' || !v.name.trim()) {
          return res.status(400).json({ error: 'Each variable needs a name.' });
        }
      }
      for (const s of q.steps) {
        if (!s || !s.values || typeof s.values !== 'object') {
          return res.status(400).json({ error: 'Each step needs values.' });
        }
        for (const v of q.variables) {
          if (typeof s.values[v.name] !== 'string') {
            return res.status(400).json({ error: 'Step missing value for ' + v.name });
          }
        }
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
  if (exerciseType === 'code' || exerciseType === 'multiple_choice' || exerciseType === 'predict_output' || exerciseType === 'quiz' || exerciseType === 'fill_in_blank' || exerciseType === 'trace_execution') {
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
    } else if (exerciseType === 'fill_in_blank') {
      const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
      if (!qs || qs.length === 0) {
        return res.status(400).json({ error: 'Fill-in-blank requires at least one question.' });
      }
      for (const q of qs) {
        if (!q || typeof q !== 'object' || !q.id || typeof q.id !== 'string') {
          return res.status(400).json({ error: 'Each question needs an id.' });
        }
        if (typeof q.code !== 'string' || !q.code.trim()) {
          return res.status(400).json({ error: 'Fill-in-blank questions need a code block.' });
        }
        const blankCount = (q.code.match(/___/g) || []).length;
        if (blankCount === 0) {
          return res.status(400).json({ error: 'Code block must contain ___ markers.' });
        }
        if (!Array.isArray(q.blanks) || q.blanks.length !== blankCount) {
          return res.status(400).json({ error: 'Mismatch between ___ markers and blank answers.' });
        }
        for (const b of q.blanks) {
          if (!b || typeof b.correct !== 'string' || !b.correct.trim()) {
            return res.status(400).json({ error: 'Each blank needs a correct answer.' });
          }
        }
      }
      patch.options = JSON.stringify({ questions: qs });
    } else if (exerciseType === 'trace_execution') {
      const qs = Array.isArray(req.body.questions) ? req.body.questions : null;
      if (!qs || qs.length === 0) {
        return res.status(400).json({ error: 'Trace-execution requires at least one question.' });
      }
      for (const q of qs) {
        if (!q || typeof q !== 'object' || !q.id) {
          return res.status(400).json({ error: 'Each question needs an id.' });
        }
        if (typeof q.code !== 'string' || !q.code.trim()) {
          return res.status(400).json({ error: 'Trace-execution questions need code.' });
        }
        if (!Array.isArray(q.variables) || q.variables.length === 0) {
          return res.status(400).json({ error: 'Trace-execution questions need variables.' });
        }
        if (!Array.isArray(q.steps) || q.steps.length === 0) {
          return res.status(400).json({ error: 'Trace-execution questions need steps.' });
        }
        for (const v of q.variables) {
          if (!v || typeof v.name !== 'string' || !v.name.trim()) {
            return res.status(400).json({ error: 'Each variable needs a name.' });
          }
        }
        for (const s of q.steps) {
          if (!s || !s.values || typeof s.values !== 'object') {
            return res.status(400).json({ error: 'Each step needs values.' });
          }
          for (const v of q.variables) {
            if (typeof s.values[v.name] !== 'string') {
              return res.status(400).json({ error: 'Step missing value for ' + v.name });
            }
          }
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


// ─────────────────────────────────────────────────────────────
// Phase 4.0: Public exercise library
// ─────────────────────────────────────────────────────────────

// POST /api/admin/exercises/:slug/publish — mark as public
router.post('/:slug/publish', requireInstructor, async (req, res) => {
  const { slug } = req.params;
  const ex = await db.exercises.findBySlug(slug);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });
  try {
    sqlite.prepare('UPDATE exercises SET is_public = 1, updated_at = datetime(\'now\') WHERE slug = ?').run(slug);
    res.json({ ok: true, slug, isPublic: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not publish.' });
  }
});

// POST /api/admin/exercises/:slug/unpublish — remove from public library
router.post('/:slug/unpublish', requireInstructor, async (req, res) => {
  const { slug } = req.params;
  const ex = await db.exercises.findBySlug(slug);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });
  try {
    sqlite.prepare('UPDATE exercises SET is_public = 0, updated_at = datetime(\'now\') WHERE slug = ?').run(slug);
    res.json({ ok: true, slug, isPublic: false });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not unpublish.' });
  }
});

// POST /api/admin/exercises/:slug/import — copy a public exercise into caller's cohort
router.post('/:slug/import', requireInstructor, async (req, res) => {
  const { slug } = req.params;
  const original = await db.exercises.findBySlug(slug);
  if (!original) return res.status(404).json({ error: 'Exercise not found.' });
  // Phase 4.0: query DB directly since rowToExercise doesn't return isPublic
  const srcRow = sqlite.prepare('SELECT is_public FROM exercises WHERE slug = ?').get(slug) as { is_public: number } | undefined;
  if (!srcRow || !srcRow.is_public) {
    return res.status(403).json({ error: 'Only public exercises can be imported.' });
  }
  try {
    // Phase 4.0 fix: honor ?cohortId from frontend (falls back to first cohort)
    const cohortIdParam = String(req.query.cohortId || '');
    let cohort;
    if (cohortIdParam) {
      cohort = await db.cohorts.findById(cohortIdParam);
      if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
      if (cohort.instructorId !== req.user!.id) {
        return res.status(403).json({ error: 'You do not own that cohort.' });
      }
    } else {
      cohort = await getInstructorCohort(req);
    }
    if (!cohort) return res.status(500).json({ error: 'No cohort found.' });

    // Unique slug
    let baseSlug = original.slug + '-copy';
    let candidate = baseSlug;
    let i = 1;
    while (await db.exercises.findBySlug(candidate)) {
      candidate = baseSlug + '-' + i;
      i++;
    }

    // Build new exercise record (copy fields, set new cohort/creator)
    const row = sqlite.prepare('SELECT * FROM exercises WHERE slug = ?').get(slug) as any;
    if (!row) return res.status(404).json({ error: 'Source not found.' });
    const newId = crypto.randomUUID();
    sqlite.prepare(`
      INSERT INTO exercises (
        id, slug, title, description, language, starter_code,
        expected_concepts, required_concepts, learning_objectives, expected_output,
        struggle_minutes, exercise_type, options_json, is_public,
        cohort_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      newId,
      candidate,
      row.title,
      row.description,
      row.language,
      row.starter_code,
      row.expected_concepts,
      row.required_concepts,
      row.learning_objectives,
      row.expected_output,
      row.struggle_minutes,
      row.exercise_type,
      row.options_json,
      cohort.id,
      req.user!.id
    );

    const imported = await db.exercises.findBySlug(candidate);
    if (!imported) return res.status(500).json({ error: 'Import failed (row missing).' });
    res.json({ ok: true, importedSlug: candidate, imported: exerciseShape(imported) });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not import.' });
  }
});


export default router;
