import express from 'express';
import { db, sqlite } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { broadcastToUser } from '../websocket.js';
import { deriveStudentNextAction } from '../util/nextAction.js';
import { deriveRosterStatus } from '../util/status.js';

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

  // ── Next action (student-facing) ─────────────────────────────
  const rosterStatus = deriveRosterStatus({
    exercisesAttempted: stats.exercisesAttempted,
    exercisesCompleted: stats.exercisesCompleted,
    lastActiveAt: stats.lastActiveAt,
  });
  const viewableExercises = db.students.exercisesForStudent(studentId);
  const nextAction = deriveStudentNextAction({
    status: rosterStatus.status,
    statusReasons: rosterStatus.reasons,
    studentName: req.user!.displayName,
    viewableExercises,
    sessionHistory: detail.sessionHistory,
    weakSpots: detail.weakSpots,
    unlockedConcepts: db.concepts.forStudent(studentId).unlocked.map((c) => c.slug),
  });

  res.json({
    nextAction,
    confidenceSummary: db.postMortems.postMortemConfidenceFor(studentId),
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

// ─────────────────────────────────────────────────────────────
// Study groups (student-facing)
// ─────────────────────────────────────────────────────────────

// POST /api/me/groups  { name, cohortId }
// ─────────────────────────────────────────────────────────────
// GET /api/me/concepts
// Student-facing concept journey: unlocked / in-progress / locked,
// derived from completed and pending hint_sessions against the
// concepts each exercise teaches. All-time, all-cohorts.
// ─────────────────────────────────────────────────────────────
router.get('/me/concepts', requireAuth, (req, res) => {
  const studentId = req.user!.id;
  res.json(db.concepts.forStudent(studentId));
});

router.post('/me/groups', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { name, cohortId } = req.body as { name?: string; cohortId?: string };

  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return res.status(400).json({ error: 'Group name is required.' });
  if (trimmed.length > 40) return res.status(400).json({ error: 'Group name must be 40 characters or fewer.' });
  if (!cohortId) return res.status(400).json({ error: 'cohortId is required.' });

  // Caller must be a member of the cohort.
  const member = sqlite
    .prepare('SELECT 1 AS ok FROM cohort_members WHERE cohort_id = ? AND user_id = ?')
    .get(cohortId, userId) as { ok: number } | undefined;
  if (!member) return res.status(403).json({ error: 'You are not in this cohort.' });

  const { id, inviteCode } = db.studyGroups.create({ cohortId, name: trimmed, createdBy: userId });
  res.status(201).json({
    ok: true,
    group: { id, name: trimmed, inviteCode, status: 'pending' },
  });
});

// GET /api/me/groups
// ─────────────────────────────────────────────────────────────
// GET/PUT /api/me/notification-prefs
// Per-user email opt-out. In-app notifications are always on.
// ─────────────────────────────────────────────────────────────
router.get('/me/notification-prefs', requireAuth, (req, res) => {
  res.json(db.users.getNotificationPrefs(req.user!.id));
});

router.put('/me/notification-prefs', requireAuth, (req, res) => {
  const { emailNudges, emailAnnouncements } = req.body ?? {};
  if (typeof emailNudges !== 'boolean' || typeof emailAnnouncements !== 'boolean') {
    return res.status(400).json({ error: 'Both flags must be booleans.' });
  }
  db.users.setNotificationPrefs(req.user!.id, { emailNudges, emailAnnouncements });
  res.json({ ok: true });
});

router.get('/me/groups', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  res.json({ groups: db.studyGroups.listForUser(userId) });
});

// POST /api/me/groups/join  { code }
router.post('/me/groups/join', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { code } = req.body as { code?: string };
  if (typeof code !== 'string' || code.trim().length === 0) {
    return res.status(400).json({ error: 'Group code is required.' });
  }
  const result = db.studyGroups.addMemberByCode(code.trim().toUpperCase(), userId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true, groupId: result.groupId });
});

// GET /api/me/groups/:groupId
router.get('/me/groups/:groupId', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  const group = db.studyGroups.findById(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  res.json({ group, members: db.studyGroups.listMembers(groupId) });
});

// ── Study group chat ──

const MAX_CHAT_BODY = 2000;

// GET /api/me/groups/:groupId/messages?before=<id>&limit=50
router.get('/me/groups/:groupId/messages', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  const before = typeof req.query.before === 'string' && req.query.before.length > 0 ? req.query.before : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const page = db.studyGroups.listMessages({ groupId, before, limit });
  res.json(page);
});

// POST /api/me/groups/:groupId/messages  { body }
router.post('/me/groups/:groupId/messages', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  const raw = (req.body as { body?: string }).body ?? '';
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return res.status(400).json({ error: 'Message body is required.' });
  if (trimmed.length > MAX_CHAT_BODY) {
    return res.status(400).json({ error: 'Message body must be ' + MAX_CHAT_BODY + ' characters or fewer.' });
  }

  const message = db.studyGroups.postMessage({ groupId, authorId: userId, body: trimmed });
  const author = await db.users.findById(userId);

  // Broadcast to every member (including the author, for cross-tab sync).
  const members = db.studyGroups.listMembers(groupId);
  for (const m of members) {
    broadcastToUser(m.userId, {
      type: 'study-group:message',
      groupId,
      message: {
        id: message.id,
        authorId: message.authorId,
        authorName: author?.displayName ?? 'Someone',
        body: message.body,
        createdAt: message.createdAt,
      },
    });
  }

  res.status(201).json({
    message: {
      id: message.id,
      groupId: message.groupId,
      authorId: message.authorId,
      authorName: author?.displayName ?? 'Someone',
      body: message.body,
      createdAt: message.createdAt,
    },
  });
});

// DELETE /api/me/groups/messages/:messageId
router.delete('/me/groups/messages/:messageId', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { messageId } = req.params;
  const ok = db.studyGroups.deleteMessage(messageId, userId);
  if (!ok) return res.status(404).json({ error: 'Message not found, or you are not its author.' });
  res.json({ ok: true });
});

// POST /api/me/groups/:groupId/mark-read
router.post('/me/groups/:groupId/mark-read', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  db.studyGroups.markRead(groupId, userId);
  res.json({ ok: true });
});

// GET /api/me/groups/:groupId/feed
router.get('/me/groups/:groupId/feed', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  const group = db.studyGroups.findById(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const feed = db.studyGroups.feedFor(groupId, { days, limit });
  res.json({ feed });
});

// POST /api/me/groups/:groupId/leave
router.post('/me/groups/:groupId/leave', requireAuth, async (req, res) => {
  const userId = req.user!.id;
  const { groupId } = req.params;
  if (!db.studyGroups.isMember(groupId, userId)) {
    return res.status(403).json({ error: 'You are not in this group.' });
  }
  db.studyGroups.leave(groupId, userId);
  res.json({ ok: true });
});

export default router;
