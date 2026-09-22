import express from 'express';
import { getTutorHint } from '../debugTutor/tutorService.js';
import { HintSessionManager } from '../debugTutor/hintSession.js';
import { getWeakSpots } from '../debugTutor/weakSpots.js';
import { db } from '../db.js';

const router = express.Router();
const hintSessions = new HintSessionManager();

router.post('/hint', async (req, res) => {
  const {
    studentId, exerciseId, code, language, errorOutput,
    exerciseContext, passed, hypothesis,
  } = req.body;

  const session = await hintSessions.getOrCreate(studentId, exerciseId);

  console.log('[debug] hint request:', JSON.stringify({
    studentId, exerciseId,
    language,
    codeLength: code?.length,
    codePreview: typeof code === 'string' ? code.slice(0, 80) : code,
    errorLength: errorOutput?.length,
    errorPreview: typeof errorOutput === 'string' ? errorOutput.slice(0, 80) : errorOutput,
    hasHypothesis: !!hypothesis,
    hypothesisPreview: hypothesis ? String(hypothesis).slice(0, 60) : null,
  }));

  const attempt = await hintSessions.recordAttempt(studentId, exerciseId, !!passed);
  if (attempt.resolved) {
    return res.json({ resolved: true, message: 'Nice — you got it!' });
  }

  // Gate: every hint request requires a fresh hypothesis.
  if (session.hypothesisPending) {
    if (!hypothesis || String(hypothesis).trim().length < 10) {
      return res.json({
        requiresHypothesis: true,
        prompt:
          'Before I give you a hint, tell me in one sentence what you think the bug is. Start with: \"I think the bug is because...\"',
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

  // Re-arm the gate for the NEXT hint request.
  await db.hintSessions.update(session.id, { hypothesisPending: true });

  res.json(hint);
});

router.get('/weak-spots/:studentId', async (req, res) => {
  res.json(await getWeakSpots(req.params.studentId));
});

export default router;
