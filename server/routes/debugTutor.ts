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

    // TODO: streaks — needs an activity source. Deferred to next patch.
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
