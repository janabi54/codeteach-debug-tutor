#!/usr/bin/env node
/**
 * Admin-role CLI.
 *
 * In this app, `role` is 'student' | 'instructor' and admin is a
 * separate capability flag `is_admin` on the user row. When the server
 * is started with DISABLE_OPEN_ADMIN=true, new instructor signups do
 * NOT get admin powers — this script is how you grant them.
 *
 * Usage:
 *   node scripts/make-admin.mjs <email>              # promote to admin
 *   node scripts/make-admin.mjs <email> --revoke     # demote
 *   node scripts/make-admin.mjs --list               # list all admins
 *   node scripts/make-admin.mjs --help               # show this help
 */

import Database from 'better-sqlite3';

const args = process.argv.slice(2);

function help() {
  console.log(`
make-admin — grant or revoke the is_admin flag on a user account.

Usage:
  node scripts/make-admin.mjs <email>              # promote to admin
  node scripts/make-admin.mjs <email> --revoke     # demote
  node scripts/make-admin.mjs --list               # list admins
  node scripts/make-admin.mjs --help

Notes:
  - Only users with role='instructor' can be admins. Promoting a
    student is rejected (they need to sign up as an instructor, or be
    invited as one, first).
  - The change takes effect on the user's next session refresh
    (logout / login, or browser reload).
`);
}

if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  help();
  process.exit(0);
}

const db = new Database('codeteach.db');

if (args.includes('--list')) {
  const rows = db.prepare(
    `SELECT email, display_name, role, is_admin
     FROM users
     WHERE is_admin = 1
     ORDER BY email`
  ).all();
  if (rows.length === 0) {
    console.log('No admins yet.');
  } else {
    console.log('Admins:');
    for (const r of rows) {
      console.log(`  ${r.email}  (${r.display_name}, role=${r.role})`);
    }
  }
  process.exit(0);
}

const email = args[0] && !args[0].startsWith('--') ? args[0].toLowerCase().trim() : null;
if (!email) {
  console.error('ERROR: missing email. Run with --help for usage.');
  process.exit(1);
}

const revoke = args.includes('--revoke');
const user = db.prepare('SELECT id, email, display_name, role, is_admin FROM users WHERE email = ?').get(email);

if (!user) {
  console.error(`ERROR: no user with email "${email}".`);
  process.exit(1);
}

if (user.role !== 'instructor') {
  console.error(`ERROR: "${email}" has role="${user.role}", not "instructor".`);
  console.error('Only instructors can be admins. Promote them by re-inviting them as an instructor first.');
  process.exit(1);
}

if (revoke) {
  if (user.is_admin !== 1) {
    console.log(`"${email}" is not currently an admin. Nothing to do.`);
    process.exit(0);
  }
  db.prepare('UPDATE users SET is_admin = 0 WHERE email = ?').run(email);
  console.log(`Revoked admin from "${email}" (${user.display_name}).`);
} else {
  if (user.is_admin === 1) {
    console.log(`"${email}" is already an admin. Nothing to do.`);
    process.exit(0);
  }
  db.prepare('UPDATE users SET is_admin = 1 WHERE email = ?').run(email);
  console.log(`Promoted "${email}" (${user.display_name}) to admin.`);
}

process.exit(0);
