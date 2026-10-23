import express from 'express';
import { sqlite } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// Phase 4.0: public exercise endpoints (any authenticated user)
// Mounted at /api/exercises
// ─────────────────────────────────────────────────────────────

// GET /api/exercises/public — list all public exercises
router.get('/public', requireAuth, async (req, res) => {
  try {
    const rows = sqlite.prepare(`
      SELECT e.id, e.slug, e.title, e.description, e.language, e.exercise_type,
             e.options_json, e.starter_code, e.expected_concepts, e.expected_output,
             e.struggle_minutes, e.created_by, e.created_at,
             u.email AS creatorEmail
      FROM exercises e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE e.is_public = 1
      ORDER BY e.created_at DESC
    `).all() as Array<any>;
    const out = rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description || '',
      language: r.language,
      exerciseType: r.exercise_type || 'code',
      options: (() => { try { return JSON.parse(r.options_json || '[]'); } catch { return []; } })(),
      starterCode: r.starter_code || '',
      expectedConcepts: (() => { try { return JSON.parse(r.expected_concepts || '[]'); } catch { return []; } })(),
      expectedOutput: r.expected_output || '',
      struggleMinutes: r.struggle_minutes || 0,
      creatorEmail: r.creatorEmail || null,
      createdAt: r.created_at,
    }));
    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Could not list public exercises.' });
  }
});

export default router;
