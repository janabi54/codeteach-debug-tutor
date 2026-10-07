#!/usr/bin/env node
/**
 * Seed demo data for Jiro + 4 peer students in CS101 Fall 2026.
 *
 * Creates / refreshes:
 *   - Exercise "ex-demo-1" in CS101 Fall 2026 (idempotent)
 *   - Jiro: 9 hypotheses across 8 weeks, 1 session, 3 post-mortems,
 *     3 mistake_patterns, 0 telemetry
 *   - Peers (Aisha, Ben, Carla, Dev): hypotheses + sessions + telemetry
 *     + post-mortems + mistake_patterns tuned to distinct profiles, so
 *     the cohort comparison medians are meaningful.
 *
 * All peer users have password "demo-pass-123" and emails @demo.local.
 * Re-running the script wipes + re-inserts all seed + peer data
 * (idempotent). Jiro's own account is not touched other than his
 * tagged rows.
 *
 * Usage:
 *   node scripts/seed-demo.mjs
 *   node scripts/seed-demo.mjs --wipe     # just delete seed + peer data
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';

const WIPE_ONLY = process.argv.includes('--wipe');
const DEMO_PASSWORD = 'demo-pass-123';
const DEMO_EMAIL_DOMAIN = 'demo.local';

// ── Deterministic outcomes ────────────────────────────────────────────
// Outcomes are picked by (quality, index) so re-runs produce identical
// data. Spread across all three values + occasional untested (null) so
// the demo has a realistic distribution.
//
// Index is `i % 10` for each hypothesis, so the pattern cycles if a
// student has more than 10 hypotheses at one quality level.
const OUTCOME_PATTERNS = {
  precise: [
    'confirmed', 'confirmed', 'confirmed', 'unclear', null,
    'confirmed', 'refuted', 'confirmed', 'unclear', 'confirmed',
  ],
  plausible: [
    'unclear', 'refuted', 'confirmed', null, 'refuted',
    'confirmed', 'unclear', 'refuted', 'confirmed', 'unclear',
  ],
  vague: [
    'refuted', 'refuted', 'unclear', 'refuted', 'refuted',
    null, 'refuted', 'refuted', 'unclear', 'confirmed',
  ],
};

function pickOutcome(quality, index) {
  const pattern = OUTCOME_PATTERNS[quality];
  if (!pattern) return null;
  return pattern[index % pattern.length];
}

// ── Config ────────────────────────────────────────────────────────────
const STUDENT_ID = '75987245-0755-4efe-a264-03b799761a1b'; // Jiro
const COHORT_NAME = 'CS101 Fall 2026';
const EXERCISE_SLUG = 'ex-demo-1';
const EXERCISE_TITLE = 'Demo: Trend Showcase';

// Fixed UUIDs for peers so re-runs are idempotent.
const PEERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'aisha@' + DEMO_EMAIL_DOMAIN,
    displayName: 'Aisha',
    // Strong: mostly precise, many hints avoided (few hints), most sessions done
    profile: { precise: 8, plausible: 2, vague: 0, sessions: 5, completed: 4, hintsPerSession: 0.2, lastActiveDaysAgo: 1, sessionMinutes: 60, strugglePerSession: 10 },
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'ben@' + DEMO_EMAIL_DOMAIN,
    displayName: 'Ben',
    // Average: half precise, moderate hints, mid progress
    profile: { precise: 4, plausible: 4, vague: 2, sessions: 4, completed: 3, hintsPerSession: 1.0, lastActiveDaysAgo: 3, sessionMinutes: 90, strugglePerSession: 25 },
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    email: 'carla@' + DEMO_EMAIL_DOMAIN,
    displayName: 'Carla',
    // Struggling: mostly vague, heavy hints, low progress, quiet
    profile: { precise: 1, plausible: 2, vague: 7, sessions: 2, completed: 1, hintsPerSession: 3.0, lastActiveDaysAgo: 12, sessionMinutes: 180, strugglePerSession: 65 },
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    email: 'dev@' + DEMO_EMAIL_DOMAIN,
    displayName: 'Dev',
    // New: just started, a little of everything
    profile: { precise: 2, plausible: 2, vague: 1, sessions: 1, completed: 1, hintsPerSession: 0.5, lastActiveDaysAgo: 2, sessionMinutes: 45, strugglePerSession: 15 },
  },
];

/**
 * Compute a SQLite-compatible timestamp string (YYYY-MM-DD HH:MM:SS, UTC)
 * offset from now by `days` ago, then minus `minutes` further back.
 * e.g. offsetTimestamp(2, 90) → "2026-10-05 12:39:20" (2 days + 90 min ago).
 */
function offsetTimestamp(days, minutes) {
  const ms = Date.now() - days * 86400000 - minutes * 60000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

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

// ── Wipe prior seed + peer data ───────────────────────────────────────
function wipeAll() {
  const peerIds = PEERS.map((p) => p.id);

  // Wipe Jiro's tagged rows (any student_id, tagged by content)
  const h = db.prepare("DELETE FROM hypotheses WHERE text LIKE '[seed]%'").run();
  const p = db.prepare("DELETE FROM post_mortems WHERE text LIKE '[seed]%'").run();
  const m = db.prepare("DELETE FROM mistake_patterns WHERE source = 'seed'").run();
  const s = db.prepare(
    `DELETE FROM hint_sessions
     WHERE id LIKE 'seed-sess-%'
        OR (student_id = ? AND exercise_id IN (
              SELECT id FROM exercises WHERE slug = ?
              UNION
              SELECT slug FROM exercises WHERE slug = ?
           ))`
  ).run(STUDENT_ID, EXERCISE_SLUG, EXERCISE_SLUG);

  // Wipe peers' rows + telemetry
  let peerH = 0, peerS = 0, peerP = 0, peerM = 0, peerT = 0, peerU = 0, peerCm = 0;
  if (peerIds.length > 0) {
    const placeholders = peerIds.map(() => '?').join(',');
    peerH = db.prepare(`DELETE FROM hypotheses WHERE student_id IN (${placeholders})`).run(...peerIds).changes;
    peerS = db.prepare(`DELETE FROM hint_sessions WHERE student_id IN (${placeholders})`).run(...peerIds).changes;
    peerP = db.prepare(`DELETE FROM post_mortems WHERE student_id IN (${placeholders})`).run(...peerIds).changes;
    peerM = db.prepare(`DELETE FROM mistake_patterns WHERE student_id IN (${placeholders})`).run(...peerIds).changes;
    peerT = db.prepare(`DELETE FROM telemetry WHERE student_id IN (${placeholders})`).run(...peerIds).changes;
    peerCm = db.prepare(`DELETE FROM cohort_members WHERE user_id IN (${placeholders})`).run(...peerIds).changes;
    peerU = db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...peerIds).changes;
  }

  console.log('Wiped prior rows:');
  console.log(`  Jiro:  hypotheses=${h.changes} hint_sessions=${s.changes} post_mortems=${p.changes} mistake_patterns=${m.changes}`);
  console.log(`  Peers: users=${peerU} members=${peerCm} hypotheses=${peerH} hint_sessions=${peerS} post_mortems=${peerP} mistake_patterns=${peerM} telemetry=${peerT}`);
}

async function main() {
  wipeAll();
  if (WIPE_ONLY) {
    console.log('Wipe-only mode: done.');
    return;
  }

  // ── Ensure ex-demo-1 exists ─────────────────────────────────────────
  let exercise = db.prepare('SELECT * FROM exercises WHERE slug = ?').get(EXERCISE_SLUG);
  if (!exercise) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO exercises (id, slug, title, description, language, cohort_id)
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
    console.log(`Exercise ${EXERCISE_SLUG} exists (${exercise.id})`);
  }

  // ── Ensure all viewable exercise slugs exist (peers will reference them) ──
  // If any are missing, create placeholder exercises so peer sessions
  // don't get orphaned.
  const VIEWABLE_SLUGS = ['ex-1', 'ex-hard-loop', 'ex-nested-loops', 'find-the-maximum', EXERCISE_SLUG];
  for (const slug of VIEWABLE_SLUGS) {
    const exists = db.prepare('SELECT id FROM exercises WHERE slug = ?').get(slug);
    if (!exists) {
      db.prepare(
        `INSERT INTO exercises (id, slug, title, description, language, cohort_id)
         VALUES (?, ?, ?, ?, 'javascript', ?)`
      ).run(randomUUID(), slug, slug, '', cohort.id);
      console.log(`  Created placeholder exercise ${slug}`);
    }
  }

  // ── Seed Jiro (existing logic) ──────────────────────────────────────
  const hypInsert = db.prepare(
    `INSERT INTO hypotheses (student_id, exercise_id, hint_level, text, quality, outcome, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const qualities = ['vague', 'vague', 'plausible', 'plausible', 'plausible', 'precise', 'precise', 'precise', 'precise'];
  for (let i = 0; i < 9; i++) {
    const weeksAgo = 8 - i;
    hypInsert.run(
      STUDENT_ID,
      exercise.slug,
      (i % 3) + 1,
      `[seed] Synthetic hypothesis #${i + 1}`,
      qualities[i],
      pickOutcome(qualities[i], i),
      `-${weeksAgo * 7} days`
    );
  }
  console.log('Jiro: inserted 9 hypotheses');

  // Jiro: 1 session on ex-demo-1, 2 days ago
  db.prepare(
    `INSERT INTO hint_sessions
       (id, student_id, exercise_id, state, current_level, total_attempts,
        resolved, hypothesis_pending, struggle_minutes, created_at, updated_at)
     VALUES (?, ?, ?, 'complete', 1, 3, 1, 0, 28,
             datetime('now', '-2 days', '-90 minutes'),
             datetime('now', '-2 days'))`
  ).run(`seed-sess-jiro-${exercise.slug}`, STUDENT_ID, exercise.slug);
  console.log('Jiro: inserted 1 hint_session');

  const jiroSession = db.prepare(
    'SELECT id FROM hint_sessions WHERE student_id = ? AND exercise_id = ?'
  ).get(STUDENT_ID, exercise.slug);

  const pmInsert = db.prepare(
    `INSERT INTO post_mortems
       (session_id, student_id, exercise_id, pattern, text, score, feedback, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', ?))`
  );
  const jiroPMs = [
    { pattern: 'off-by-one', text: '[seed] The loop ran one extra iteration because I used <= instead of <.', score: 'strong', feedback: 'Precise root cause.', daysAgo: 20 },
    { pattern: 'null-undefined', text: '[seed] I assumed the input was defined; it was null for empty arrays.', score: 'strong', feedback: 'Good identification of the guard condition.', daysAgo: 8 },
    { pattern: null, text: '[seed] The variable scope confused me.', score: 'partial', feedback: 'Partial: described the symptom.', daysAgo: 2 },
  ];
  for (const pm of jiroPMs) {
    pmInsert.run(jiroSession.id, STUDENT_ID, exercise.slug, pm.pattern, pm.text, pm.score, pm.feedback, `-${pm.daysAgo} days`);
  }
  console.log('Jiro: inserted 3 post_mortems');

  const mpInsert = db.prepare(
    `INSERT INTO mistake_patterns (student_id, exercise_id, pattern, confidence, source, recorded_at)
     VALUES (?, ?, ?, ?, 'seed', datetime('now', ?))`
  );
  const jiroMPs = [
    { pattern: 'off-by-one', confidence: 'high', daysAgo: 21 },
    { pattern: 'off-by-one', confidence: 'medium', daysAgo: 14 },
    { pattern: 'null-undefined', confidence: 'high', daysAgo: 6 },
  ];
  for (const p of jiroMPs) {
    mpInsert.run(STUDENT_ID, exercise.slug, p.pattern, p.confidence, `-${p.daysAgo} days`);
  }
  console.log('Jiro: inserted 3 mistake_patterns');

  // ── Seed peers ──────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const userInsert = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role)
     VALUES (?, ?, ?, ?, 'student')`
  );
  const memberInsert = db.prepare(
    `INSERT INTO cohort_members (cohort_id, user_id) VALUES (?, ?)`
  );
  const peerHypInsert = db.prepare(
    `INSERT INTO hypotheses (student_id, exercise_id, hint_level, text, quality, outcome, recorded_at)
     VALUES (?, ?, 1, ?, ?, ?, datetime('now', ?))`
  );
  const peerSessInsert = db.prepare(
    `INSERT INTO hint_sessions
       (id, student_id, exercise_id, state, current_level, total_attempts,
        resolved, hypothesis_pending, struggle_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 3, 1, 0, ?, ?, ?)`
  );
  const peerTelInsert = db.prepare(
    `INSERT INTO telemetry (type, student_id, exercise_id, latency_ms, recorded_at)
     VALUES ('hint-served', ?, ?, 150, datetime('now', ?))`
  );
  const peerPMInsert = db.prepare(
    `INSERT INTO post_mortems
       (session_id, student_id, exercise_id, pattern, text, score, feedback, recorded_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'Seeded peer post-mortem.', datetime('now', ?))`
  );
  const peerMPInsert = db.prepare(
    `INSERT INTO mistake_patterns (student_id, exercise_id, pattern, confidence, source, recorded_at)
     VALUES (?, ?, ?, 'medium', 'seed', datetime('now', ?))`
  );

  // Peer sessions spread across the viewable exercise slugs; each peer
  // takes a prefix of this list based on their session count.
  const SLUG_CYCLE = ['ex-1', 'ex-hard-loop', 'ex-nested-loops', 'find-the-maximum', EXERCISE_SLUG];

  for (const peer of PEERS) {
    const { id, email, displayName, profile } = peer;

    // 1. User
    userInsert.run(id, email, passwordHash, displayName);

    // 2. Cohort membership
    memberInsert.run(cohort.id, id);

    // 3. Hypotheses: distribute across the first few slugs
    const totalHyp = profile.precise + profile.plausible + profile.vague;
    const qDist = [
      ...Array(profile.precise).fill('precise'),
      ...Array(profile.plausible).fill('plausible'),
      ...Array(profile.vague).fill('vague'),
    ];
    // Most-recent = end of list, oldest = start
    for (let i = 0; i < totalHyp; i++) {
      const slug = SLUG_CYCLE[i % SLUG_CYCLE.length];
      const weeksAgo = Math.max(0, totalHyp - 1 - i); // 0 = newest
      peerHypInsert.run(
        id,
        slug,
        `[peer-${displayName.toLowerCase()}] hypothesis #${i + 1}`,
        qDist[i],
        pickOutcome(qDist[i], i),
        `-${weeksAgo * 7} days`
      );
    }

    // 4. Sessions: first `profile.sessions` slugs; `profile.completed` are complete
    const daysBase = profile.lastActiveDaysAgo;
    for (let s = 0; s < profile.sessions; s++) {
      const slug = SLUG_CYCLE[s % SLUG_CYCLE.length];
      const state = s < profile.completed ? 'complete' : 'open';
      // Each session ends `updatedDaysAgo` days ago; started `sessionMinutes` earlier.
      const updatedDaysAgo = daysBase + (profile.sessions - 1 - s) * 5;
      const createdTs = offsetTimestamp(updatedDaysAgo, profile.sessionMinutes);
      const updatedTs = offsetTimestamp(updatedDaysAgo, 0);
      // Struggle grows slightly for later sessions
      const struggle = profile.strugglePerSession + Math.floor(s * 1.5);
      const sessId = `peer-sess-${id.slice(0, 8)}-${slug}`;
      peerSessInsert.run(
        sessId,
        id,
        slug,
        state,
        struggle,
        createdTs,
        updatedTs
      );

      // 5. Telemetry: N 'hint-served' rows inside this session's window
      const hintCount = Math.round(profile.hintsPerSession);
      for (let h = 0; h < hintCount; h++) {
        // Place hints somewhere between created and updated
        const offsetDays = updatedDaysAgo + (h * 0.1); // small drift
        peerTelInsert.run(id, slug, `-${offsetDays} days`);
      }
    }

    // 6. A post-mortem per completed session (one strong, one partial)
    if (profile.completed > 0) {
      const firstSlug = SLUG_CYCLE[0];
      const sess = db.prepare(
        'SELECT id FROM hint_sessions WHERE student_id = ? AND exercise_id = ?'
      ).get(id, firstSlug);
      if (sess) {
        peerPMInsert.run(sess.id, id, firstSlug, `[peer-${displayName.toLowerCase()}] first reflection`, 'strong', `-${daysBase + 3} days`);
      }
    }

    // 7. A mistake pattern if the peer is struggling
    if (profile.vague > profile.precise) {
      peerMPInsert.run(id, SLUG_CYCLE[0], 'off-by-one', `-${daysBase + 5} days`);
    }

    console.log(`Peer ${displayName} (${email}) seeded: ${totalHyp} hyps, ${profile.sessions} sessions, ${profile.completed} complete`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log();
  console.log('── Seed summary ──');
  console.log(`Exercise: ${EXERCISE_SLUG} (${exercise.id})`);
  console.log(`Jiro:     ${STUDENT_ID}`);
  console.log(`Peers:    ${PEERS.length} students in ${COHORT_NAME}`);
  console.log();
  console.log('Peer login credentials:');
  for (const p of PEERS) {
    console.log(`  ${p.email}  /  ${DEMO_PASSWORD}`);
  }
  console.log();
  console.log('Re-run to refresh, or: node scripts/seed-demo.mjs --wipe');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
