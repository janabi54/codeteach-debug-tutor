import express from 'express';
import { getDebugTutorHealth } from '../admin/healthService.js';
import { getClassFingerprint } from '../admin/classFingerprint.js';
import { getCohortAnalytics } from '../admin/cohortAnalytics.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { generateInviteCode } from '../auth/inviteCodes.js';
import { db } from '../db.js';
import { sqlite } from '../db.js';
import { newSecret } from '../webhooks/outbound/events.js';

const router = express.Router();

router.get('/health/debug-tutor', requireInstructor, async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(await getDebugTutorHealth(hours));
});

router.get('/class-fingerprint', requireInstructor, async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 168));
  const cohort = await db.cohorts.ensureForInstructor(req.user!.id);
  res.json(await getClassFingerprint(hours, cohort.id));
});

// ─────────────────────────────────────────────────────────────
// GET /api/admin/analytics/:cohortId
// Cohort-level analytics for the Analytics tab.
// Instructor must own the cohort.
// ─────────────────────────────────────────────────────────────
router.get('/analytics/:cohortId', requireInstructor, async (req, res) => {
  const { cohortId } = req.params;
  const cohort = await db.cohorts.findById(cohortId);
  if (!cohort) {
    return res.status(404).json({ error: 'Cohort not found.' });
  }
  if (cohort.instructorId !== req.user!.id) {
    return res.status(403).json({ error: 'You do not teach this cohort.' });
  }
  try {
    const data = getCohortAnalytics(cohortId);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not compute analytics.' });
  }
});

// ── Invite codes ──

router.post('/invite-codes', requireAdmin, async (req, res) => {
  const { role, expiresInDays } = req.body ?? {};
  const desiredRole = role === 'student' ? 'student' : 'instructor';
  const days =
    typeof expiresInDays === 'number' && expiresInDays > 0
      ? Math.min(365, expiresInDays)
      : 30;
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    const existing = await db.inviteCodes.find(code);
    if (existing) continue;
    const created = await db.inviteCodes.create({
      code,
      role: desiredRole,
      createdBy: req.user?.id ?? null,
      expiresAt,
    });

    // Audit: who minted what, when
    db.inviteAudit.record({
      actorId: req.user!.id,
      actorEmail: req.user!.email ?? null,
      code,
      role: desiredRole,
      expiresAt: expiresAt.toISOString(),
    });
    db.audit.record({
      actorId: req.user!.id,
      actorEmail: req.user!.email ?? null,
      action: 'invite.create',
      targetType: 'invite_code',
      targetId: code,
      targetLabel: desiredRole,
      metadata: { expiresAt: expiresAt.toISOString() },
    });

    return res.status(201).json({ inviteCode: created });
  }
  res.status(500).json({ error: 'Could not generate a unique code. Try again.' });
});

router.get('/invite-codes', requireAdmin, async (_req, res) => {
  res.json(await db.inviteCodes.list());
});

router.delete('/invite-codes/:code', requireAdmin, async (req, res) => {
  const deleted = await db.inviteCodes.delete(req.params.code);
  if (!deleted) {
    return res.status(404).json({ error: 'Code not found or already used.' });
  }
  db.audit.record({
    actorId: req.user!.id,
    actorEmail: req.user!.email ?? null,
    action: 'invite.revoke',
    targetType: 'invite_code',
    targetId: req.params.code,
  });
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// Study groups (tutor-facing)
// ─────────────────────────────────────────────────────────────

// GET /api/admin/cohorts/:cohortId/groups
router.get('/cohorts/:cohortId/groups', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { cohortId } = req.params;
  const cohort = await db.cohorts.findById(cohortId);
  if (!cohort) return res.status(404).json({ error: 'Cohort not found.' });
  if (cohort.instructorId !== instructorId) {
    return res.status(403).json({ error: 'You do not teach this cohort.' });
  }
  res.json({ groups: db.studyGroups.listForCohort(cohortId) });
});

// POST /api/admin/groups/:groupId/approve
router.post('/groups/:groupId/approve', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { groupId } = req.params;
  const group = db.studyGroups.findById(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const cohort = await db.cohorts.findById(group.cohortId);
  if (!cohort || cohort.instructorId !== instructorId) {
    return res.status(403).json({ error: 'You do not teach this cohort.' });
  }
  const ok = db.studyGroups.setStatus(groupId, 'approved', instructorId);
  if (!ok) return res.status(400).json({ error: 'Group is not pending.' });
  db.audit.record({
    actorId: instructorId,
    actorEmail: req.user!.email ?? null,
    action: 'study_group.approve',
    targetType: 'study_group',
    targetId: groupId,
    targetLabel: group.name,
  });
  res.json({ ok: true, status: 'approved' });
});

// POST /api/admin/groups/:groupId/reject
router.post('/groups/:groupId/reject', requireInstructor, async (req, res) => {
  const instructorId = req.user!.id;
  const { groupId } = req.params;
  const group = db.studyGroups.findById(groupId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const cohort = await db.cohorts.findById(group.cohortId);
  if (!cohort || cohort.instructorId !== instructorId) {
    return res.status(403).json({ error: 'You do not teach this cohort.' });
  }
  const ok = db.studyGroups.setStatus(groupId, 'rejected', instructorId);
  if (!ok) return res.status(400).json({ error: 'Group is not pending.' });
  db.audit.record({
    actorId: instructorId,
    actorEmail: req.user!.email ?? null,
    action: 'study_group.reject',
    targetType: 'study_group',
    targetId: groupId,
    targetLabel: group.name,
  });
  res.json({ ok: true, status: 'rejected' });
});

// GET /api/admin/audit?limit=100
// Read-only. Each instructor sees their OWN actions (the trail
// is scoped to the caller). System-wide view would be a separate
// admin-only route if ever needed.
router.get('/audit', requireInstructor, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  res.json({ entries: db.audit.listForActor(req.user!.id, limit) });
});

export default router;

// ─────────────────────────────────────────────────────────────
// Webhooks — admin-only CRUD for outbound subscriptions and
// inbound endpoints, plus delivery/event inspection.
// ─────────────────────────────────────────────────────────────


// ── Outbound subscriptions ──────────────────────────────────

router.get('/webhook-subscriptions', requireAdmin, (_req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT id, cohort_id, url, event_types, active, created_by, created_at
         FROM webhook_subscriptions
        ORDER BY created_at DESC`
    )
    .all();
  res.json(rows);
});

router.post('/webhook-subscriptions', requireAdmin, (req, res) => {
  const { cohort_id, url, event_types } = req.body ?? {};
  if (!cohort_id || typeof cohort_id !== 'string') {
    return res.status(400).json({ error: 'cohort_id is required' });
  }
  if (!url || typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: 'url must be an http(s) URL' });
  }
  if (!Array.isArray(event_types) || event_types.length === 0) {
    return res.status(400).json({ error: 'event_types must be a non-empty array' });
  }

  const secret = newSecret();
  const info = sqlite
    .prepare(
      `INSERT INTO webhook_subscriptions
         (cohort_id, url, secret, event_types, active, created_by)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(cohort_id, url, secret, JSON.stringify(event_types), req.user!.id);

  // The secret is shown exactly once. Client must copy it now.
  res.json({
    id: info.lastInsertRowid,
    secret,
    note: 'Store this secret now. It will not be shown again.',
  });
});

router.delete('/webhook-subscriptions/:id', requireAdmin, (req, res) => {
  const info = sqlite
    .prepare('DELETE FROM webhook_subscriptions WHERE id = ?')
    .run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

router.post('/webhook-subscriptions/:id/test', requireAdmin, (req, res) => {
  const sub = sqlite
    .prepare('SELECT id, cohort_id FROM webhook_subscriptions WHERE id = ?')
    .get(Number(req.params.id)) as { id: number; cohort_id: string } | undefined;
  if (!sub) return res.status(404).json({ error: 'not found' });

  // We bypass emit() because emit resolves cohorts from a student. The
  // test fire inserts a delivery directly against this subscription.
  const eventId = 'test-' + Date.now().toString(36);
  const payload = JSON.stringify({
    id: eventId,
    type: 'webhook.test',
    cohort_id: sub.cohort_id,
    occurred_at: new Date().toISOString(),
    data: { message: 'This is a test delivery from CodeTeach.' },
  });
  sqlite
    .prepare(
      `INSERT INTO webhook_deliveries
         (subscription_id, event_type, event_id, payload, status, attempts, next_attempt_at)
       VALUES (?, 'webhook.test', ?, ?, 'pending', 0, datetime('now'))`
    )
    .run(sub.id, eventId, payload);

  res.json({ ok: true, event_id: eventId });
});

// ── Outbound deliveries ─────────────────────────────────────

router.get('/webhook-deliveries', requireAdmin, (req, res) => {
  const subscriptionId = req.query.subscription_id
    ? Number(req.query.subscription_id)
    : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const rows = subscriptionId
    ? sqlite
        .prepare(
          `SELECT id, subscription_id, event_type, event_id, status, attempts,
                  last_status, last_error, created_at, delivered_at
             FROM webhook_deliveries
            WHERE subscription_id = ?
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(subscriptionId, limit)
    : sqlite
        .prepare(
          `SELECT id, subscription_id, event_type, event_id, status, attempts,
                  last_status, last_error, created_at, delivered_at
             FROM webhook_deliveries
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(limit);
  res.json(rows);
});

router.post('/webhook-deliveries/:id/redeliver', requireAdmin, (req, res) => {
  const info = sqlite
    .prepare(
      `UPDATE webhook_deliveries
          SET status = 'pending',
              attempts = 0,
              next_attempt_at = datetime('now'),
              last_status = NULL,
              last_error = NULL,
              delivered_at = NULL
        WHERE id = ?`
    )
    .run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── Inbound endpoints ───────────────────────────────────────

router.get('/webhook-endpoints', requireAdmin, (_req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT id, slug, provider, cohort_id, active, created_by, created_at
         FROM webhook_endpoints
        ORDER BY created_at DESC`
    )
    .all();
  res.json(rows);
});

router.post('/webhook-endpoints', requireAdmin, (req, res) => {
  const { provider, cohort_id } = req.body ?? {};
  if (provider !== 'generic' && provider !== 'github') {
    return res.status(400).json({ error: 'provider must be generic or github' });
  }
  if (cohort_id != null && typeof cohort_id !== 'string') {
    return res.status(400).json({ error: 'cohort_id must be a string or omitted' });
  }

  const slug = (provider === 'github' ? 'gh-' : 'wh-') +
    newSecret().slice(0, 12);
  const secret = newSecret();

  const info = sqlite
    .prepare(
      `INSERT INTO webhook_endpoints
         (slug, provider, secret, cohort_id, active, created_by)
       VALUES (?, ?, ?, ?, 1, ?)`
    )
    .run(slug, provider, secret, cohort_id ?? null, req.user!.id);

  res.json({
    id: info.lastInsertRowid,
    slug,
    secret,
    url_path: '/webhooks/in/' + slug,
    note: 'Store this secret now. It will not be shown again.',
  });
});

router.delete('/webhook-endpoints/:id', requireAdmin, (req, res) => {
  const info = sqlite
    .prepare('DELETE FROM webhook_endpoints WHERE id = ?')
    .run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── Inbound events ──────────────────────────────────────────

router.get('/webhook-inbound-events', requireAdmin, (req, res) => {
  const endpointId = req.query.endpoint_id
    ? Number(req.query.endpoint_id)
    : null;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));

  const rows = endpointId
    ? sqlite
        .prepare(
          `SELECT id, endpoint_id, provider, external_id, event_type,
                  signature_ok, processed, process_error, received_at
             FROM webhook_inbound_events
            WHERE endpoint_id = ?
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(endpointId, limit)
    : sqlite
        .prepare(
          `SELECT id, endpoint_id, provider, external_id, event_type,
                  signature_ok, processed, process_error, received_at
             FROM webhook_inbound_events
            ORDER BY id DESC
            LIMIT ?`
        )
        .all(limit);
  res.json(rows);
});
