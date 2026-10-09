import express from 'express';
import { getDebugTutorHealth } from '../admin/healthService.js';
import { getClassFingerprint } from '../admin/classFingerprint.js';
import { getCohortAnalytics } from '../admin/cohortAnalytics.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { generateInviteCode } from '../auth/inviteCodes.js';
import { db } from '../db.js';

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
  res.json({ ok: true });
});

export default router;
