import express from 'express';
import { getDebugTutorHealth } from '../admin/healthService.js';
import { getClassFingerprint } from '../admin/classFingerprint.js';
import { requireInstructor } from '../middleware/requireAuth.js';

const router = express.Router();

router.get('/health/debug-tutor', requireInstructor, async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(await getDebugTutorHealth(hours));
});

router.get('/class-fingerprint', requireInstructor, async (req, res) => {
  const hours = Math.min(720, Math.max(1, Number(req.query.hours) || 168));
  res.json(await getClassFingerprint(hours));
});

export default router;
