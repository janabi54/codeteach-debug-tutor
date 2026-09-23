import express from 'express';
import { getTutorHint } from '../debugTutor/tutorService.js';
import { scorePostMortem } from '../debugTutor/postMortem.js';
import { HintSessionManager } from '../debugTutor/hintSession.js';
import { getWeakSpots } from '../debugTutor/weakSpots.js';
import { db } from '../db.js';

const router = express.Router();
const hintSessions = new HintSessionManager();

router.post('/hint', async (req, res) => {
  const {
    studentId, exerciseId, code, language, errorOutput,
    exerciseContext, passed, hypothesis, postMortem,
  } = req.body;

  const session = await hintSessions.getOrCreate(studentId, exerciseId);

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
      score: result.score,
      feedback: result.feedback,
      scoredBy: result.scoredBy,
    });
  }

  // ─── Session already complete: refuse further hints ───
  if (session.state === 'complete') {
    return res.json({
      sessionComplete: true,
      message: 'This session is finished. Start a new exercise to keep going.',
    });
  }

  // ─── Passing: mark resolved, ask for post-mortem ───
  const attempt = await hintSessions.recordAttempt(studentId, exerciseId, !!passed);
  if (attempt.resolved) {
    await db.hintSessions.update(session.id, { state: 'resolved' });
    return res.json({
      requiresPostMortem: true,
      prompt:
        "Nice — that one's fixed. Before we move on: in your own words, why did the bug happen? One or two sentences is fine.",
    });
  }

  // ─── Hypothesis gate ───
  if (session.hypothesisPending) {
    if (!hypothesis || String(hypothesis).trim().length < 10) {
      return res.json({
        requiresHypothesis: true,
        prompt:
          'Before I give you a hint, tell me in one sentence what you think the bug is. Start with: "I think the bug is because..."',
        hintLevel: session.currentLevel,
      });
    }

    await db.hypotheses.record({
      studentId,
      exerciseId,
      hintLevel: session.currentLevel,
      text: String(hypothesis).trim(),
    });
    await db.hintSessions.update(session.id, { hypothesisPending: false });
  }

  // ─── Serve the hint ───
  const started = Date.now();
  const hint = await getTutorHint({
    studentId, exerciseId, code, language, errorOutput, exerciseContext,
    attemptNumber: session.totalAttempts,
    hypothesis: hypothesis ? String(hypothesis).trim() : undefined,
  });

  await db.telemetry.record({
    type: 'hint-served',
    studentId,
    exerciseId,
    latencyMs: Date.now() - started,
    timestamp: new Date(),
  });

  await db.hintSessions.update(session.id, { hypothesisPending: true });

  res.json(hint);
});

router.get('/weak-spots/:studentId', async (req, res) => {
  res.json(await getWeakSpots(req.params.studentId));
});

router.get('/session/:studentId/:exerciseId', async (req, res) => {
  const { studentId, exerciseId } = req.params;
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
