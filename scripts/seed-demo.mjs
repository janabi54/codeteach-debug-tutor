#!/usr/bin/env node
/**
 * Seed demo data for a single student (Jiro) in CS101 Fall 2026.
 *
 * Creates:
 *   - Exercise "ex-demo-1" in CS101 Fall 2026 (idempotent — skip if exists)
 *   - 9 hypotheses across 8 weeks (vague → plausible → precise progression)
 *   - 3 completed hint_sessions spread across weeks
 *   - 3 post_mortems (2 strong, 1 partial)
 *   - 3 mistake_patterns (off-by-one x2, null-undefined x1)
 *
 * All seed rows are tagged so re-running this script is safe: it deletes
 * prior seed rows first, then re-inserts. Seed tags:
 *   - hypotheses.text        starts with "[seed]"
 *   - hint_sessions.id       starts with "seed-sess-"
 *   - post_mortems.text      starts with "[seed]"
 *   - mistake_patterns.source = "seed"
 *
 * Usage:
 *   node scripts/seed-demo.mjs
 *   node scripts/seed-demo.mjs --wipe     # just delete seed data, don't re-insert
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const WIPE_ONLY = process.argv.includes('--wipe');

// ── Config ────────────────────────────────────────────────────────────
const STUDENT_ID = '75987245-0755-4efe-a264-03b799761a1b'; // Jiro
const COHORT_NAME = 'CS101 Fall 2026';
const EXERCISE_SLUG = 'ex-demo-1';
const EXERCISE_TITLE = 'Demo: Trend Showcase';

// ── Open DB ───────────────────────────────────────────────────────────
const db = new Database('codeteach.db');

// ── Resolve cohort ────────────────────────────────────────────────────
const cohort = db
  .prepare('SELECT id, name FROM cohorts WHERE name = ?')
  .get(COHORT_NAME);
if (!cohort) {
  console.error(`ERROR: cohort "${COHORT_NAME}" not found.`);
  process.exit(1);
}

// ── Wipe prior seed data ──────────────────────────────────────────────
function wipeSeedData() {
  const h = db
    .prepare("DELETE FROM hypotheses WHERE text LIKE '[seed]%'")
    .run();
  const p = db
    .prepare("DELETE FROM post_mortems WHERE text LIKE '[seed]%'")
    .run();
  const m = db
    .prepare("DELETE FROM mistake_patterns WHERE source = 'seed'")
    .run();

  // hint_sessions was seeded under both the UUID and (later) the slug,
  // so wipe by either form. Also catch any rows id'd with the seed prefix.
  const s = db
    .prepare(
      `DELETE FROM hint_sessions
       WHERE id LIKE 'seed-sess-%'
          OR (student_id = ? AND exercise_id IN (
                SELECT id FROM exercises WHERE slug = ?
                UNION
                SELECT slug FROM exercises WHERE slug = ?
             ))`
    )
    .run(STUDENT_ID, EXERCISE_SLUG, EXERCISE_SLUG);

  console.log(
    `Wiped prior seed rows: hypotheses=${h.changes} hint_sessions=${s.changes} post_mortems=${p.changes} mistake_patterns=${m.changes}`
  );
}

wipeSeedData();
if (WIPE_ONLY) {
  console.log('Wipe-only mode: done.');
  process.exit(0);
}

// ── Ensure exercise exists ────────────────────────────────────────────
let exercise = db
  .prepare('SELECT * FROM exercises WHERE slug = ?')
  .get(EXERCISE_SLUG);

if (!exercise) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO exercises
       (id, slug, title, description, language, cohort_id)
     VALUES (?, ?, ?, ?, 'javascript', ?)`
  ).run(
    id,
    EXERCISE_SLUG,
    EXERCISE_TITLE,
    'Auto-created by scripts/seed-demo.mjs for trend/status demos.',
    cohort.id
  );
  exercise = db.prepare('SELECT * FROM exercises WHERE slug = ?').get(EXERCISE_SLUG);
  console.log(`Created exercise ${EXERCISE_SLUG} (${exercise.id})`);
} else {
  console.log(`Exercise ${EXERCISE_SLUG} already exists (${exercise.id})`);
}

// ── Insert hypotheses: 9 across 8 weeks ───────────────────────────────
// Weeks 8..0 ago (Monday-anchored UTC). Progression:
//   w=8,7   → vague      (oldest)
//   w=6,5,4 → plausible
//   w=3,2,1,0 → precise  (newest)
const hypInsert = db.prepare(
  `INSERT INTO hypotheses
     (student_id, exercise_id, hint_level, text, quality, recorded_at)
   VALUES (?, ?, ?, ?, ?, datetime('now', ?))`
);
const qualities = [
  'vague', 'vague', 'plausible', 'plausible', 'plausible',
  'precise', 'precise', 'precise', 'precise',
];
let hypCount = 0;
for (let i = 0; i < 9; i++) {
  const weeksAgo = 8 - i;
  const offset = `-${weeksAgo * 7} days`;
  hypInsert.run(
    STUDENT_ID,
    exercise.slug,
    (i % 3) + 1,
    `[seed] Synthetic hypothesis #${i + 1}`,
    qualities[i],
    offset
  );
  hypCount++;
}
console.log(`Inserted ${hypCount} hypotheses`);

// ── Insert hint_sessions: 3 completed across weeks ────────────────────
// Note: hint_sessions has UNIQUE(student_id, exercise_id), so all three
// must share the same exercise_id. We vary created_at/updated_at instead.
const sessInsert = db.prepare(
  `INSERT INTO hint_sessions
     (id, student_id, exercise_id, state, current_level, total_attempts,
      resolved, hypothesis_pending, created_at, updated_at)
   VALUES (?, ?, ?, 'complete', ?, ?, 1, 0,
           datetime('now', ?), datetime('now', ?))`
);
const sessionDefs = [
  { level: 1, attempts: 3, daysAgo: 21 },
  { level: 2, attempts: 4, daysAgo: 10 },
  { level: 2, attempts: 5, daysAgo: 3 },
];
let sessCount = 0;
for (let i = 0; i < sessionDefs.length; i++) {
  const s = sessionDefs[i];
  const id = `seed-sess-${i + 1}-${exercise.slug}`;
  // UNIQUE(student_id, exercise_id) — skip if already present (shouldn't
  // be, since we wiped above, but be defensive)
  const existing = db
    .prepare(
      "SELECT id FROM hint_sessions WHERE student_id = ? AND exercise_id = ?"
    )
    .get(STUDENT_ID, exercise.slug);
  if (existing) {
    console.log(
      `Skipping session insert: student+exercise already has a session (${existing.id})`
    );
    break;
  }
  sessInsert.run(
    id,
    STUDENT_ID,
    exercise.slug,
    s.level,
    s.attempts,
    `-${s.daysAgo} days`,
    `-${s.daysAgo - 1} days`
  );
  sessCount++;
}
console.log(`Inserted ${sessCount} hint_sessions`);

// ── Insert post_mortems: 3 (2 strong, 1 partial) ──────────────────────
const pmInsert = db.prepare(
  `INSERT INTO post_mortems
     (session_id, student_id, exercise_id, pattern, text, score, feedback, recorded_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
);
const sessionRow = db
  .prepare(
    'SELECT id FROM hint_sessions WHERE student_id = ? AND exercise_id = ?'
  )
  .get(STUDENT_ID, exercise.slug);

const postMortems = [
  {
    pattern: 'off-by-one',
    text: '[seed] The loop ran one extra iteration because I used <= instead of <.',
    score: 'strong',
    feedback: 'Precise root cause. Corrected the boundary explicitly.',
    daysAgo: 20,
  },
  {
    pattern: 'null-undefined',
    text: '[seed] I assumed the input was defined; it was null for empty arrays.',
    score: 'strong',
    feedback: 'Good identification of the guard condition that was missing.',
    daysAgo: 8,
  },
  {
    pattern: null,
    text: '[seed] The variable scope confused me — I need to trace it more carefully.',
    score: 'partial',
    feedback: 'Partial: described the symptom but not the exact scope rule.',
    daysAgo: 2,
  },
];
let pmCount = 0;
for (const pm of postMortems) {
  if (!sessionRow) break;
  pmInsert.run(
    sessionRow.id,
    STUDENT_ID,
    exercise.slug,
    pm.pattern,
    pm.text,
    pm.score,
    pm.feedback,
    `-${pm.daysAgo} days`
  );
  pmCount++;
}
console.log(`Inserted ${pmCount} post_mortems`);

// ── Insert mistake_patterns: 3 (off-by-one x2, null-undefined x1) ─────
const mpInsert = db.prepare(
  `INSERT INTO mistake_patterns
     (student_id, exercise_id, pattern, confidence, source, recorded_at)
   VALUES (?, ?, ?, ?, 'seed', datetime('now', ?))`
);
const patterns = [
  { pattern: 'off-by-one', confidence: 'high', daysAgo: 21 },
  { pattern: 'off-by-one', confidence: 'medium', daysAgo: 14 },
  { pattern: 'null-undefined', confidence: 'high', daysAgo: 6 },
];
let mpCount = 0;
for (const p of patterns) {
  mpInsert.run(
    STUDENT_ID,
    exercise.slug,
    p.pattern,
    p.confidence,
    `-${p.daysAgo} days`
  );
  mpCount++;
}
console.log(`Inserted ${mpCount} mistake_patterns`);

// ── Summary ───────────────────────────────────────────────────────────
console.log();
console.log('── Seed summary ──');
console.log(`Exercise: ${EXERCISE_SLUG} (${exercise.id})`);
console.log(`Student:  ${STUDENT_ID}`);
const check = {
  hypotheses: db
    .prepare(
      "SELECT COUNT(*) n FROM hypotheses WHERE student_id = ? AND text LIKE '[seed]%'"
    )
    .get(STUDENT_ID).n,
  hint_sessions: db
    .prepare(
      "SELECT COUNT(*) n FROM hint_sessions WHERE student_id = ? AND id LIKE 'seed-sess-%'"
    )
    .get(STUDENT_ID).n,
  post_mortems: db
    .prepare(
      "SELECT COUNT(*) n FROM post_mortems WHERE student_id = ? AND text LIKE '[seed]%'"
    )
    .get(STUDENT_ID).n,
  mistake_patterns: db
    .prepare(
      "SELECT COUNT(*) n FROM mistake_patterns WHERE student_id = ? AND source = 'seed'"
    )
    .get(STUDENT_ID).n,
};
console.log(check);
console.log();
console.log('Re-run to refresh, or: node scripts/seed-demo.mjs --wipe');
