import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// GET /api/me/progress
// Student-facing aggregate view, scoped to the caller.
//
// Composes existing db.students helpers — the only new query is
// deriving the student's exercise list. detailFor() already
// computes metrics, weak spots, trends, strengths, and recent
// sessions; we reshape and return them.
// ─────────────────────────────────────────────────────────────
router.get('/me/progress', requireAuth, async (req, res) => {
  const studentId = req.user!.id;

  const exerciseIds = db.students.exerciseSlugsForStudent(studentId);
  const stats       = db.students.statsFor(studentId, exerciseIds);
  const detail      = db.students.detailFor(studentId, exerciseIds);
  const activity    = db.students
    .activityForMany([studentId], exerciseIds, 90)
    .get(studentId);

  const assigned  = exerciseIds.length;
  const completed = stats.exercisesCompleted;
  const rq = detail.metrics.reasoningQuality;

  res.json({
    summary: {
      assigned,
      completed,
      progressPct: assigned > 0 ? Math.round((completed / assigned) * 100) : 0,
      reasoningPct: rq.total > 0 ? Math.round((rq.precise / rq.total) * 100) : null,
      avgHintsPerSession: detail.metrics.hintDependency.avgHintsPerSession,
      currentStreak: activity ? activity.currentStreak : 0,
      longestStreak: activity ? activity.longestStreak : 0,
      totalStruggleMinutes: detail.timeMetrics.totalStruggleMinutes,
    },
    weakSpots: detail.weakSpots,
    strengths: detail.strengths,
    trends: detail.trends,
    hypothesisOutcomes: detail.hypothesisOutcomes,
    recentSessions: detail.sessionHistory
      .slice()
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, 5),
  });
});

export default router;
