import express from 'express';
import { getTutorHint } from '../debugTutor/tutorService.js';
import { scorePostMortem } from '../debugTutor/postMortem.js';
import { scoreHypothesis } from '../debugTutor/hypothesisScore.js';
import { HintSessionManager } from '../debugTutor/hintSession.js';
import { getStruggleMinutes } from '../debugTutor/exerciseConfig.js';
import { getWeakSpots } from '../debugTutor/weakSpots.js';
import { db } from '../db.js';
import {
  requireAuth,
  resolveActingStudentId,
} from '../middleware/requireAuth.js';

const router = express.Router();
const hintSessions = new HintSessionManager();

// ─────────────────────────────────────────────────────────────
// POST /api/debug-tutor/hint
// ─────────────────────────────────────────────────────────────
router.post('/hint', requireAuth, async (req, res) => {
  const {
    exerciseId, code, language, errorOutput,
    exerciseContext, passed, hypothesis, postMortem, studentId: requested,
  } = req.body;

  const studentId = resolveActingStudentId(req, requested);

  // Prefer the exercise stored in the DB when it exists. The client-supplied
  // context is a fallback for exercises that haven't been authored yet.
  const dbExercise = await db.exercises.findBySlug(exerciseId);
  const resolvedContext = dbExercise
    ? {
        title: dbExercise.title,
        description: dbExercise.description,
        learningObjectives: dbExercise.learningObjectives,
        expectedConcepts: dbExercise.expectedConcepts,
      }
    : exerciseContext;

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

    await db.postMortems.record({
      sessionId: session.id,
      studentId,
      exerciseId,
      pattern,
      text: String(postMortem).trim(),
      score: result.score,
      feedback: result.feedback,
    });

    await db.hintSessions.update(session.id, { state: 'complete' });

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
      message: 'This session is finished. Start a new exercise to keep going.',
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
  if (!session) {
    return res.json({ state: 'open', currentLevel: 1, hypothesisPending: true });
  }
  res.json({
    state: session.state,
    currentLevel: session.currentLevel,
    hypothesisPending: session.hypothesisPending,
  });
});

export default router;
