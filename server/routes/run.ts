import express from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { db, sqlite } from '../db.js';
import { runPython } from '../exec/runner.js';

const router = express.Router();

/**
 * POST /api/run
 * Body: { exerciseSlug, code, prediction? }
 * Response: RunResult + runId
 */
router.post('/run', requireAuth, async (req, res) => {
  const { exerciseSlug, code, prediction } = req.body ?? {};

  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ error: 'code is required' });
  }
  if (code.length > 10_000) {
    return res.status(400).json({ error: 'code is too long (max 10KB)' });
  }

  // Resolve the exercise (optional — runs can be freeform)
  let exerciseId: string | null = null;
  let expectedOutput: string | null = null;
  if (typeof exerciseSlug === 'string') {
    const ex = await db.exercises.findBySlug(exerciseSlug);
    if (ex) {
      exerciseId = ex.id;
      expectedOutput = ex.expectedOutput ?? null;
    }
  }

  // Run the code
  let result;
  try {
    result = await runPython(code);
  } catch (err: any) {
    return res.status(500).json({ error: 'execution failed: ' + err.message });
  }

  // Persist the run
  const hasRealExpected = typeof expectedOutput === 'string' && expectedOutput.trim().length > 0;
  const matched = hasRealExpected
    ? (normalize(result.stdout) === normalize(expectedOutput!) ? 1 : 0)
    : null;

  const info = sqlite
    .prepare(
      `INSERT INTO runs
        (student_id, exercise_id, code, prediction, stdout, stderr, trace,
         exit_code, timed_out, matched_expected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.user!.id,
      exerciseId,
      code,
      typeof prediction === 'string' ? prediction : null,
      result.stdout,
      result.stderr,
      JSON.stringify(result.trace),
      result.exitCode,
      result.timedOut ? 1 : 0,
      matched
    );

  // Update hint_sessions.last_run_matched so the existing #fixedBtn gate works.
  // 1 if matched, 0 otherwise (always write, so a stale match doesn't survive).
  if (exerciseId) {
    sqlite
      .prepare(
        `UPDATE hint_sessions
            SET last_run_matched = ?, last_run_at = datetime('now')
          WHERE student_id = ? AND exercise_id = ?`
      )
      .run(matched === 1 ? 1 : 0, req.user!.id, exerciseSlug);

  // If the run doesn't match, the student hasn't fixed it — demote any
  // 'resolved' session back to 'open' so the post-mortem prompt goes away.
  if (matched !== 1) {
    sqlite.prepare(
      `UPDATE hint_sessions
          SET state = 'open'
        WHERE student_id = ? AND exercise_id = ? AND state = 'resolved'`
    ).run(req.user!.id, exerciseSlug);
  }
  }

  res.json({
    runId: Number(info.lastInsertRowid),
    stdout: result.stdout,
    stderr: result.stderr,
    trace: result.trace,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    syntaxError: result.syntaxError,
    matched,
    expectedOutput,
  });
});

function normalize(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

export default router;
