import express from 'express';
import { getDebugTutorHealth } from '../admin/healthService.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.get('/health/debug-tutor', requireAdmin, async (req, res) => {
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  res.json(await getDebugTutorHealth(hours));
});
export default router;
