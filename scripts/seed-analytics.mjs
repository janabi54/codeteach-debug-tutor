#!/usr/bin/env node
/**
 * Seed 4 diverse students into the instructor's default cohort
 * ("My Exercises") so the Analytics dashboard has meaningful data:
 *
 *   Maya  — 3/3 progress, mostly precise, active this week     → on-track
 *   Omar  — 2/3 progress, mixed reasoning, active last week    → on-track
 *   Priya — 1/3 progress, mostly vague, quiet 8 days           → slipping
 *   Sam   — 0/3 progress, few hypotheses, quiet 20 days        → at-risk
 *
 * All 4 share the demo password (demo-pass-123) and get @demo.local
 * emails. Idempotent: re-runs wipe their own rows and re-insert.
 *
 * Usage:
 *   node scripts/seed-analytics.mjs
 *   node scripts/seed-analytics.mjs --wipe
 */

import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

const WIPE_ONLY = process.argv.includes('--wipe');
const DEMO_PASSWORD = 'demo-pass-123';
const COHORT_NAME = 'My Exercises';
const INSTRUCTOR_EMAIL = 'sheban@codeteach.local';

// Fixed UUIDs so re-runs are idempotent
const STUDENTS = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'maya@demo.local',
    name: 'Maya',
    // 3 sessions, all complete; hypotheses largely precise; last active ~2d
    sessions: [
      { slug: 'ex-1', state: 'complete', daysAgo: 25, struggle: 20, minutes: 40 },
      { slug: 'ex-hard-loop', state: 'complete', daysAgo: 12, struggle: 25, minutes: 55 },
      { slug: 'ex-nested-loops', state: 'complete', daysAgo: 2, struggle: 15, minutes: 35 },
    ],
    qualities: ['precise', 'precise', 'plausible', 'precise', 'precise', 'plausible'],
    outcomes: ['confirmed', 'confirmed', 'unclear', 'confirmed', 'confirmed', 'confirmed'],
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    email: 'omar@demo.local',
    name: 'Omar',
    // 3 sessions, 2 complete; mixed reasoning; last active ~6d
    sessions: [
      { slug: 'ex-1', state: 'complete', daysAgo: 30, struggle: 40, minutes: 60 },
      { slug: 'ex-hard-loop', state: 'complete', daysAgo: 18, struggle: 35, minutes: 50 },
      { slug: 'ex-nested-loops', state: 'open', daysAgo: 6, struggle: 45, minutes: 55 },
    ],
    qualities: ['plausible', 'vague', 'plausible', 'precise', 'plausible', 'vague'],
    outcomes: ['unclear', 'refuted', 'confirmed', 'confirmed', 'unclear', 'refuted'],
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    email: 'priya@demo.local',
    name: 'Priya',
    // 2 sessions, 1 complete; mostly vague; quiet ~8d
    sessions: [
      { slug: 'ex-1', state: 'complete', daysAgo: 40, struggle: 60, minutes: 90 },
      { slug: 'ex-hard-loop', state: 'open', daysAgo: 8, struggle: 80, minutes: 120 },
    ],
    qualities: ['vague', 'vague', 'plausible', 'vague'],
    outcomes: ['refuted', 'refuted', 'unclear', 'refuted'],
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    email: 'sam@demo.local',
    name: 'Sam',
    // 1 session (incomplete); few hypotheses; quiet ~20d
    sessions: [
      { slug: 'ex-1', state: 'open', daysAgo: 20, struggle: 55, minutes: 75 },
    ],
    qualities: ['vague', 'vague'],
    outcomes: ['refuted', 'unclear'],
  },
];

/**
 * Compute a SQLite-compatible timestamp string offset from now
 * (days ago, then minus an additional N minutes further back).
 */
function offsetTimestamp(daysAgo, minutesBack = 0) {
  const ms = Date.now() - daysAgo * 86400000 - minutesBack * 60000;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

const db = new Database('codeteach.db');

const cohort = db.prepare('SELECT id, name FROM cohorts WHERE name = ?').get(COHORT_NAME);
if (!cohort) {
  console.error('ERROR: cohort "' + COHORT_NAME + '" not found.');
  process.exit(1);
}

const instructor = db.prepare('SELECT id FROM users WHERE email = ?').get(INSTRUCTOR_EMAIL);
if (!instructor) {
  console.error('ERROR: instructor "' + INSTRUCTOR_EMAIL + '" not found.');
  process.exit(1);
}

function wipe() {
  const ids = STUDENTS.map((s) => s.id);
  const ph = ids.map(() => '?').join(',');
  const h = db.prepare(`DELETE FROM hypotheses WHERE student_id IN (${ph})`).run(...ids);
  const hs = db.prepare(`DELETE FROM hint_sessions WHERE student_id IN (${ph})`).run(...ids);
  const pm = db.prepare(`DELETE FROM post_mortems WHERE student_id IN (${ph})`).run(...ids);
  const mp = db.prepare(`DELETE FROM mistake_patterns WHERE student_id IN (${ph})`).run(...ids);
  const tel = db.prepare(`DELETE FROM telemetry WHERE student_id IN (${ph})`).run(...ids);
  const cm = db.prepare(`DELETE FROM cohort_members WHERE user_id IN (${ph})`).run(...ids);
  const u = db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids);
  console.log(
    `Wiped analytics-seed rows: hypotheses=${h.changes} sessions=${hs.changes} pms=${pm.changes} patterns=${mp.changes} telemetry=${tel.changes} members=${cm.changes} users=${u.changes}`
  );
}

async function main() {
  wipe();
  if (WIPE_ONLY) {
    console.log('Wipe-only mode: done.');
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

  const userInsert = db.prepare(
    `INSERT INTO users (id, email, password_hash, display_name, role)
     VALUES (?, ?, ?, ?, 'student')`
  );
  const memberInsert = db.prepare(
    `INSERT INTO cohort_members (cohort_id, user_id) VALUES (?, ?)`
  );
  const hypInsert = db.prepare(
    `INSERT INTO hypotheses (student_id, exercise_id, hint_level, text, quality, outcome, recorded_at)
     VALUES (?, ?, 1, ?, ?, ?, datetime('now', ?))`
  );
  const sessInsert = db.prepare(
    `INSERT INTO hint_sessions
       (id, student_id, exercise_id, state, current_level, total_attempts,
        resolved, hypothesis_pending, struggle_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 3, 1, 0, ?, ?, ?)`
  );

  for (const student of STUDENTS) {
    // 1. User + membership
    userInsert.run(student.id, student.email, passwordHash, student.name);
    memberInsert.run(cohort.id, student.id);

    // 2. Hypotheses: spread across the last ~10 weeks, matching quality pattern
    const n = student.qualities.length;
    for (let i = 0; i < n; i++) {
      const slug = student.sessions[i % student.sessions.length].slug;
      const weeksAgo = Math.max(0, n - 1 - i);
      hypInsert.run(
        student.id,
        slug,
        `[analytics-seed] ${student.name} hypothesis #${i + 1}`,
        student.qualities[i],
        student.outcomes[i] || null,
        `-${weeksAgo * 7} days`
      );
    }

    // 3. Sessions
    for (const s of student.sessions) {
      const created = offsetTimestamp(s.daysAgo, s.minutes);
      const updated = offsetTimestamp(s.daysAgo, 0);
      sessInsert.run(
        `analytics-sess-${student.id.slice(0, 8)}-${s.slug}`,
        student.id,
        s.slug,
        s.state,
        s.struggle,
        created,
        updated
      );
    }

    console.log(`Seeded ${student.name} (${student.email}): ${n} hypotheses, ${student.sessions.length} sessions`);
  }

  console.log();
  console.log('── Seed summary ──');
  console.log(`Cohort: ${cohort.name} (${cohort.id})`);
  console.log('Students added:');
  for (const s of STUDENTS) {
    console.log(`  ${s.name.padEnd(8)} ${s.email}`);
  }
  console.log();
  console.log('Peer login credentials (all @demo.local):');
  console.log(`  password: ${DEMO_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
