import express from 'express';
import { getDebugTutorHealth } from '../admin/healthService.js';
import { getClassFingerprint } from '../admin/classFingerprint.js';
import { requireInstructor } from '../middleware/requireAuth.js';
import { generateInviteCode } from '../auth/inviteCodes.js';
import { db } from '../db.js';

const router = express.Router();

router.get('/health/debug-tutor', requireInstructor, async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(await getDebugTutorHealth(hours));
});

router.get('/class-fingerprint', requireInstructor, async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 168));
  res.json(await getClassFingerprint(hours));
});

// ── Invite codes ──

router.post('/invite-codes', requireInstructor, async (req, res) => {
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
    return res.status(201).json({ inviteCode: created });
  }
  res.status(500).json({ error: 'Could not generate a unique code. Try again.' });
});

router.get('/invite-codes', requireInstructor, async (_req, res) => {
  res.json(await db.inviteCodes.list());
});

router.delete('/invite-codes/:code', requireInstructor, async (req, res) => {
  const deleted = await db.inviteCodes.delete(req.params.code);
  if (!deleted) {
    return res.status(404).json({ error: 'Code not found or already used.' });
  }
  res.json({ ok: true });
});

export default router;
