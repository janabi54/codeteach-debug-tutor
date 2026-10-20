import express from 'express';
import { getTutorHint } from '../debugTutor/tutorService.js';
import { scorePostMortem } from '../debugTutor/postMortem.js';
import { emit } from '../webhooks/outbound/emit.js';
import { scoreHypothesis } from '../debugTutor/hypothesisScore.js';
import { HintSessionManager } from '../debugTutor/hintSession.js';
import { getStruggleMinutes } from '../debugTutor/exerciseConfig.js';
import { getWeakSpots } from '../debugTutor/weakSpots.js';
import { db, sqlite } from '../db.js';
import {
  requireAuth,
  resolveActingStudentId,
} from '../middleware/requireAuth.js';


// ─── Achievement checks ───
// Fire-and-forget. Never throws.
async function checkAchievements(studentId: string, exerciseId: string): Promise<void> {
  try {
    // first-post-mortem
    const pm = sqlite.prepare('SELECT COUNT(*) AS n FROM post_mortems WHERE student_id = ?').get(studentId) as { n: number };
    if (pm.n >= 1) db.achievements.award(studentId, 'first-post-mortem');

    // first-perfect
    const strong = sqlite.prepare("SELECT 1 FROM post_mortems WHERE student_id = ? AND score = 'strong' LIMIT 1").get(studentId);
    if (strong) db.achievements.award(studentId, 'first-perfect');

    // first-completion + ten-exercises
    const completed = sqlite.prepare("SELECT COUNT(DISTINCT exercise_id) AS n FROM hint_sessions WHERE student_id = ? AND state = 'complete'").get(studentId) as { n: number };
    if (completed.n >= 1) db.achievements.award(studentId, 'first-completion');
    if (completed.n >= 10) db.achievements.award(studentId, 'ten-exercises');

    // first-practice — the exercise just completed is cohort-less
    const ex = await db.exercises.findBySlug(exerciseId);
    if (ex && ex.cohortId === null) db.achievements.award(studentId, 'first-practice');

    // streaks — use the same activity source as /me/progress
    const act = db.students.activityForMany([studentId], [], 90).get(studentId);
    if (act && act.currentStreak >= 3) db.achievements.award(studentId, 'streak-3');
    if (act && act.currentStreak >= 7) db.achievements.award(studentId, 'streak-7');
  } catch (err) {
    console.error('[achievements] check failed:', err);
  }
}
const router = express.Router();
const hintSessions = new HintSessionManager();

// ─────────────────────────────────────────────────────────────
// POST /api/debug-tutor/hint
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// POST /api/debug-tutor/verify-run
// Body: { sessionId, output }
// Compares the student's pasted output against the exercise's
// expected output (both trimmed). Records the outcome on the session
// so the tutor can reference it, and so 'I fixed it' can be gated
// (Session 3c). Returns the comparison result.
// ─────────────────────────────────────────────────────────────
router.post('/verify-run', requireAuth, async (req, res) => {
  const { sessionId, output } = req.body as { sessionId?: string; output?: string };
  if (!sessionId || typeof output !== 'string') {
    return res.status(400).json({ error: 'sessionId and output are required.' });
  }

  const session = await db.hintSessions.findById(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  // Verify the caller owns this session.
  const acting = resolveActingStudentId(req, session.studentId);
  if (acting !== session.studentId) {
    return res.status(403).json({ error: 'Not your session.' });
  }

  const exercise = await db.exercises.findBySlug(session.exerciseId);
  const expected = (exercise?.expectedOutput || '').trim();
  const submitted = String(output).trim();

  // No goal declared → nothing to compare against. Treat as a non-match
  // but report hasGoal: false so the client can tell the difference.
  if (!expected) {
    return res.json({ matched: false, hasGoal: false, expected: '', submitted });
  }

  const matched = expected === submitted;
  db.hintSessions.recordRun(sessionId, submitted, matched);

  res.json({ matched, hasGoal: true, expected, submitted });
});

// ─────────────────────────────────────────────────────────────
// POST /api/debug-tutor/clear-run
// Body: { sessionId }
// Clears a stored run — called by the client when the student edits
// their code, because the previous run is no longer evidence.
// ─────────────────────────────────────────────────────────────
router.post('/clear-run', requireAuth, async (req, res) => {
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required.' });

  const session = await db.hintSessions.findById(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found.' });

  const acting = resolveActingStudentId(req, session.studentId);
  if (acting !== session.studentId) {
    return res.status(403).json({ error: 'Not your session.' });
  }

  db.hintSessions.clearRun(sessionId);
  res.json({ ok: true });
});

// ─── POST /answer — multiple-choice submission ───
// Phase 3.5a: legacy endpoints must unwrap {questions:[...]} from backfill
function unwrapLegacyOptions(ex: any): Array<any> {
  const o = ex.options;
  if (Array.isArray(o)) return o;
  if (o && Array.isArray(o.questions) && o.questions.length > 0) {
    const q0 = o.questions[0];
    if (Array.isArray(q0.options)) return q0.options;
    // predict backfill shape: { answer: '...' } → mimic old [{correct: '...'}]
    if (typeof q0.answer === 'string') return [{ correct: q0.answer }];
    return [];
  }
  return [];
}

router.post('/answer', requireAuth, async (req, res) => {
  const { exerciseId, optionId } = req.body ?? {};
  if (typeof exerciseId !== 'string' || typeof optionId !== 'string') {
    return res.status(400).json({ error: 'exerciseId and optionId required.' });
  }
  const studentId = resolveActingStudentId(req, req.body.studentId);

  const ex = await db.exercises.findBySlug(exerciseId);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });
  if (ex.exerciseType !== 'multiple_choice') {
    return res.status(400).json({ error: 'Not a multiple-choice exercise.' });
  }
  const opts = unwrapLegacyOptions(ex) as Array<{ id: string; text: string; correct?: boolean }>;
  const chosen = opts.find((o) => o.id === optionId);
  if (!chosen) return res.status(400).json({ error: 'Option not found.' });
  const correct = chosen.correct === true;

  sqlite.prepare(
    `INSERT INTO answers (student_id, exercise_id, selected_option_id, correct)
     VALUES (?, ?, ?, ?)`
  ).run(studentId, ex.slug, optionId, correct ? 1 : 0);

  // Update session: matched=correct, and if correct, mark resolved
  const session = await hintSessions.getOrCreate(studentId, ex.slug, { struggleMinutes: ex.struggleMinutes });
  sqlite.prepare(
    `UPDATE hint_sessions
        SET last_run_matched = ?, last_run_at = datetime('now'),
            state = CASE WHEN ? = 1 AND state = 'open' THEN 'resolved' ELSE state END
      WHERE student_id = ? AND exercise_id = ?`
  ).run(correct ? 1 : 0, correct ? 1 : 0, studentId, ex.slug);

  res.json({
    correct,
    optionId,
    feedback: correct
      ? 'Correct. Now — can you explain why the other options are wrong?'
      : 'Not quite. Look at the other options and consider what changes.',
  });
});

// ─── POST /predict — predict-output submission ───
router.post('/predict', requireAuth, async (req, res) => {
  const { exerciseId, answer } = req.body ?? {};
  if (typeof exerciseId !== 'string' || typeof answer !== 'string') {
    return res.status(400).json({ error: 'exerciseId and answer required.' });
  }
  const studentId = resolveActingStudentId(req, req.body.studentId);

  const ex = await db.exercises.findBySlug(exerciseId);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });
  if (ex.exerciseType !== 'predict_output') {
    return res.status(400).json({ error: 'Not a predict-output exercise.' });
  }

  const opts = unwrapLegacyOptions(ex) as Array<{ correct?: string }>;
  const expectedRaw = opts.find((o) => typeof o.correct === 'string')?.correct || '';
  // Normalize: strip ALL whitespace (internal + trim) so "0,1,2" == "0, 1, 2"
  const expected = expectedRaw.replace(/\s+/g, '').toLowerCase();
  const submitted = answer.replace(/\s+/g, '').toLowerCase();
  const correct = expected.length > 0 && expected === submitted;

  // Record in answers table (optionId holds the submitted text, tagged)
  sqlite.prepare(
    `INSERT INTO answers (student_id, exercise_id, selected_option_id, correct)
     VALUES (?, ?, ?, ?)`
  ).run(studentId, ex.slug, 'predict:' + submitted, correct ? 1 : 0);

  // Session update
  sqlite.prepare(
    `UPDATE hint_sessions
        SET last_run_matched = ?, last_run_at = datetime('now'),
            state = CASE WHEN ? = 1 AND state = 'open' THEN 'resolved' ELSE state END
      WHERE student_id = ? AND exercise_id = ?`
  ).run(correct ? 1 : 0, correct ? 1 : 0, studentId, ex.slug);

  res.json({
    correct,
    submitted: answer,
    feedback: correct
      ? 'Correct. Now — can you explain why it produces that output?'
      : 'Not quite. Trace the code by hand and try again.',
  });
});
// ─── POST /quiz-hint — per-question hint for multi-question quizzes (Phase 3.7) ───
router.post('/quiz-hint', requireAuth, async (req, res) => {
  const { exerciseId, questionId } = req.body ?? {};
  if (typeof exerciseId !== 'string' || typeof questionId !== 'string') {
    return res.status(400).json({ error: 'exerciseId and questionId required.' });
  }
  const studentId = resolveActingStudentId(req, req.body.studentId);

  const ex = await db.exercises.findBySlug(exerciseId);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });

  let questions: any[] = [];
  if (ex.options && typeof ex.options === 'object' && Array.isArray((ex.options as any).questions)) {
    questions = (ex.options as any).questions;
  }
  const q = questions.find((x) => x && x.id === questionId);
  if (!q) return res.status(404).json({ error: 'Question not found.' });

  const compositeExId = ex.slug + ':q:' + questionId;
  const struggleMinutes = ex.struggleMinutes || 0;
  const session = await hintSessions.getOrCreate(studentId, compositeExId, { struggleMinutes });

  const hintsUsed = session.totalAttempts || 0;
  const MAX_LEVEL = 4;
  if (hintsUsed >= MAX_LEVEL) {
    return res.json({
      exhausted: true,
      level: MAX_LEVEL,
      message: 'You have used all 4 hints for this question. Try your best answer, or re-read the question carefully.',
      isFallback: true,
      source: 'exhausted',
    });
  }

  const questionDescription =
    (q.text ? String(q.text) : 'Answer this quiz question.') +
    (q.type === 'multiple_choice' && Array.isArray(q.options)
      ? ' Options: ' + q.options.map((o: any, i: number) => String.fromCharCode(97 + i) + ') ' + String(o.text || '')).join('; ')
      : '');

  const hintLevel = Math.min((hintsUsed + 1) as 1 | 2 | 3 | 4, MAX_LEVEL);

  try {
    const hint = await getTutorHint({
      studentId,
      exerciseId: compositeExId,
      code: '',
      language: ex.language || 'text',
      errorOutput: '',
      exerciseContext: {
        title: ex.title || 'Quiz question',
        description: questionDescription,
        learningObjectives: [],
        expectedConcepts: [],
        expectedOutput: undefined,
        lastRun: null,
      },
      attemptNumber: hintsUsed,
      hypothesis: undefined,
    });

    await db.hintSessions.update(session.id, {
      totalAttempts: hintsUsed + 1,
      currentLevel: Math.min(hintLevel + 1, MAX_LEVEL),
    });

    await db.telemetry.record({
      type: 'hint-served',
      studentId,
      exerciseId: compositeExId,
      timestamp: new Date(),
    });

    res.json({
      exhausted: false,
      level: hintLevel,
      nextLevel: Math.min(hintLevel + 1, MAX_LEVEL),
      message: (hint as any).message || 'Look at the question again carefully.',
      hintLevel: (hint as any).hintLevel || hintLevel,
      isFallback: (hint as any).isFallback || false,
      source: (hint as any).isFallback ? 'fallback' : 'llm',
    });
  } catch (err: any) {
    res.json({
      exhausted: false,
      level: hintLevel,
      nextLevel: Math.min(hintLevel + 1, MAX_LEVEL),
      message: 'Take another look at the question. What is it really asking you to do?',
      isFallback: true,
      source: 'error-fallback',
    });
  }
});


// ─── POST /quiz — multi-question quiz submission (Phase 3.5a) ───
router.post('/quiz', requireAuth, async (req, res) => {
  const { exerciseId, answers } = req.body ?? {};
  if (typeof exerciseId !== 'string' || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'exerciseId and answers[] required.' });
  }
  const studentId = resolveActingStudentId(req, req.body.studentId);

  const ex = await db.exercises.findBySlug(exerciseId);
  if (!ex) return res.status(404).json({ error: 'Exercise not found.' });

  // Accept either new shape {questions:[...]} or legacy array (wrapped on read)
  let questions: any[] = [];
  if (ex.options && typeof ex.options === 'object' && Array.isArray((ex.options as any).questions)) {
    questions = (ex.options as any).questions;
  } else if (Array.isArray(ex.options)) {
    questions = [{
      id: 'q1',
      type: ex.exerciseType,
      text: ex.description || '',
      ...(ex.exerciseType === 'multiple_choice'
        ? { options: ex.options }
        : { answer: ((ex.options as any[])[0] || {}).correct || '' }),
    }];
  }

  if (questions.length === 0) {
    return res.status(400).json({ error: 'Exercise has no questions.' });
  }

  const attemptId = crypto.randomUUID();
  const results: Array<{ questionId: string; correct: boolean }> = [];
  let score = 0;

  const insertAnswer = sqlite.prepare(
    `INSERT INTO answers (student_id, exercise_id, selected_option_id, correct, question_id, attempt_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  for (const q of questions) {
    const submitted = answers.find((a: any) => a && a.questionId === q.id);
    let correct = false;
    let selectedId = '';

    if (q.type === 'multiple_choice') {
      selectedId = submitted?.selectedOptionId || '';
      const opt = (q.options || []).find((o: any) => o.id === selectedId);
      correct = !!(opt && opt.correct === true);
    } else if (q.type === 'predict_output') {
      const submittedText = typeof submitted?.answer === 'string' ? submitted.answer : '';
      const norm = (s: string) => s.replace(/\s*,\s*/g, ',').trim().toLowerCase();
      correct = norm(submittedText) === norm(q.answer || '');
      selectedId = 'predict:' + submittedText.trim().toLowerCase();
    }

    if (correct) score++;
    results.push({ questionId: q.id, correct });
    insertAnswer.run(studentId, ex.slug, selectedId, correct ? 1 : 0, q.id, attemptId);
  }

  // Record the attempt
  sqlite.prepare(
    `INSERT INTO quiz_attempts (id, student_id, exercise_id, score, total)
     VALUES (?, ?, ?, ?, ?)`
  ).run(attemptId, studentId, ex.slug, score, questions.length);

  // Update session: mark resolved (regardless of score, per design Q6)
  sqlite.prepare(
    `UPDATE hint_sessions
        SET last_run_matched = ?, last_run_at = datetime('now'),
            state = CASE WHEN state = 'open' THEN 'resolved' ELSE state END
      WHERE student_id = ? AND exercise_id = ?`
  ).run(score === questions.length ? 1 : 0, studentId, ex.slug);

  res.json({
    attemptId,
    score,
    total: questions.length,
    results,
    feedback: score === questions.length
      ? 'Perfect score! Now — can you explain why the answers are what they are?'
      : `You got ${score} of ${questions.length}. Review the feedback and try again when ready.`,
  });
});

router.post('/hint', requireAuth, async (req, res) => {
  const {
    exerciseId, code, language, errorOutput,
    exerciseContext, passed, hypothesis, postMortem, studentId: requested,
  } = req.body;

  const studentId = resolveActingStudentId(req, requested);

  // Dev-only: log the hint payload so we can verify lastRun reaches the LLM.
  if (req.body && req.body.lastRun) {
    console.log('[hint-debug] lastRun received:');
    console.log(JSON.stringify(req.body.lastRun, null, 2));
  }

  // Prefer the exercise stored in the DB when it exists. The client-supplied
  // context is a fallback for exercises that haven't been authored yet.
  const dbExercise = await db.exercises.findBySlug(exerciseId);
  const lastRunFromClient = (req.body && req.body.lastRun) || (exerciseContext && exerciseContext.lastRun) || null;
  const resolvedContext = dbExercise
    ? {
        title: dbExercise.title,
        description: dbExercise.description,
        learningObjectives: dbExercise.learningObjectives,
        expectedConcepts: dbExercise.expectedConcepts,
        expectedOutput: dbExercise.expectedOutput || undefined,
        lastRun: lastRunFromClient,
      }
    : {
        ...(exerciseContext || {}),
        lastRun: lastRunFromClient,
      };

  const struggleMinutes = dbExercise
    ? dbExercise.struggleMinutes
    : getStruggleMinutes(exerciseId);

  const session = await hintSessions.getOrCreate(studentId, exerciseId, {
    struggleMinutes,
  });

  // ─── Post-mortem submission path ───
  if (postMortem) {
    if (session.state !== 'resolved') {
      return res.status(400).json({
        error: 'No pending post-mortem for this session.',
      });
    }
    const recent = await db.mistakePatterns.findRecent(studentId, 1);
    const pattern = recent[0]?.pattern ?? null;
    const result = await scorePostMortem(String(postMortem), pattern);

    // Confidence: 1-5 if provided, else null. Out-of-range silently dropped.
    const rawConf = req.body.confidence;
    const confidence =
      typeof rawConf === 'number' &&
      Number.isInteger(rawConf) &&
      rawConf >= 1 && rawConf <= 5
        ? rawConf
        : null;

    await db.postMortems.record({
      sessionId: session.id,
      studentId,
      exerciseId,
      pattern,
      text: String(postMortem).trim(),
      score: result.score,
      feedback: result.feedback,
      confidence,
    });

    await db.hintSessions.update(session.id, { state: 'complete' });

    // Fire-and-forget achievement checks
    void checkAchievements(studentId, exerciseId);

    emit(studentId, 'exercise.completed', {
      exercise_id: exerciseId,
      session_id: session.id,
      pattern,
      score: result.score,
      confidence,
    });

    return res.json({
      postMortemComplete: true,
      sessionId: session.id,
      score: result.score,
      feedback: result.feedback,
      scoredBy: result.scoredBy,
    });
  }

  // ─── Session already complete ───
  if (session.state === 'complete') {
    return res.json({
      sessionComplete: true,
      sessionId: session.id,
      message: 'This session is complete. Start a new exercise to keep debugging.',
    });
  }

  // ─── Struggle gate ───
  if (session.totalAttempts === 0 && session.struggleMinutes > 0) {
    const elapsedMinutes = (Date.now() - session.createdAt.getTime()) / 60000;
    const timerExpired = elapsedMinutes >= session.struggleMinutes;
    const hasPriorSubmission = session.codeSubmissions >= 1;
    const hasCode = typeof code === 'string' && code.trim().length > 0;

    if (!timerExpired || !hasPriorSubmission) {
      if (hasCode && !hasPriorSubmission) {
        await db.hintSessions.update(session.id, {
          codeSubmissions: session.codeSubmissions + 1,
        });
      }

      const remainingSeconds = Math.max(
        0,
        Math.ceil((session.struggleMinutes - elapsedMinutes) * 60)
      );

      return res.json({
        requiresStruggle: true,
        sessionId: session.id,
        remainingSeconds,
        struggleMinutes: session.struggleMinutes,
        attemptCount: session.codeSubmissions,
        hintLevel: 1,
        prompt:
          "Give it a bit more time. You'll get more out of this if you try on your own first.",
      });
    }
  }

  // ─── Passing: mark resolved, ask for post-mortem ───
  const attempt = await hintSessions.recordAttempt(studentId, exerciseId, !!passed);
  if (attempt.resolved) {
    await db.hintSessions.update(session.id, { state: 'resolved' });
    return res.json({
      requiresPostMortem: true,
      sessionId: session.id,
      prompt:
        "Nice — that one's fixed. Before we move on: in your own words, why did the bug happen? One or two sentences is fine.",
    });
  }

  // ─── Hypothesis gate ───
  let hypothesisText: string | null = null;
  if (session.hypothesisPending) {
    if (!hypothesis || String(hypothesis).trim().length < 10) {
      return res.json({
        requiresHypothesis: true,
        sessionId: session.id,
        prompt:
          'Before I give you a hint, tell me in one sentence what you think the bug is. Start with: "I think the bug is because..."',
        hintLevel: session.currentLevel,
      });
    }
    hypothesisText = String(hypothesis).trim();
    await db.hintSessions.update(session.id, { hypothesisPending: false });
  }

  // ─── Serve the hint ───
  const started = Date.now();
  const hint = await getTutorHint({
    studentId, exerciseId, code, language, errorOutput,
    exerciseContext: resolvedContext,
    attemptNumber: session.totalAttempts,
    hypothesis: hypothesisText ?? undefined,
  });

  // ─── Score the hypothesis now that we know the detected pattern ───
  let hypothesisScore: {
    quality: string;
    feedback: string;
    scoredBy: string;
  } | null = null;

  if (hypothesisText) {
    try {
      const scored = await scoreHypothesis(
        hypothesisText,
        (hint as any).detectedPattern ?? null,
        code
      );
      hypothesisScore = {
        quality: scored.quality,
        feedback: scored.feedback,
        scoredBy: scored.scoredBy,
      };
      await db.hypotheses.record({
        studentId,
        exerciseId,
        hintLevel: session.currentLevel,
        text: hypothesisText,
        quality: scored.quality,
        scoreSource: scored.scoredBy,
      });
    } catch (err: any) {
      console.error('[hypothesisScore] failed:', err?.message ?? err);
      // Fall through: store the hypothesis without a score so we don't lose it
      await db.hypotheses.record({
        studentId,
        exerciseId,
        hintLevel: session.currentLevel,
        text: hypothesisText,
      });
    }
  }

  await db.telemetry.record({
    type: 'hint-served',
    studentId,
    exerciseId,
    latencyMs: Date.now() - started,
    timestamp: new Date(),
  });

  await db.hintSessions.update(session.id, { hypothesisPending: true });

  res.json({
    ...hint,
    sessionId: session.id,
    ...(hypothesisScore ? { hypothesisScore } : {}),
  });
});

// ─────────────────────────────────────────────────────────────
// POST /api/debug-tutor/session-events
// Records one capture event for a session (replay infrastructure).
// Only the session's owner can post events for it.
// ─────────────────────────────────────────────────────────────
const ALLOWED_EVENT_TYPES = new Set([
  'code-snapshot',
  'hint-request',
  'hint-served',
  'hypothesis-written',
  'post-mortem-saved',
  'session-completed',
]);

router.post('/session-events', requireAuth, async (req, res) => {
  const { sessionId, exerciseId, type, payload } = req.body ?? {};

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return res.status(400).json({ error: 'sessionId is required.' });
  }
  if (typeof exerciseId !== 'string' || exerciseId.length === 0) {
    return res.status(400).json({ error: 'exerciseId is required.' });
  }
  if (typeof type !== 'string' || !ALLOWED_EVENT_TYPES.has(type)) {
    return res.status(400).json({ error: 'Unknown event type.' });
  }

  // Look up the session by (caller, exercise). This doubles as the
  // ownership check — the session must belong to the current user.
  const session = await db.hintSessions.find(req.user!.id, exerciseId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found.' });
  }
  // Confirm the client-supplied sessionId matches. This prevents one
  // client from posting events to another's session (as a defence in
  // depth beyond the ownership check).
  if (session.id !== sessionId) {
    return res.status(400).json({ error: 'sessionId does not match.' });
  }

  // Cap payload size to avoid abuse
  let payloadJson: string;
  try {
    payloadJson = JSON.stringify(payload ?? {});
  } catch {
    return res.status(400).json({ error: 'Payload is not JSON-serializable.' });
  }
  if (payloadJson.length > 16 * 1024) {
    return res.status(413).json({ error: 'Payload too large (16KB max).' });
  }

  try {
    const created = db.sessionEvents.create({
      sessionId,
      studentId: session.studentId,
      exerciseId,
      type,
      payload,
    });
    res.status(201).json(created);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not record event.' });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/debug-tutor/weak-spots/:studentId
// ─────────────────────────────────────────────────────────────
router.get('/weak-spots/:studentId', requireAuth, async (req, res) => {
  const requested = req.params.studentId;
  const studentId = resolveActingStudentId(req, requested);
  res.json(await getWeakSpots(studentId));
});

// ─────────────────────────────────────────────────────────────
// GET /api/debug-tutor/session/:studentId/:exerciseId
// ─────────────────────────────────────────────────────────────
router.get('/session/:studentId/:exerciseId', requireAuth, async (req, res) => {
  const requested = req.params.studentId;
  const studentId = resolveActingStudentId(req, requested);
  const { exerciseId } = req.params;

  const session = await db.hintSessions.find(studentId, exerciseId);
  const exercise = await db.exercises.findBySlug(exerciseId);
  const hasGoal = !!(exercise?.expectedOutput || '').trim();

  if (!session) {
    return res.json({
      id: null,
      state: 'open',
      currentLevel: 1,
      hypothesisPending: true,
      lastRunMatched: null,
      hasGoal,
    });
  }
  // If the last run doesn't match, the student hasn't fixed it —
  // demote stale 'resolved'/'complete' back to 'open' for the UI.
  const effectiveState = (session.lastRunMatched !== true && (session.state === 'resolved' || session.state === 'complete'))
    ? 'open'
    : session.state;

  res.json({
    id: session.id,
    state: effectiveState,
    currentLevel: session.currentLevel,
    hypothesisPending: session.hypothesisPending,
    lastRunMatched: session.lastRunMatched,
    hasGoal,
  });
});

export default router;
