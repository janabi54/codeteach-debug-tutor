import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fillWeeks, lastNWeekStarts, classifyTrend } from './util/weeks.js';
import { deriveStrengths, type Strength } from './util/strengths.js';
import { buildActivitySummary, type ActivitySummary } from './util/activity.js';
import { deriveTimeMetrics, type TimeMetrics } from './util/timeMetrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * SQLite stores datetime('now') as 'YYYY-MM-DD HH:MM:SS' in UTC with no
 * timezone marker. `new Date()` treats that as local time. Append 'Z' so
 * the string parses as UTC and timestamps round-trip correctly.
 */
function parseSqliteTimestamp(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  if (raw.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(raw)) {
    return new Date(raw);
  }
  return new Date(raw.replace(' ', 'T') + 'Z');
}

function rowToUser(row: any): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    role: row.role === 'instructor' ? 'instructor' : 'student',
    isAdmin: row.is_admin === 1,
    createdAt: parseSqliteTimestamp(row.created_at),
  };
}

function rowToTutorFeedback(row: any): TutorFeedback {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    instructorName: row.instructor_name ?? null,
    studentId: row.student_id,
    targetType: row.target_type,
    targetId: row.target_id,
    text: row.text,
    createdAt: parseSqliteTimestamp(row.created_at),
    updatedAt: parseSqliteTimestamp(row.updated_at),
  };
}

function rowToTutorNote(row: any): TutorNote {
  return {
    id: row.id,
    instructorId: row.instructor_id,
    studentId: row.student_id,
    cohortId: row.cohort_id,
    text: row.text,
    createdAt: parseSqliteTimestamp(row.created_at),
    updatedAt: parseSqliteTimestamp(row.updated_at),
  };
}

function rowToCohort(row: any): Cohort {
  return {
    id: row.id,
    name: row.name,
    instructorId: row.instructor_id,
    enrollmentCode: row.enrollment_code ?? null,
    createdAt: parseSqliteTimestamp(row.created_at),
  };
}

function rowToExercise(row: any): Exercise {
  let concepts: string[] = [];
  let objectives: string[] = [];
  try { concepts = JSON.parse(row.expected_concepts || '[]'); } catch {}
  try { objectives = JSON.parse(row.learning_objectives || '[]'); } catch {}
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    language: row.language,
    starterCode: row.starter_code,
    expectedConcepts: concepts,
    learningObjectives: objectives,
    struggleMinutes: row.struggle_minutes,
    cohortId: row.cohort_id,
    createdBy: row.created_by,
    createdAt: parseSqliteTimestamp(row.created_at),
    updatedAt: parseSqliteTimestamp(row.updated_at),
  };
}

function rowToInviteCode(row: any) {
  return {
    id: row.id,
    code: row.code,
    role: row.role,
    createdBy: row.created_by,
    createdAt: parseSqliteTimestamp(row.created_at),
    usedBy: row.used_by,
    usedAt: row.used_at ? parseSqliteTimestamp(row.used_at) : null,
    expiresAt: row.expires_at ? parseSqliteTimestamp(row.expires_at) : null,
  };
}

function rowToAuthSession(row: any): AuthSession {
  return {
    token: row.token,
    userId: row.user_id,
    createdAt: parseSqliteTimestamp(row.created_at),
    expiresAt: parseSqliteTimestamp(row.expires_at),
  };
}

const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'codeteach.db');

export const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

const schema = readFileSync(join(__dirname, 'db', 'schema.sql'), 'utf8');
sqlite.exec(schema);

// One-time migration: add hypothesis_pending column if it doesn't exist
const sessionColumns = sqlite.prepare(
  "PRAGMA table_info(hint_sessions)"
).all() as Array<{ name: string }>;
const hasHypothesisPending = sessionColumns.some(
  (c) => c.name === 'hypothesis_pending'
);
if (!hasHypothesisPending) {
  sqlite.exec(
    'ALTER TABLE hint_sessions ADD COLUMN hypothesis_pending INTEGER NOT NULL DEFAULT 1'
  );
  console.log('[db] migrated: added hint_sessions.hypothesis_pending');
}

const hasState = sessionColumns.some((c) => c.name === 'state');
if (!hasState) {
  sqlite.exec(
    "ALTER TABLE hint_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'open'"
  );
  console.log('[db] migrated: added hint_sessions.state');
}

const hasStruggle = sessionColumns.some((c) => c.name === 'struggle_minutes');
if (!hasStruggle) {
  sqlite.exec(
    'ALTER TABLE hint_sessions ADD COLUMN struggle_minutes INTEGER NOT NULL DEFAULT 0'
  );
  console.log('[db] migrated: added hint_sessions.struggle_minutes');
}

const hasCodeSubs = sessionColumns.some((c) => c.name === 'code_submissions');
if (!hasCodeSubs) {
  sqlite.exec(
    'ALTER TABLE hint_sessions ADD COLUMN code_submissions INTEGER NOT NULL DEFAULT 0'
  );
  console.log('[db] migrated: added hint_sessions.code_submissions');
}

// Migrations for hypotheses table
const hypothesisColumns = sqlite.prepare(
  'PRAGMA table_info(hypotheses)'
).all() as Array<{ name: string }>;

const hasQuality = hypothesisColumns.some((c) => c.name === 'quality');
if (!hasQuality) {
  sqlite.exec('ALTER TABLE hypotheses ADD COLUMN quality TEXT');
  console.log('[db] migrated: added hypotheses.quality');
}

const hasScoreSource = hypothesisColumns.some((c) => c.name === 'score_source');
if (!hasScoreSource) {
  sqlite.exec('ALTER TABLE hypotheses ADD COLUMN score_source TEXT');
  console.log('[db] migrated: added hypotheses.score_source');
}

// One-time migration: users.is_admin (0/1) for admin capability flag
const userColumns = sqlite.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
const hasIsAdmin = userColumns.some((c) => c.name === 'is_admin');
if (!hasIsAdmin) {
  sqlite.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  console.log('[db] migrated: added users.is_admin');
}

const hasOutcome = hypothesisColumns.some((c) => c.name === 'outcome');
if (!hasOutcome) {
  sqlite.exec('ALTER TABLE hypotheses ADD COLUMN outcome TEXT');
  console.log('[db] migrated: added hypotheses.outcome');
}


export interface DeletionAudit {
  id: string;
  actorId: string;
  actorEmail: string | null;
  scope: 'student' | 'cohort' | 'account';
  targetId: string;
  targetLabel: string | null;
  countsJson: string;
  createdAt: Date;
}

export interface TutorFeedback {
  id: string;
  instructorId: string;
  instructorName: string | null;
  studentId: string;
  targetType: 'hypothesis' | 'post_mortem';
  targetId: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

interface TutorNote {
  id: string;
  instructorId: string;
  studentId: string;
  cohortId: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Cohort {
  id: string;
  name: string;
  instructorId: string;
  enrollmentCode: string | null;
  createdAt: Date;
}

interface Exercise {
  id: string;
  slug: string;
  title: string;
  description: string;
  language: string;
  starterCode: string;
  expectedConcepts: string[];
  learningObjectives: string[];
  struggleMinutes: number;
  cohortId: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: 'student' | 'instructor';
  isAdmin: boolean;
  createdAt: Date;
}

interface AuthSession {
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

interface HintSession {
  id: string;
  studentId: string;
  exerciseId: string;
  currentLevel: number;
  attemptsAtLevel: number;
  totalAttempts: number;
  resolved: boolean;
  hypothesisPending: boolean;
  state: 'open' | 'resolved' | 'complete';
  struggleMinutes: number;
  codeSubmissions: number;
  createdAt: Date;
}

interface MistakePatternRecord {
  studentId: string;
  exerciseId: string;
  pattern: string;
  confidence?: 'high' | 'medium' | 'low';
  source: 'llm' | 'classifier';
  timestamp: Date;
}

interface TelemetryEvent {
  type: string;
  studentId?: string;
  exerciseId?: string;
  reason?: string;
  latencyMs?: number;
  state?: string;
  failures?: number;
  openedAt?: string | null;
  timestamp: Date;
}

function rowToSession(row: any): HintSession {
  return {
    id: row.id,
    studentId: row.student_id,
    exerciseId: row.exercise_id,
    currentLevel: row.current_level,
    attemptsAtLevel: row.attempts_at_level,
    totalAttempts: row.total_attempts,
    resolved: row.resolved === 1,
    hypothesisPending: row.hypothesis_pending === 1,
    state: row.state ?? 'open',
    struggleMinutes: row.struggle_minutes ?? 0,
    codeSubmissions: row.code_submissions ?? 0,
    createdAt: parseSqliteTimestamp(row.created_at),
  };
}

function rowToPattern(row: any) {
  return {
    studentId: row.student_id,
    exerciseId: row.exercise_id,
    pattern: row.pattern,
    confidence: row.confidence ?? undefined,
    source: row.source,
    timestamp: parseSqliteTimestamp(row.recorded_at),
  };
}

function rowToTelemetry(row: any): TelemetryEvent {
  return {
    type: row.type,
    studentId: row.student_id ?? undefined,
    exerciseId: row.exercise_id ?? undefined,
    reason: row.reason ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    state: row.state ?? undefined,
    failures: row.failures ?? undefined,
    openedAt: row.opened_at ?? undefined,
    timestamp: parseSqliteTimestamp(row.recorded_at),
  };
}

const stmt = {
  findSession: sqlite.prepare('SELECT * FROM hint_sessions WHERE student_id = ? AND exercise_id = ?'),
  findSessionById: sqlite.prepare('SELECT * FROM hint_sessions WHERE id = ?'),
  insertSession: sqlite.prepare(
    'INSERT INTO hint_sessions (id, student_id, exercise_id, current_level, attempts_at_level, total_attempts, resolved, hypothesis_pending, state, struggle_minutes, code_submissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  updateSession: sqlite.prepare(
    "UPDATE hint_sessions SET current_level = ?, attempts_at_level = ?, total_attempts = ?, resolved = ?, hypothesis_pending = ?, state = ?, struggle_minutes = ?, code_submissions = ?, updated_at = datetime('now') WHERE id = ?"
  ),
  insertPattern: sqlite.prepare(
    'INSERT INTO mistake_patterns (student_id, exercise_id, pattern, confidence, source) VALUES (?, ?, ?, ?, ?)'
  ),
  patternsByStudent: sqlite.prepare(
    'SELECT * FROM mistake_patterns WHERE student_id = ? ORDER BY recorded_at DESC LIMIT ?'
  ),
  allPatternsByStudent: sqlite.prepare(
    'SELECT * FROM mistake_patterns WHERE student_id = ? ORDER BY recorded_at ASC'
  ),
  patternsSince: sqlite.prepare(
    'SELECT * FROM mistake_patterns WHERE recorded_at >= ? ORDER BY recorded_at DESC'
  ),
  insertTelemetry: sqlite.prepare(
    'INSERT INTO telemetry (type, student_id, exercise_id, reason, latency_ms, state, failures, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ),
  countTelemetryByType: sqlite.prepare(
    'SELECT COUNT(*) as n FROM telemetry WHERE type = ? AND recorded_at >= ?'
  ),
  telemetryByType: sqlite.prepare(
    'SELECT * FROM telemetry WHERE type = ? AND recorded_at >= ? ORDER BY recorded_at DESC'
  ),
  latestTelemetryByType: sqlite.prepare(
    'SELECT * FROM telemetry WHERE type = ? ORDER BY recorded_at DESC LIMIT 1'
  ),
  insertHypothesis: sqlite.prepare(
    'INSERT INTO hypotheses (student_id, exercise_id, hint_level, text, quality, score_source) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  hypothesesByExercise: sqlite.prepare(
    'SELECT * FROM hypotheses WHERE student_id = ? AND exercise_id = ? ORDER BY recorded_at DESC LIMIT ?'
  ),
  hypothesisQualityByStudent: sqlite.prepare(
    "SELECT COALESCE(quality, 'unscored') AS quality, COUNT(*) AS n FROM hypotheses WHERE student_id = ? GROUP BY quality"
  ),
  hypothesisQualityAll: sqlite.prepare(
    "SELECT COALESCE(quality, 'unscored') AS quality, COUNT(*) AS n FROM hypotheses WHERE quality IS NOT NULL GROUP BY quality"
  ),
  hypothesisQualityByStudentRecent: sqlite.prepare(
    "SELECT COALESCE(quality, 'unscored') AS quality, COUNT(*) AS n FROM hypotheses WHERE student_id = ? AND recorded_at >= ? GROUP BY quality"
  ),
  hypothesisQualityAllRecent: sqlite.prepare(
    "SELECT COALESCE(quality, 'unscored') AS quality, COUNT(*) AS n FROM hypotheses WHERE quality IS NOT NULL AND recorded_at >= ? GROUP BY quality"
  ),
  insertPostMortem: sqlite.prepare(
    'INSERT INTO post_mortems (session_id, student_id, exercise_id, pattern, text, score, feedback) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  postMortemBySession: sqlite.prepare(
    'SELECT * FROM post_mortems WHERE session_id = ? ORDER BY recorded_at DESC LIMIT 1'
  ),
  postMortemsByStudent: sqlite.prepare(
    'SELECT * FROM post_mortems WHERE student_id = ? ORDER BY recorded_at DESC'
  ),
  postMortemStatsByStudent: sqlite.prepare(
    "SELECT pattern, COALESCE(score, 'unscored') AS score, COUNT(*) AS n FROM post_mortems WHERE student_id = ? AND pattern IS NOT NULL GROUP BY pattern, score"
  ),
  insertDeletionAudit: sqlite.prepare(
    `INSERT INTO deletion_audit
       (id, actor_id, actor_email, scope, target_id, target_label, counts_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  updateHypothesisOutcome: sqlite.prepare(
    `UPDATE hypotheses SET outcome = ? WHERE id = ? AND student_id = ? AND exercise_id = ?`
  ),
  postMortemScoreCounts: sqlite.prepare(
    "SELECT COALESCE(score, 'unscored') AS score, COUNT(*) AS n FROM post_mortems WHERE student_id = ? GROUP BY score"
  ),
  tutorFeedbackByExercise: sqlite.prepare(
    `SELECT tf.id, tf.instructor_id, tf.student_id, tf.target_type, tf.target_id,
            tf.text, tf.created_at, tf.updated_at, u.display_name AS instructor_name
     FROM tutor_feedback tf
     LEFT JOIN users u ON u.id = tf.instructor_id
     WHERE tf.student_id = ?
       AND tf.target_id IN (
         SELECT CAST(h.id AS TEXT) FROM hypotheses h
         WHERE h.student_id = ? AND h.exercise_id = ?
         UNION
         SELECT CAST(pm.id AS TEXT) FROM post_mortems pm
         WHERE pm.student_id = ? AND pm.exercise_id = ?
       )
     ORDER BY tf.created_at ASC`
  ),
  insertTutorFeedback: sqlite.prepare(
    `INSERT INTO tutor_feedback
       (id, instructor_id, student_id, target_type, target_id, text)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  deleteTutorFeedback: sqlite.prepare(
    `DELETE FROM tutor_feedback WHERE id = ? AND instructor_id = ?`
  ),
  findTutorFeedbackById: sqlite.prepare(
    `SELECT * FROM tutor_feedback WHERE id = ?`
  ),

  // ── Auth: users ──
  insertUser: sqlite.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role, is_admin) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  findUserByEmail: sqlite.prepare(
    'SELECT * FROM users WHERE email = ?'
  ),
  findUserById: sqlite.prepare(
    'SELECT * FROM users WHERE id = ?'
  ),
  countUsersByRole: sqlite.prepare(
    'SELECT COUNT(*) AS n FROM users WHERE role = ?'
  ),

  // ── Auth: sessions ──
  insertAuthSession: sqlite.prepare(
    'INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ),

  // ── Hint dependency ──
  hintDependencyForStudent: sqlite.prepare(
    `SELECT
       COUNT(*) AS sessions,
       COALESCE(SUM((
         SELECT COUNT(*) FROM telemetry t
         WHERE t.student_id = hs.student_id
           AND t.exercise_id = hs.exercise_id
           AND t.type = 'hint-served'
           AND t.recorded_at >= hs.created_at
       )), 0) AS total_hints
     FROM hint_sessions hs
     WHERE hs.state IN ('resolved', 'complete')
       AND hs.student_id = ?`
  ),
  hintDependencyForStudentInWindow: sqlite.prepare(
    `SELECT
       COUNT(*) AS sessions,
       COALESCE(SUM((
         SELECT COUNT(*) FROM telemetry t
         WHERE t.student_id = hs.student_id
           AND t.exercise_id = hs.exercise_id
           AND t.type = 'hint-served'
           AND t.recorded_at >= hs.created_at
       )), 0) AS total_hints
     FROM hint_sessions hs
     WHERE hs.state IN ('resolved', 'complete')
       AND hs.student_id = ?
       AND hs.created_at >= ?`
  ),
  hintDependencyAll: sqlite.prepare(
    `SELECT
       COUNT(*) AS sessions,
       COUNT(DISTINCT hs.student_id) AS students,
       COALESCE(SUM((
         SELECT COUNT(*) FROM telemetry t
         WHERE t.student_id = hs.student_id
           AND t.exercise_id = hs.exercise_id
           AND t.type = 'hint-served'
           AND t.recorded_at >= hs.created_at
       )), 0) AS total_hints
     FROM hint_sessions hs
     WHERE hs.state IN ('resolved', 'complete')`
  ),

  // ── Invite codes ──
  insertInviteCode: sqlite.prepare(
    'INSERT INTO invite_codes (id, code, role, created_by, expires_at) VALUES (?, ?, ?, ?, ?)'
  ),
  findInviteCode: sqlite.prepare(
    'SELECT * FROM invite_codes WHERE code = ?'
  ),
  listInviteCodes: sqlite.prepare(
    'SELECT * FROM invite_codes ORDER BY created_at DESC'
  ),
  markInviteCodeUsed: sqlite.prepare(
    "UPDATE invite_codes SET used_by = ?, used_at = datetime('now') WHERE code = ? AND used_by IS NULL"
  ),
  deleteInviteCode: sqlite.prepare(
    'DELETE FROM invite_codes WHERE code = ? AND used_by IS NULL'
  ),

  // ── Cohorts ──
  findCohortByInstructor: sqlite.prepare(
    'SELECT * FROM cohorts WHERE instructor_id = ? ORDER BY created_at ASC LIMIT 1'
  ),
  findCohortById: sqlite.prepare(
    'SELECT * FROM cohorts WHERE id = ?'
  ),
  insertCohort: sqlite.prepare(
    'INSERT INTO cohorts (id, name, instructor_id, enrollment_code) VALUES (?, ?, ?, ?)'
  ),

  // ── Cohort membership ──
  insertCohortMember: sqlite.prepare(
    'INSERT OR IGNORE INTO cohort_members (cohort_id, user_id) VALUES (?, ?)'
  ),
  deleteCohortMember: sqlite.prepare(
    'DELETE FROM cohort_members WHERE cohort_id = ? AND user_id = ?'
  ),
  findCohortByEnrollmentCode: sqlite.prepare(
    'SELECT * FROM cohorts WHERE enrollment_code = ?'
  ),
  listCohortsForUser: sqlite.prepare(
    `SELECT c.*, cm.joined_at AS membership_joined_at
     FROM cohort_members cm
     JOIN cohorts c ON c.id = cm.cohort_id
     WHERE cm.user_id = ?
     ORDER BY cm.joined_at DESC`
  ),
  countCohortMembers: sqlite.prepare(
    'SELECT COUNT(*) AS n FROM cohort_members WHERE cohort_id = ?'
  ),
  setCohortEnrollmentCode: sqlite.prepare(
    'UPDATE cohorts SET enrollment_code = ? WHERE id = ?'
  ),
  listCohortsByInstructor: sqlite.prepare(
    'SELECT * FROM cohorts WHERE instructor_id = ? ORDER BY created_at ASC'
  ),
  updateCohortName: sqlite.prepare(
    'UPDATE cohorts SET name = ? WHERE id = ?'
  ),
  deleteCohort: sqlite.prepare(
    'DELETE FROM cohorts WHERE id = ?'
  ),
  countExercisesInCohort: sqlite.prepare(
    'SELECT COUNT(*) AS n FROM exercises WHERE cohort_id = ?'
  ),

  // ── Tutor notes ──
  insertTutorNote: sqlite.prepare(
    'INSERT INTO tutor_notes (id, instructor_id, student_id, cohort_id, text) VALUES (?, ?, ?, ?, ?)'
  ),
  listTutorNotes: sqlite.prepare(
    'SELECT * FROM tutor_notes WHERE instructor_id = ? AND student_id = ? AND cohort_id = ? ORDER BY created_at DESC'
  ),
  findTutorNote: sqlite.prepare(
    'SELECT * FROM tutor_notes WHERE id = ?'
  ),
  deleteTutorNote: sqlite.prepare(
    'DELETE FROM tutor_notes WHERE id = ? AND instructor_id = ?'
  ),
  updateTutorNote: sqlite.prepare(
    "UPDATE tutor_notes SET text = ?, updated_at = datetime('now') WHERE id = ? AND instructor_id = ?"
  ),

  // ── Exercises ──
  insertExercise: sqlite.prepare(
    `INSERT INTO exercises
      (id, slug, title, description, language, starter_code,
       expected_concepts, learning_objectives, struggle_minutes,
       cohort_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  findExerciseById: sqlite.prepare(
    'SELECT * FROM exercises WHERE id = ?'
  ),
  findExerciseBySlug: sqlite.prepare(
    'SELECT * FROM exercises WHERE slug = ?'
  ),
  listExercisesByCohort: sqlite.prepare(
    'SELECT * FROM exercises WHERE cohort_id = ? ORDER BY created_at DESC'
  ),
  updateExercise: sqlite.prepare(
    `UPDATE exercises SET
       title = ?, description = ?, language = ?, starter_code = ?,
       expected_concepts = ?, learning_objectives = ?, struggle_minutes = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ),
  deleteExercise: sqlite.prepare(
    'DELETE FROM exercises WHERE id = ?'
  ),
  findAuthSession: sqlite.prepare(
    "SELECT * FROM auth_sessions WHERE token = ? AND expires_at > datetime('now')"
  ),
  deleteAuthSession: sqlite.prepare(
    'DELETE FROM auth_sessions WHERE token = ?'
  ),
  deleteExpiredAuthSessions: sqlite.prepare(
    "DELETE FROM auth_sessions WHERE expires_at <= datetime('now')"
  ),
};

export const db = {
  users: {
    async create(data: {
      email: string;
      passwordHash: string;
      displayName: string;
      role: 'student' | 'instructor';
      isAdmin?: boolean;
    }): Promise<User> {
      const id = randomUUID();
      const email = data.email.toLowerCase().trim();
      stmt.insertUser.run(
        id,
        email,
        data.passwordHash,
        data.displayName,
        data.role,
        data.isAdmin ? 1 : 0
      );
      const row = stmt.findUserById.get(id) as any;
      return rowToUser(row);
    },
    async findByEmail(email: string): Promise<User | null> {
      const row = stmt.findUserByEmail.get(email.toLowerCase().trim()) as any;
      return row ? rowToUser(row) : null;
    },
    async findById(id: string): Promise<User | null> {
      const row = stmt.findUserById.get(id) as any;
      return row ? rowToUser(row) : null;
    },
    async countByRole(role: 'student' | 'instructor'): Promise<number> {
      const row = stmt.countUsersByRole.get(role) as any;
      return row?.n ?? 0;
    },
  },

  authSessions: {
    async create(data: {
      token: string;
      userId: string;
      ttlDays: number;
    }): Promise<AuthSession> {
      const expiresAt = new Date(Date.now() + data.ttlDays * 24 * 60 * 60 * 1000);
      stmt.insertAuthSession.run(data.token, data.userId, expiresAt.toISOString());
      const row = stmt.findAuthSession.get(data.token) as any;
      return rowToAuthSession(row);
    },
    async findValid(token: string): Promise<AuthSession | null> {
      const row = stmt.findAuthSession.get(token) as any;
      return row ? rowToAuthSession(row) : null;
    },
    async delete(token: string): Promise<void> {
      stmt.deleteAuthSession.run(token);
    },
    async deleteExpired(): Promise<number> {
      const info = stmt.deleteExpiredAuthSessions.run();
      return info.changes ?? 0;
    },
  },

  cohorts: {
    async findById(id: string): Promise<Cohort | null> {
      const row = stmt.findCohortById.get(id) as any;
      return row ? rowToCohort(row) : null;
    },
    async findByInstructor(instructorId: string): Promise<Cohort | null> {
      const row = stmt.findCohortByInstructor.get(instructorId) as any;
      return row ? rowToCohort(row) : null;
    },
    async create(data: {
      name: string;
      instructorId: string;
      enrollmentCode?: string | null;
    }): Promise<Cohort> {
      const id = crypto.randomUUID();
      stmt.insertCohort.run(id, data.name, data.instructorId, data.enrollmentCode ?? null);
      const row = stmt.findCohortById.get(id) as any;
      return rowToCohort(row);
    },
    /**
     * Get the instructor's cohort, creating a default one if they don't
     * have any yet. Every instructor gets exactly one cohort in v1.
     */
    async ensureForInstructor(instructorId: string): Promise<Cohort> {
      const existing = await db.cohorts.findByInstructor(instructorId);
      if (existing) return existing;
      return db.cohorts.create({
        name: 'My Exercises',
        instructorId,
      });
    },
    async findByEnrollmentCode(code: string): Promise<Cohort | null> {
      const row = stmt.findCohortByEnrollmentCode.get(code) as any;
      return row ? rowToCohort(row) : null;
    },
    async setEnrollmentCode(cohortId: string, code: string): Promise<void> {
      stmt.setCohortEnrollmentCode.run(code, cohortId);
    },
    async listForUser(userId: string): Promise<Array<Cohort & { joinedAt: Date }>> {
      const rows = stmt.listCohortsForUser.all(userId) as any[];
      return rows.map((row) => ({
        ...rowToCohort(row),
        joinedAt: parseSqliteTimestamp(row.membership_joined_at),
      }));
    },
    async countMembers(cohortId: string): Promise<number> {
      const row = stmt.countCohortMembers.get(cohortId) as any;
      return row?.n ?? 0;
    },
    async listByInstructor(instructorId: string): Promise<Cohort[]> {
      return (stmt.listCohortsByInstructor.all(instructorId) as any[]).map(rowToCohort);
    },
    async rename(cohortId: string, name: string): Promise<void> {
      stmt.updateCohortName.run(name, cohortId);
    },
    async delete(cohortId: string): Promise<boolean> {
      const info = stmt.deleteCohort.run(cohortId);
      return (info.changes ?? 0) > 0;
    },
    async countExercises(cohortId: string): Promise<number> {
      const row = stmt.countExercisesInCohort.get(cohortId) as any;
      return row?.n ?? 0;
    },
  },

  cohortCleanup: {
    /**
     * Remove all of a student's work for a cohort they're leaving.
     *
     * Deletes rows from hint_sessions, hypotheses, post_mortems,
     * mistake_patterns, and tutor_notes that belong to this student AND
     * to any exercise in this cohort. Does NOT touch work in other
     * cohorts the student belongs to.
     *
     * Returns counts of what was removed, for the API response.
     */
    removeStudentFromCohort(studentId: string, cohortId: string): {
      sessions: number;
      hypotheses: number;
      postMortems: number;
      patterns: number;
      notes: number;
    } {
      const tx = sqlite.transaction(() => {
        // Collect the exercise slugs in this cohort. Every session-like
        // table stores the exercise *slug* (not the UUID), so we work
        // with slugs here.
        const exerciseRows = sqlite
          .prepare('SELECT slug FROM exercises WHERE cohort_id = ?')
          .all(cohortId) as Array<{ slug: string }>;
        const slugs = exerciseRows.map((r) => r.slug);

        let sessions = 0;
        let hypotheses = 0;
        let postMortems = 0;
        let patterns = 0;

        if (slugs.length > 0) {
          const placeholders = slugs.map(() => '?').join(',');

          const s = sqlite
            .prepare(
              `DELETE FROM hint_sessions
               WHERE student_id = ? AND exercise_id IN (${placeholders})`
            )
            .run(studentId, ...slugs);
          sessions = s.changes ?? 0;

          const h = sqlite
            .prepare(
              `DELETE FROM hypotheses
               WHERE student_id = ? AND exercise_id IN (${placeholders})`
            )
            .run(studentId, ...slugs);
          hypotheses = h.changes ?? 0;

          const pm = sqlite
            .prepare(
              `DELETE FROM post_mortems
               WHERE student_id = ? AND exercise_id IN (${placeholders})`
            )
            .run(studentId, ...slugs);
          postMortems = pm.changes ?? 0;

          const mp = sqlite
            .prepare(
              `DELETE FROM mistake_patterns
               WHERE student_id = ? AND exercise_id IN (${placeholders})`
            )
            .run(studentId, ...slugs);
          patterns = mp.changes ?? 0;
        }

        // Tutor notes are scoped by cohort_id directly, not by exercise
        const n = sqlite
          .prepare('DELETE FROM tutor_notes WHERE student_id = ? AND cohort_id = ?')
          .run(studentId, cohortId);
        const notes = n.changes ?? 0;

        return { sessions, hypotheses, postMortems, patterns, notes };
      });

      return tx();
    },

  },

  tutorNotes: {
    async create(data: {
      instructorId: string;
      studentId: string;
      cohortId: string;
      text: string;
    }): Promise<TutorNote> {
      const id = crypto.randomUUID();
      stmt.insertTutorNote.run(
        id,
        data.instructorId,
        data.studentId,
        data.cohortId,
        data.text
      );
      const row = stmt.findTutorNote.get(id) as any;
      return rowToTutorNote(row);
    },

    async list(
      instructorId: string,
      studentId: string,
      cohortId: string
    ): Promise<TutorNote[]> {
      return (stmt.listTutorNotes.all(
        instructorId,
        studentId,
        cohortId
      ) as any[]).map(rowToTutorNote);
    },

    async findById(id: string): Promise<TutorNote | null> {
      const row = stmt.findTutorNote.get(id) as any;
      return row ? rowToTutorNote(row) : null;
    },

    async delete(id: string, instructorId: string): Promise<boolean> {
      const info = stmt.deleteTutorNote.run(id, instructorId);
      return (info.changes ?? 0) > 0;
    },

    async update(id: string, instructorId: string, text: string): Promise<TutorNote | null> {
      const info = stmt.updateTutorNote.run(text, id, instructorId);
      if ((info.changes ?? 0) === 0) return null;
      const row = stmt.findTutorNote.get(id) as any;
      return row ? rowToTutorNote(row) : null;
    },
  },

  cohortMembers: {
    async add(cohortId: string, userId: string): Promise<void> {
      stmt.insertCohortMember.run(cohortId, userId);
    },
    async remove(cohortId: string, userId: string): Promise<boolean> {
      const info = stmt.deleteCohortMember.run(cohortId, userId);
      return (info.changes ?? 0) > 0;
    },
  },

  nudges: {
    /**
     * Get or create the thread between an instructor and a student.
     * There's exactly one thread per pair (UNIQUE constraint).
     */
    ensureThread(instructorId: string, studentId: string, subject: string | null): {
      id: string;
      instructorId: string;
      studentId: string;
      subject: string | null;
      lastMessageAt: string;
      createdAt: string;
    } {
      const existing = sqlite
        .prepare(
          `SELECT id, instructor_id AS instructorId, student_id AS studentId,
                  subject, last_message_at AS lastMessageAt, created_at AS createdAt
           FROM nudge_threads
           WHERE instructor_id = ? AND student_id = ?`
        )
        .get(instructorId, studentId) as any;

      if (existing) return existing;

      const id = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO nudge_threads (id, instructor_id, student_id, subject)
           VALUES (?, ?, ?, ?)`
        )
        .run(id, instructorId, studentId, subject);

      return sqlite
        .prepare(
          `SELECT id, instructor_id AS instructorId, student_id AS studentId,
                  subject, last_message_at AS lastMessageAt, created_at AS createdAt
           FROM nudge_threads WHERE id = ?`
        )
        .get(id) as any;
    },

    getThreadById(threadId: string): any {
      return sqlite
        .prepare(
          `SELECT id, instructor_id AS instructorId, student_id AS studentId,
                  subject, last_message_at AS lastMessageAt, created_at AS createdAt
           FROM nudge_threads WHERE id = ?`
        )
        .get(threadId);
    },

    findThreadBetween(instructorId: string, studentId: string): any {
      return sqlite
        .prepare(
          `SELECT id, instructor_id AS instructorId, student_id AS studentId,
                  subject, last_message_at AS lastMessageAt, created_at AS createdAt
           FROM nudge_threads
           WHERE instructor_id = ? AND student_id = ?`
        )
        .get(instructorId, studentId);
    },

    addMessage(data: {
      threadId: string;
      authorId: string;
      authorRole: 'instructor' | 'student';
      body: string;
    }): {
      id: string;
      threadId: string;
      authorId: string;
      authorRole: string;
      body: string;
      readAt: string | null;
      emailSentAt: string | null;
      createdAt: string;
    } {
      const id = randomUUID();
      const tx = sqlite.transaction(() => {
        sqlite
          .prepare(
            `INSERT INTO nudge_messages
               (id, thread_id, author_id, author_role, body)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(id, data.threadId, data.authorId, data.authorRole, data.body);
        sqlite
          .prepare(`UPDATE nudge_threads SET last_message_at = datetime('now') WHERE id = ?`)
          .run(data.threadId);
      });
      tx();

      return sqlite
        .prepare(
          `SELECT id, thread_id AS threadId, author_id AS authorId,
                  author_role AS authorRole, body, read_at AS readAt,
                  email_sent_at AS emailSentAt, created_at AS createdAt
           FROM nudge_messages WHERE id = ?`
        )
        .get(id) as any;
    },

    listMessages(threadId: string): any[] {
      return sqlite
        .prepare(
          `SELECT id, thread_id AS threadId, author_id AS authorId,
                  author_role AS authorRole, body, read_at AS readAt,
                  email_sent_at AS emailSentAt, created_at AS createdAt
           FROM nudge_messages
           WHERE thread_id = ?
           ORDER BY created_at ASC`
        )
        .all(threadId) as any[];
    },

    markThreadRead(threadId: string, readerId: string): number {
      const r = sqlite
        .prepare(
          `UPDATE nudge_messages
           SET read_at = datetime('now')
           WHERE thread_id = ? AND author_id != ? AND read_at IS NULL`
        )
        .run(threadId, readerId);
      return r.changes ?? 0;
    },

    unreadCount(userId: string): number {
      const row = sqlite
        .prepare(
          `SELECT COUNT(*) AS n
           FROM nudge_messages nm
           JOIN nudge_threads nt ON nt.id = nm.thread_id
           WHERE (nt.instructor_id = ? OR nt.student_id = ?)
             AND nm.author_id != ?
             AND nm.read_at IS NULL`
        )
        .get(userId, userId, userId) as { n: number };
      return row.n;
    },

    listThreadsForUser(userId: string): Array<{
      id: string;
      instructorId: string;
      studentId: string;
      subject: string | null;
      lastMessageAt: string;
      createdAt: string;
      otherPartyName: string;
      otherPartyEmail: string;
      lastMessageBody: string | null;
      lastMessageAtDisplay: string | null;
      unreadCount: number;
    }> {
      const threads = sqlite
        .prepare(
          `SELECT nt.id, nt.instructor_id AS instructorId, nt.student_id AS studentId,
                  nt.subject, nt.last_message_at AS lastMessageAt, nt.created_at AS createdAt
           FROM nudge_threads nt
           WHERE nt.instructor_id = ? OR nt.student_id = ?
           ORDER BY nt.last_message_at DESC`
        )
        .all(userId, userId) as Array<{
          id: string;
          instructorId: string;
          studentId: string;
          subject: string | null;
          lastMessageAt: string;
          createdAt: string;
        }>;

      return threads.map((t) => {
        const otherPartyId = t.instructorId === userId ? t.studentId : t.instructorId;
        const other = sqlite
          .prepare('SELECT display_name AS name, email FROM users WHERE id = ?')
          .get(otherPartyId) as { name: string; email: string } | undefined;

        const lastMsg = sqlite
          .prepare(
            `SELECT body, created_at AS createdAt
             FROM nudge_messages WHERE thread_id = ?
             ORDER BY created_at DESC LIMIT 1`
          )
          .get(t.id) as { body: string; createdAt: string } | undefined;

        const unread = sqlite
          .prepare(
            `SELECT COUNT(*) AS n
             FROM nudge_messages
             WHERE thread_id = ? AND author_id != ? AND read_at IS NULL`
          )
          .get(t.id, userId) as { n: number };

        return {
          ...t,
          otherPartyName: other?.name || 'Unknown',
          otherPartyEmail: other?.email || '',
          lastMessageBody: lastMsg?.body ?? null,
          lastMessageAtDisplay: lastMsg?.createdAt ?? null,
          unreadCount: unread.n,
        };
      });
    },
  },

  sessionEvents: {
    /**
     * Record a single event. `payload` is stored as JSON.
     */
    create(data: {
      sessionId: string;
      studentId: string;
      exerciseId: string;
      type: string;
      payload: unknown;
    }): { id: string; recordedAt: string } {
      const id = randomUUID();
      let payloadJson: string;
      try {
        payloadJson = JSON.stringify(data.payload ?? {});
      } catch {
        payloadJson = '{}';
      }
      sqlite
        .prepare(
          `INSERT INTO session_events
             (id, session_id, student_id, exercise_id, type, payload_json)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          data.sessionId,
          data.studentId,
          data.exerciseId,
          data.type,
          payloadJson
        );
      const row = sqlite
        .prepare('SELECT recorded_at AS recordedAt FROM session_events WHERE id = ?')
        .get(id) as { recordedAt: string };
      return { id, recordedAt: row.recordedAt };
    },

    /**
     * Summary of every session the student owns, with per-session
     * event counts (grouped by type). Used by the 'My sessions' tab.
     */
    listSessionsForStudent(studentId: string): Array<{
      sessionId: string;
      exerciseId: string;
      exerciseTitle: string;
      state: string;
      createdAt: string;
      updatedAt: string;
      eventCount: number;
      eventTypes: Array<{ type: string; count: number }>;
    }> {
      const sessions = sqlite
        .prepare(
          `SELECT hs.id AS sessionId,
                  hs.exercise_id AS exerciseId,
                  COALESCE(e.title, hs.exercise_id) AS exerciseTitle,
                  hs.state,
                  hs.created_at AS createdAt,
                  hs.updated_at AS updatedAt
           FROM hint_sessions hs
           LEFT JOIN exercises e ON e.id = hs.exercise_id OR e.slug = hs.exercise_id
           WHERE hs.student_id = ?
           ORDER BY hs.updated_at DESC`
        )
        .all(studentId) as Array<{
          sessionId: string;
          exerciseId: string;
          exerciseTitle: string;
          state: string;
          createdAt: string;
          updatedAt: string;
        }>;

      return sessions.map((s) => {
        const counts = sqlite
          .prepare(
            `SELECT type, COUNT(*) AS n
             FROM session_events
             WHERE session_id = ?
             GROUP BY type
             ORDER BY type`
          )
          .all(s.sessionId) as Array<{ type: string; n: number }>;
        const total = counts.reduce((sum, c) => sum + c.n, 0);
        return {
          ...s,
          eventCount: total,
          eventTypes: counts.map((c) => ({ type: c.type, count: c.n })),
        };
      });
    },

    /**
     * All events for a session, oldest first. Returns rows with the
     * payload already parsed.
     */
    listForSession(sessionId: string): Array<{
      id: string;
      sessionId: string;
      studentId: string;
      exerciseId: string;
      type: string;
      payload: unknown;
      recordedAt: string;
    }> {
      const rows = sqlite
        .prepare(
          `SELECT id, session_id AS sessionId, student_id AS studentId,
                  exercise_id AS exerciseId, type, payload_json AS payloadJson,
                  recorded_at AS recordedAt
           FROM session_events
           WHERE session_id = ?
           ORDER BY recorded_at ASC, id ASC`
        )
        .all(sessionId) as Array<{
          id: string;
          sessionId: string;
          studentId: string;
          exerciseId: string;
          type: string;
          payloadJson: string;
          recordedAt: string;
        }>;

      return rows.map((r) => {
        let payload: unknown = {};
        try {
          payload = JSON.parse(r.payloadJson);
        } catch {
          payload = { _raw: r.payloadJson };
        }
        return {
          id: r.id,
          sessionId: r.sessionId,
          studentId: r.studentId,
          exerciseId: r.exerciseId,
          type: r.type,
          payload,
          recordedAt: r.recordedAt,
        };
      });
    },
  },

  students: {
    /**
     * Summary stats for a student, restricted to a set of exercise IDs.
     * Used by the roster view.
     */
    statsFor(studentId: string, exerciseIds: string[]): {
      exercisesAttempted: number;
      exercisesCompleted: number;
      lastActiveAt: string | null;
    } {
      if (exerciseIds.length === 0) {
        return { exercisesAttempted: 0, exercisesCompleted: 0, lastActiveAt: null };
      }
      const placeholders = exerciseIds.map(() => '?').join(',');
      const row = sqlite
        .prepare(
          `SELECT
             COUNT(DISTINCT exercise_id) AS attempted,
             COUNT(DISTINCT CASE WHEN state = 'complete' THEN exercise_id END) AS completed,
             MAX(updated_at) AS lastActive
           FROM hint_sessions
           WHERE student_id = ? AND exercise_id IN (${placeholders})`
        )
        .get(studentId, ...exerciseIds) as {
          attempted: number;
          completed: number;
          lastActive: string | null;
        };
      return {
        exercisesAttempted: row?.attempted ?? 0,
        exercisesCompleted: row?.completed ?? 0,
        lastActiveAt: row?.lastActive ?? null,
      };
    },

    /**
     * Names of all cohorts a student is a member of.
     * Used to enrich the student detail payload so the client
     * doesn't have to rely on the roster cache.
     */
    cohortNamesFor(studentId: string): string[] {
      return (sqlite
        .prepare(
          `SELECT c.name AS name
           FROM cohort_members cm
           JOIN cohorts c ON c.id = cm.cohort_id
           WHERE cm.user_id = ?
           ORDER BY c.name`
        )
        .all(studentId) as Array<{ name: string }>).map((r) => r.name);
    },

    /**
     * Exercise slugs in every cohort this student is a member of.
     * Student-scoped counterpart to viewableExerciseIdsFor (which
     * takes an instructor). Used by the student progress dashboard.
     */
    exerciseSlugsForStudent(studentId: string): string[] {
      return (sqlite
        .prepare(
          `SELECT DISTINCT e.slug AS slug
           FROM exercises e
           JOIN cohort_members cm ON cm.cohort_id = e.cohort_id
           WHERE cm.user_id = ?`
        )
        .all(studentId) as Array<{ slug: string }>).map((r) => r.slug);
    },

    /**
     * Aggregate metrics for a set of peer students — used by the cohort
     * comparison panel. Returns one row per student with:
     *   - reasoning: precise / total (as a 0..1 ratio, or null if no data)
     *   - hintDependency: hints / session (or null)
     *   - progress: completed / assigned (0..1, or null if 0 assigned)
     *
     * All three are computed with a single query per metric via GROUP BY.
     * Assigned exercises are provided by the caller (already scoped to
     * the viewing instructor).
     */
    cohortPeerMetricsFor(
      peerIds: string[],
      exerciseIds: string[]
    ): Array<{
      studentId: string;
      reasoningQuality: number | null;
      hintDependency: number | null;
      progress: number | null;
    }> {
      if (peerIds.length === 0 || exerciseIds.length === 0) return [];

      const studentPlaceholders = peerIds.map(() => '?').join(',');
      const exercisePlaceholders = exerciseIds.map(() => '?').join(',');

      // Reasoning: precise / total per student
      const reasoningRows = sqlite
        .prepare(
          `SELECT student_id AS studentId,
                  COUNT(*) AS total,
                  SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
           FROM hypotheses
           WHERE student_id IN (${studentPlaceholders})
             AND exercise_id IN (${exercisePlaceholders})
             AND quality IS NOT NULL
           GROUP BY student_id`
        )
        .all(...peerIds, ...exerciseIds) as Array<{
          studentId: string;
          total: number;
          precise: number;
        }>;

      const reasoningMap = new Map<string, number>();
      for (const r of reasoningRows) {
        if (r.total > 0) reasoningMap.set(r.studentId, r.precise / r.total);
      }

      // Hint dependency: total hints / session count per student
      const hintRows = sqlite
        .prepare(
          `SELECT hs.student_id AS studentId,
                  COUNT(DISTINCT hs.id) AS sessions,
                  COALESCE(SUM((
                    SELECT COUNT(*) FROM telemetry t
                    WHERE t.student_id = hs.student_id
                      AND t.exercise_id = hs.exercise_id
                      AND t.type = 'hint-served'
                      AND t.recorded_at >= hs.created_at
                      AND t.recorded_at <= hs.updated_at
                  )), 0) AS hints
           FROM hint_sessions hs
           WHERE hs.student_id IN (${studentPlaceholders})
             AND hs.exercise_id IN (${exercisePlaceholders})
             AND hs.state IN ('resolved', 'complete')
           GROUP BY hs.student_id`
        )
        .all(...peerIds, ...exerciseIds) as Array<{
          studentId: string;
          sessions: number;
          hints: number;
        }>;

      const hintMap = new Map<string, number>();
      for (const r of hintRows) {
        if (r.sessions > 0) hintMap.set(r.studentId, r.hints / r.sessions);
      }

      // Progress: completed / assigned per student
      const progressRows = sqlite
        .prepare(
          `SELECT student_id AS studentId,
                  COUNT(DISTINCT CASE WHEN state = 'complete' THEN exercise_id END) AS completed
           FROM hint_sessions
           WHERE student_id IN (${studentPlaceholders})
             AND exercise_id IN (${exercisePlaceholders})
           GROUP BY student_id`
        )
        .all(...peerIds, ...exerciseIds) as Array<{
          studentId: string;
          completed: number;
        }>;

      const progressMap = new Map<string, number>();
      const assigned = exerciseIds.length;
      for (const r of progressRows) {
        progressMap.set(r.studentId, assigned > 0 ? r.completed / assigned : 0);
      }

      return peerIds.map((studentId) => ({
        studentId,
        reasoningQuality: reasoningMap.has(studentId) ? reasoningMap.get(studentId)! : null,
        hintDependency: hintMap.has(studentId) ? hintMap.get(studentId)! : null,
        progress: progressMap.has(studentId) ? progressMap.get(studentId)! : 0,
      }));
    },

    /**
     * Per-student activity summary over the last N days, for the
     * heatmap. Batched across multiple students in a single call
     * (used by the roster). Returns a Map keyed by student_id.
     *
     * Counts events from three sources (no telemetry in v1):
     *   - hypotheses.recorded_at
     *   - hint_sessions.updated_at
     *   - post_mortems.recorded_at
     */
    activityForMany(
      studentIds: string[],
      exerciseIds: string[],
      days: number
    ): Map<string, ActivitySummary> {
      const out = new Map<string, ActivitySummary>();
      if (studentIds.length === 0 || exerciseIds.length === 0) {
        for (const id of studentIds) out.set(id, buildActivitySummary([], days));
        return out;
      }

      const sPlaceholders = studentIds.map(() => '?').join(',');
      const ePlaceholders = exerciseIds.map(() => '?').join(',');

      // UNION ALL across sources, grouped by (student, date)
      const rows = sqlite
        .prepare(
          `SELECT student_id AS studentId, day, SUM(n) AS n FROM (
             SELECT student_id, date(recorded_at) AS day, COUNT(*) AS n
             FROM hypotheses
             WHERE student_id IN (${sPlaceholders})
               AND exercise_id IN (${ePlaceholders})
               AND recorded_at >= datetime('now', '-' || ? || ' days')
             GROUP BY student_id, day
             UNION ALL
             SELECT student_id, date(updated_at) AS day, COUNT(*) AS n
             FROM hint_sessions
             WHERE student_id IN (${sPlaceholders})
               AND exercise_id IN (${ePlaceholders})
               AND updated_at >= datetime('now', '-' || ? || ' days')
             GROUP BY student_id, day
             UNION ALL
             SELECT student_id, date(recorded_at) AS day, COUNT(*) AS n
             FROM post_mortems
             WHERE student_id IN (${sPlaceholders})
               AND exercise_id IN (${ePlaceholders})
               AND recorded_at >= datetime('now', '-' || ? || ' days')
             GROUP BY student_id, day
           )
           GROUP BY studentId, day
           ORDER BY studentId, day`
        )
        .all(
          ...studentIds, ...exerciseIds, days,
          ...studentIds, ...exerciseIds, days,
          ...studentIds, ...exerciseIds, days
        ) as Array<{ studentId: string; day: string; n: number }>;

      // Bucket per student
      const byStudent = new Map<string, Array<{ date: string; count: number }>>();
      for (const r of rows) {
        if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
        byStudent.get(r.studentId)!.push({ date: r.day, count: r.n });
      }

      for (const id of studentIds) {
        const events = byStudent.get(id) || [];
        out.set(id, buildActivitySummary(events, days));
      }
      return out;
    },

    /**
     * Full student detail: metrics, weak spots, session history.
     * Scoped to exerciseIds the viewing instructor is allowed to see.
     */
    detailFor(studentId: string, exerciseIds: string[]): {
      metrics: {
        reasoningQuality: { total: number; vague: number; plausible: number; precise: number; unscored: number };
        hintDependency: { sessions: number; totalHints: number; avgHintsPerSession: number };
      };
      weakSpots: Array<{ pattern: string; count: number }>;
      sessionHistory: Array<{
        exerciseId: string;
        exerciseTitle: string;
        state: string;
        currentLevel: number;
        totalAttempts: number;
        createdAt: string;
        updatedAt: string;
        struggleMinutes: number;
        durationMinutes: number | null;
      }>;
      timeMetrics: TimeMetrics;
      hypothesisOutcomes: {
        confirmed: number;
        refuted: number;
        unclear: number;
        untested: number;
        confirmationRate: number | null;
      };
      trends: {
        reasoningQuality: { points: Array<{ weekStart: string; value: number | null; sample: number }>; classification: 'improving' | 'worsening' | 'stable' };
        hintDependency: { points: Array<{ weekStart: string; value: number | null; sample: number }>; classification: 'improving' | 'worsening' | 'stable' };
        progress: { points: Array<{ weekStart: string; value: number | null; sample: number }>; classification: 'improving' | 'worsening' | 'stable' };
      };
      strengths: Strength[];
    } {
      if (exerciseIds.length === 0) {
        const weekStarts = lastNWeekStarts(12);
        const emptyTrend = {
          points: weekStarts.map((weekStart) => ({ weekStart, value: null, sample: 0 })),
          classification: 'stable' as const,
        };
        return {
          metrics: {
            reasoningQuality: { total: 0, vague: 0, plausible: 0, precise: 0, unscored: 0 },
            hintDependency: { sessions: 0, totalHints: 0, avgHintsPerSession: 0 },
          },
          weakSpots: [],
          sessionHistory: [],
          timeMetrics: deriveTimeMetrics([]),
          hypothesisOutcomes: {
            confirmed: 0, refuted: 0, unclear: 0, untested: 0,
            confirmationRate: null,
          },
          trends: {
            reasoningQuality: emptyTrend,
            hintDependency: emptyTrend,
            progress: emptyTrend,
          },
          strengths: [],
        };
      }
      const placeholders = exerciseIds.map(() => '?').join(',');

      // Reasoning quality
      const reasoningRows = sqlite
        .prepare(
          `SELECT COALESCE(quality, 'unscored') AS quality, COUNT(*) AS n
           FROM hypotheses
           WHERE student_id = ? AND exercise_id IN (${placeholders})
           GROUP BY quality`
        )
        .all(studentId, ...exerciseIds) as Array<{ quality: string; n: number }>;

      const reasoning = { total: 0, vague: 0, plausible: 0, precise: 0, unscored: 0 };
      for (const r of reasoningRows) {
        if (r.quality === 'vague') reasoning.vague = r.n;
        else if (r.quality === 'plausible') reasoning.plausible = r.n;
        else if (r.quality === 'precise') reasoning.precise = r.n;
        else reasoning.unscored += r.n;
        reasoning.total += r.n;
      }

      // Hint dependency: hints per resolved session
      const depRow = sqlite
        .prepare(
          `SELECT
             COUNT(*) AS sessions,
             COALESCE(SUM((
               SELECT COUNT(*) FROM telemetry t
               WHERE t.student_id = hs.student_id
                 AND t.exercise_id = hs.exercise_id
                 AND t.type = 'hint-served'
                 AND t.recorded_at >= hs.created_at
             )), 0) AS total_hints
           FROM hint_sessions hs
           WHERE hs.student_id = ? AND hs.exercise_id IN (${placeholders})
             AND hs.state IN ('resolved', 'complete')`
        )
        .get(studentId, ...exerciseIds) as { sessions: number; total_hints: number };

      const sessions = depRow?.sessions ?? 0;
      const totalHints = depRow?.total_hints ?? 0;

      // Weak spots
      const weakRows = sqlite
        .prepare(
          `SELECT pattern, COUNT(*) AS n
           FROM mistake_patterns
           WHERE student_id = ? AND exercise_id IN (${placeholders})
           GROUP BY pattern
           ORDER BY n DESC
           LIMIT 10`
        )
        .all(studentId, ...exerciseIds) as Array<{ pattern: string; n: number }>;

      // Session history
      const sessionRows = sqlite
        .prepare(
          `SELECT
             hs.exercise_id AS exerciseId,
             COALESCE(e.title, hs.exercise_id) AS exerciseTitle,
             hs.state,
             hs.current_level AS currentLevel,
             hs.total_attempts AS totalAttempts,
             hs.created_at AS createdAt,
             hs.updated_at AS updatedAt,
             hs.struggle_minutes AS struggleMinutes,
             CAST(ROUND((julianday(hs.updated_at) - julianday(hs.created_at)) * 24 * 60) AS INTEGER) AS durationMinutes
           FROM hint_sessions hs
           LEFT JOIN exercises e ON e.id = hs.exercise_id OR e.slug = hs.exercise_id
           WHERE hs.student_id = ? AND hs.exercise_id IN (${placeholders})
           ORDER BY hs.updated_at DESC`
        )
        .all(studentId, ...exerciseIds) as Array<{
          exerciseId: string;
          exerciseTitle: string;
          state: string;
          currentLevel: number;
          totalAttempts: number;
          createdAt: string;
          updatedAt: string;
          struggleMinutes: number;
          durationMinutes: number | null;
        }>;

      // Weekly trends for the last 12 weeks
      const weekStarts = lastNWeekStarts(12);

      const reasoningTrend = fillWeeks(
        db.students.reasoningTrendFor(studentId, exerciseIds),
        weekStarts
      );
      const hintDepTrend = fillWeeks(
        db.students.hintDependencyTrendFor(studentId, exerciseIds),
        weekStarts
      );
      const progressTrend = fillWeeks(
        db.students.progressTrendFor(studentId, exerciseIds),
        weekStarts
      );

      // Post-mortem score counts, scoped to viewable exercises
      const pmRows = sqlite
        .prepare(
          `SELECT COALESCE(score, 'unscored') AS score, COUNT(*) AS n
           FROM post_mortems
           WHERE student_id = ? AND exercise_id IN (${placeholders})
           GROUP BY score`
        )
        .all(studentId, ...exerciseIds) as Array<{
          score: string;
          n: number;
        }>;
      const postMortemScores = { strong: 0, partial: 0, weak: 0, unscored: 0 };
      for (const r of pmRows) {
        if (r.score === 'strong') postMortemScores.strong = r.n;
        else if (r.score === 'partial') postMortemScores.partial = r.n;
        else if (r.score === 'weak') postMortemScores.weak = r.n;
        else postMortemScores.unscored += r.n;
      }
      const postMortemTotal =
        postMortemScores.strong +
        postMortemScores.partial +
        postMortemScores.weak +
        postMortemScores.unscored;

      const reasoningClassification = classifyTrend(reasoningTrend);
      const hintDepClassification = classifyTrend(hintDepTrend, {
        lowerIsBetter: true,
        threshold: 0.3,
      });

      const strengths = deriveStrengths({
        reasoning,
        reasoningTrend: { classification: reasoningClassification },
        hintDependency: {
          sessions,
          totalHints,
          avgHintsPerSession: sessions > 0 ? totalHints / sessions : 0,
        },
        sessionsAttempted: sessionRows.length,
        sessionsCompleted: sessionRows.filter((r) => r.state === 'complete').length,
        postMortemStrongCount: postMortemScores.strong,
        postMortemTotal,
      });

      const timeMetrics = deriveTimeMetrics(
        sessionRows.map((r) => ({
          exerciseId: r.exerciseId,
          exerciseTitle: r.exerciseTitle,
          struggleMinutes: r.struggleMinutes || 0,
          durationMinutes: r.durationMinutes,
        }))
      );

      // Hypothesis outcomes summary
      const outcomeRows = sqlite
        .prepare(
          `SELECT COALESCE(outcome, 'untested') AS outcome, COUNT(*) AS n
           FROM hypotheses
           WHERE student_id = ? AND exercise_id IN (${placeholders})
           GROUP BY outcome`
        )
        .all(studentId, ...exerciseIds) as Array<{ outcome: string; n: number }>;
      const ho = { confirmed: 0, refuted: 0, unclear: 0, untested: 0 };
      for (const r of outcomeRows) {
        if (r.outcome === 'confirmed') ho.confirmed = r.n;
        else if (r.outcome === 'refuted') ho.refuted = r.n;
        else if (r.outcome === 'unclear') ho.unclear = r.n;
        else ho.untested += r.n;
      }
      const tested = ho.confirmed + ho.refuted;
      const hypothesisOutcomes = {
        ...ho,
        confirmationRate: tested > 0 ? ho.confirmed / tested : null,
      };

      return {
        metrics: {
          reasoningQuality: reasoning,
          hintDependency: {
            sessions,
            totalHints,
            avgHintsPerSession: sessions > 0 ? totalHints / sessions : 0,
          },
        },
        weakSpots: weakRows.map((r) => ({ pattern: r.pattern, count: r.n })),
        sessionHistory: sessionRows,
        timeMetrics,
        hypothesisOutcomes,
        trends: {
          reasoningQuality: {
            points: reasoningTrend,
            classification: reasoningClassification,
          },
          hintDependency: {
            points: hintDepTrend,
            classification: hintDepClassification,
          },
          progress: {
            points: progressTrend,
            classification: classifyTrend(progressTrend),
          },
        },
        strengths,
      };
    },

    /**
     * Per-exercise detail for one (student, exercise) pair.
     */
    exerciseDetailFor(studentId: string, exerciseId: string): {
      session: {
        state: string;
        currentLevel: number;
        totalAttempts: number;
        createdAt: string;
        updatedAt: string;
      } | null;
      hypotheses: Array<{
        id: number;
        level: number;
        text: string;
        quality: string | null;
        outcome: string | null;
        createdAt: string;
        tutorFeedback: TutorFeedback[];
      }>;
      postMortems: Array<{
        id: number;
        text: string;
        score: string;
        scorerFeedback: string;
        createdAt: string;
        tutorFeedback: TutorFeedback[];
      }>;
    } | null {
      const sessionRow = sqlite
        .prepare(
          `SELECT state, current_level AS currentLevel, total_attempts AS totalAttempts,
                  created_at AS createdAt, updated_at AS updatedAt
           FROM hint_sessions
           WHERE student_id = ? AND exercise_id = ?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(studentId, exerciseId) as any;

      const hypotheses = sqlite
        .prepare(
          `SELECT id, hint_level AS level, text, quality, outcome, recorded_at AS createdAt
           FROM hypotheses
           WHERE student_id = ? AND exercise_id = ?
           ORDER BY recorded_at ASC`
        )
        .all(studentId, exerciseId) as any[];

      const postMortems = sqlite
        .prepare(
          `SELECT id, text, score, feedback AS scorerFeedback, recorded_at AS createdAt
           FROM post_mortems
           WHERE student_id = ? AND exercise_id = ?
           ORDER BY recorded_at DESC`
        )
        .all(studentId, exerciseId) as any[];

      if (!sessionRow && hypotheses.length === 0 && postMortems.length === 0) {
        return null;
      }

      // Attach tutor feedback to each hypothesis and post-mortem.
      const feedbackRows = stmt.tutorFeedbackByExercise.all(
        studentId,
        studentId,
        exerciseId,
        studentId,
        exerciseId
      ) as any[];
      const feedbackByTarget = new Map<string, TutorFeedback[]>();
      for (const row of feedbackRows) {
        const key = row.target_type + ':' + row.target_id;
        if (!feedbackByTarget.has(key)) feedbackByTarget.set(key, []);
        feedbackByTarget.get(key)!.push(rowToTutorFeedback(row));
      }

      const hypothesesWithFeedback = hypotheses.map((h) => ({
        ...h,
        tutorFeedback: feedbackByTarget.get('hypothesis:' + String(h.id)) || [],
      }));
      const postMortemsWithFeedback = postMortems.map((pm) => ({
        ...pm,
        tutorFeedback: feedbackByTarget.get('post_mortem:' + String(pm.id)) || [],
      }));

      return {
        session: sessionRow ?? null,
        hypotheses: hypothesesWithFeedback,
        postMortems: postMortemsWithFeedback,
      };
    },

    /**
     * Set or clear a hypothesis outcome. Only three values allowed
     * plus null (which clears).
     */
    updateHypothesisOutcome(
      studentId: string,
      exerciseId: string,
      hypothesisId: number,
      outcome: 'confirmed' | 'refuted' | 'unclear' | null
    ): boolean {
      if (
        outcome !== null &&
        outcome !== 'confirmed' &&
        outcome !== 'refuted' &&
        outcome !== 'unclear'
      ) {
        throw new Error('Invalid outcome value.');
      }
      const result = stmt.updateHypothesisOutcome.run(
        outcome,
        hypothesisId,
        studentId,
        exerciseId
      );
      return result.changes > 0;
    },

    /**
     * Reset a student's progress on a single exercise.
     * Removes their sessions, hypotheses, post-mortems, and mistake patterns.
     * Returns counts of what was removed.
     */
    resetProgress(studentId: string, exerciseId: string): {
      sessions: number;
      hypotheses: number;
      postMortems: number;
      patterns: number;
    } {
      const tx = sqlite.transaction(() => {
        const s = sqlite.prepare('DELETE FROM hint_sessions WHERE student_id = ? AND exercise_id = ?').run(studentId, exerciseId);
        const h = sqlite.prepare('DELETE FROM hypotheses WHERE student_id = ? AND exercise_id = ?').run(studentId, exerciseId);
        const p = sqlite.prepare('DELETE FROM post_mortems WHERE student_id = ? AND exercise_id = ?').run(studentId, exerciseId);
        const m = sqlite.prepare('DELETE FROM mistake_patterns WHERE student_id = ? AND exercise_id = ?').run(studentId, exerciseId);
        return {
          sessions: s.changes ?? 0,
          hypotheses: h.changes ?? 0,
          postMortems: p.changes ?? 0,
          patterns: m.changes ?? 0,
        };
      });
      return tx();
    },
    /**
     * Weekly reasoning-quality trend for the last N weeks, scoped to
     * the given exercise IDs. Returns one row per week that has data;
     * the caller fills missing weeks.
     *
     * Value = precise_count / total_scored_count for that week.
     */
    reasoningTrendFor(
      studentId: string,
      exerciseIds: string[],
      weeks = 12
    ): Array<{ week_start: string; value: number | null; sample: number }> {
      if (exerciseIds.length === 0) return [];
      const placeholders = exerciseIds.map(() => '?').join(',');
      const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const rows = sqlite
        .prepare(
          `SELECT
             date(recorded_at, 'weekday 1', '-7 days') AS week_start,
             COUNT(*) AS total,
             SUM(CASE WHEN quality = 'precise' THEN 1 ELSE 0 END) AS precise
           FROM hypotheses
           WHERE student_id = ?
             AND exercise_id IN (${placeholders})
             AND quality IS NOT NULL
             AND recorded_at >= ?
           GROUP BY week_start
           ORDER BY week_start`
        )
        .all(studentId, ...exerciseIds, since) as Array<{
          week_start: string;
          total: number;
          precise: number;
        }>;

      return rows.map((r) => ({
        week_start: r.week_start,
        value: r.total > 0 ? r.precise / r.total : null,
        sample: r.total,
      }));
    },

    /**
     * Weekly hint-dependency trend. Value = hints_served / completed_sessions
     * for sessions resolved or completed in that week.
     */
    hintDependencyTrendFor(
      studentId: string,
      exerciseIds: string[],
      weeks = 12
    ): Array<{ week_start: string; value: number | null; sample: number }> {
      if (exerciseIds.length === 0) return [];
      const placeholders = exerciseIds.map(() => '?').join(',');
      const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const rows = sqlite
        .prepare(
          `SELECT
             date(hs.updated_at, 'weekday 1', '-7 days') AS week_start,
             COUNT(DISTINCT hs.id) AS sessions,
             COALESCE(SUM((
               SELECT COUNT(*) FROM telemetry t
               WHERE t.student_id = hs.student_id
                 AND t.exercise_id = hs.exercise_id
                 AND t.type = 'hint-served'
                 AND t.recorded_at >= hs.created_at
                 AND t.recorded_at <= hs.updated_at
             )), 0) AS hints
           FROM hint_sessions hs
           WHERE hs.student_id = ?
             AND hs.exercise_id IN (${placeholders})
             AND hs.state IN ('resolved', 'complete')
             AND hs.updated_at >= ?
           GROUP BY week_start
           ORDER BY week_start`
        )
        .all(studentId, ...exerciseIds, since) as Array<{
          week_start: string;
          sessions: number;
          hints: number;
        }>;

      return rows.map((r) => ({
        week_start: r.week_start,
        value: r.sessions > 0 ? r.hints / r.sessions : null,
        sample: r.sessions,
      }));
    },

    /**
     * Weekly progress trend. Value = completed_sessions / attempted_sessions
     * for sessions first created in that week.
     */
    progressTrendFor(
      studentId: string,
      exerciseIds: string[],
      weeks = 12
    ): Array<{ week_start: string; value: number | null; sample: number }> {
      if (exerciseIds.length === 0) return [];
      const placeholders = exerciseIds.map(() => '?').join(',');
      const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const rows = sqlite
        .prepare(
          `SELECT
             date(created_at, 'weekday 1', '-7 days') AS week_start,
             COUNT(*) AS attempted,
             SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS completed
           FROM hint_sessions
           WHERE student_id = ?
             AND exercise_id IN (${placeholders})
             AND created_at >= ?
           GROUP BY week_start
           ORDER BY week_start`
        )
        .all(studentId, ...exerciseIds, since) as Array<{
          week_start: string;
          attempted: number;
          completed: number;
        }>;

      return rows.map((r) => ({
        week_start: r.week_start,
        value: r.attempted > 0 ? r.completed / r.attempted : null,
        sample: r.attempted,
      }));
    },

  },

  exercises: {
    async findById(id: string): Promise<Exercise | null> {
      const row = stmt.findExerciseById.get(id) as any;
      return row ? rowToExercise(row) : null;
    },
    async findBySlug(slug: string): Promise<Exercise | null> {
      const row = stmt.findExerciseBySlug.get(slug) as any;
      return row ? rowToExercise(row) : null;
    },
    async listByCohort(cohortId: string): Promise<Exercise[]> {
      return (stmt.listExercisesByCohort.all(cohortId) as any[]).map(rowToExercise);
    },
    async create(data: {
      slug: string;
      title: string;
      description: string;
      language: string;
      starterCode: string;
      expectedConcepts: string[];
      learningObjectives: string[];
      struggleMinutes: number;
      cohortId: string | null;
      createdBy: string | null;
    }): Promise<Exercise> {
      const id = crypto.randomUUID();
      stmt.insertExercise.run(
        id,
        data.slug,
        data.title,
        data.description,
        data.language,
        data.starterCode,
        JSON.stringify(data.expectedConcepts),
        JSON.stringify(data.learningObjectives),
        data.struggleMinutes,
        data.cohortId,
        data.createdBy
      );
      const row = stmt.findExerciseById.get(id) as any;
      return rowToExercise(row);
    },
    async update(id: string, patch: Partial<{
      title: string;
      description: string;
      language: string;
      starterCode: string;
      expectedConcepts: string[];
      learningObjectives: string[];
      struggleMinutes: number;
    }>): Promise<void> {
      const current = await db.exercises.findById(id);
      if (!current) return;
      const merged = { ...current, ...patch };
      stmt.updateExercise.run(
        merged.title,
        merged.description,
        merged.language,
        merged.starterCode,
        JSON.stringify(merged.expectedConcepts),
        JSON.stringify(merged.learningObjectives),
        merged.struggleMinutes,
        id
      );
    },
    async delete(id: string): Promise<boolean> {
      const info = stmt.deleteExercise.run(id);
      return (info.changes ?? 0) > 0;
    },
    /**
     * All exercises in every cohort the given user is a member of.
     * Used by students to pick an exercise.
     */
    async listForUserCohorts(userId: string): Promise<Array<{
      id: string;
      slug: string;
      title: string;
      language: string;
      cohortId: string;
      cohortName: string;
    }>> {
      return (sqlite
        .prepare(
          `SELECT e.id, e.slug, e.title, e.language, e.cohort_id AS cohortId, c.name AS cohortName
           FROM exercises e
           JOIN cohorts c ON c.id = e.cohort_id
           JOIN cohort_members cm ON cm.cohort_id = c.id
           WHERE cm.user_id = ?
           ORDER BY c.name, e.title`
        )
        .all(userId) as any[]).map((row) => ({
          id: row.id,
          slug: row.slug,
          title: row.title,
          language: row.language,
          cohortId: row.cohortId,
          cohortName: row.cohortName,
        }));
    },
  },

  deletion: {
    /**
     * Purge a student's work data, scoped to the given exerciseIds.
     * Only rows for exercises the calling instructor can see are removed.
     * The user row and cohort_membership are preserved.
     *
     * Everything runs inside one SQLite transaction — any failure rolls
     * back the entire purge.
     */
    purgeStudentData(
      studentId: string,
      exerciseIds: string[]
    ): {
      hypotheses: number;
      hint_sessions: number;
      post_mortems: number;
      mistake_patterns: number;
      telemetry: number;
      tutor_notes: number;
      tutor_feedback: number;
      nudges: number;
    } {
      if (exerciseIds.length === 0) {
        return {
          hypotheses: 0, hint_sessions: 0, post_mortems: 0,
          mistake_patterns: 0, telemetry: 0, tutor_notes: 0, tutor_feedback: 0,
          nudges: 0,
        };
      }
      const placeholders = exerciseIds.map(() => '?').join(',');

      const run = sqlite.transaction(() => {
        // Content tables — scoped by student + exercise set
        const h = sqlite
          .prepare(`DELETE FROM hypotheses WHERE student_id = ? AND exercise_id IN (${placeholders})`)
          .run(studentId, ...exerciseIds);
        const hs = sqlite
          .prepare(`DELETE FROM hint_sessions WHERE student_id = ? AND exercise_id IN (${placeholders})`)
          .run(studentId, ...exerciseIds);
        const pm = sqlite
          .prepare(`DELETE FROM post_mortems WHERE student_id = ? AND exercise_id IN (${placeholders})`)
          .run(studentId, ...exerciseIds);
        const mp = sqlite
          .prepare(`DELETE FROM mistake_patterns WHERE student_id = ? AND exercise_id IN (${placeholders})`)
          .run(studentId, ...exerciseIds);
        const tel = sqlite
          .prepare(`DELETE FROM telemetry WHERE student_id = ? AND exercise_id IN (${placeholders})`)
          .run(studentId, ...exerciseIds);

        // Tutor notes / feedback: student-authored only. Notes are
        // per-cohort, not per-exercise — so we only delete notes that the
        // *student* authored (there are none in practice, but be precise).
        // Tutor notes ABOUT the student are left intact for the audit trail;
        // their author (instructor) can delete them manually.
        const tn = sqlite
          .prepare(`DELETE FROM tutor_notes WHERE student_id = ? AND instructor_id = ?`)
          .run(studentId, studentId);
        const tf = sqlite
          .prepare(`DELETE FROM tutor_feedback WHERE student_id = ? AND instructor_id = ?`)
          .run(studentId, studentId);

        // Nudges: delete all threads involving this student (FK cascades
        // handle the nudge_messages). Both instructor- and student-authored
        // threads are wiped since the student is the target of this purge.
        const nd = sqlite
          .prepare(`DELETE FROM nudge_threads WHERE student_id = ? OR instructor_id = ?`)
          .run(studentId, studentId);

        return {
          hypotheses: h.changes ?? 0,
          hint_sessions: hs.changes ?? 0,
          post_mortems: pm.changes ?? 0,
          mistake_patterns: mp.changes ?? 0,
          telemetry: tel.changes ?? 0,
          tutor_notes: tn.changes ?? 0,
          tutor_feedback: tf.changes ?? 0,
          nudges: nd.changes ?? 0,
        };
      });

      return run();
    },

    /**
     * Purge a cohort: all work data for every student in the cohort,
     * then the cohort's exercises, cohort_members rows, cohort tutor_notes,
     * and finally the cohort row itself.
     *
     * Requires the caller to have already verified the actor is the
     * cohort's primary instructor.
     */
    purgeCohortData(cohortId: string): {
      students_cleared: number;
      hypotheses: number;
      hint_sessions: number;
      post_mortems: number;
      mistake_patterns: number;
      telemetry: number;
      tutor_notes: number;
      tutor_feedback: number;
      cohort_members: number;
      exercises: number;
      cohort: number;
    } {
      // Gather all exercise slugs for this cohort up front
      const exercises = sqlite
        .prepare('SELECT slug FROM exercises WHERE cohort_id = ?')
        .all(cohortId) as Array<{ slug: string }>;
      const slugs = exercises.map((e) => e.slug);

      // Gather all student IDs in the cohort
      const students = sqlite
        .prepare('SELECT user_id AS id FROM cohort_members WHERE cohort_id = ?')
        .all(cohortId) as Array<{ id: string }>;
      const studentIds = students.map((s) => s.id);

      const run = sqlite.transaction(() => {
        let h = 0, hs = 0, pm = 0, mp = 0, tel = 0, tn = 0, tf = 0;

        if (studentIds.length > 0 && slugs.length > 0) {
          const sP = studentIds.map(() => '?').join(',');
          const eP = slugs.map(() => '?').join(',');
          h = sqlite.prepare(`DELETE FROM hypotheses WHERE student_id IN (${sP}) AND exercise_id IN (${eP})`).run(...studentIds, ...slugs).changes ?? 0;
          hs = sqlite.prepare(`DELETE FROM hint_sessions WHERE student_id IN (${sP}) AND exercise_id IN (${eP})`).run(...studentIds, ...slugs).changes ?? 0;
          pm = sqlite.prepare(`DELETE FROM post_mortems WHERE student_id IN (${sP}) AND exercise_id IN (${eP})`).run(...studentIds, ...slugs).changes ?? 0;
          mp = sqlite.prepare(`DELETE FROM mistake_patterns WHERE student_id IN (${sP}) AND exercise_id IN (${eP})`).run(...studentIds, ...slugs).changes ?? 0;
          tel = sqlite.prepare(`DELETE FROM telemetry WHERE student_id IN (${sP}) AND exercise_id IN (${eP})`).run(...studentIds, ...slugs).changes ?? 0;
        }

        // Tutor notes attached to this cohort (per the schema, tutor_notes has a cohort_id)
        tn = sqlite.prepare('DELETE FROM tutor_notes WHERE cohort_id = ?').run(cohortId).changes ?? 0;

        // Tutor feedback authored *about* students in this cohort for exercises in this cohort
        if (studentIds.length > 0 && slugs.length > 0) {
          const sP = studentIds.map(() => '?').join(',');
          const eP = slugs.map(() => '?').join(',');
          // Feedback targets hypotheses / post-mortems — those are gone now,
          // but rows remain if their target_id is orphaned. Best-effort cleanup:
          tf = sqlite.prepare(`DELETE FROM tutor_feedback WHERE student_id IN (${sP})`).run(...studentIds).changes ?? 0;
        }

        // Cohort members
        const cm = sqlite.prepare('DELETE FROM cohort_members WHERE cohort_id = ?').run(cohortId).changes ?? 0;

        // Exercises belonging to the cohort
        const ex = sqlite.prepare('DELETE FROM exercises WHERE cohort_id = ?').run(cohortId).changes ?? 0;

        // Nudge threads for any student in this cohort (any instructor)
        let nd = 0;
        if (studentIds.length > 0) {
          const sP = studentIds.map(() => '?').join(',');
          nd = sqlite
            .prepare(`DELETE FROM nudge_threads WHERE student_id IN (${sP})`)
            .run(...studentIds).changes ?? 0;
        }

        // The cohort itself
        const c = sqlite.prepare('DELETE FROM cohorts WHERE id = ?').run(cohortId).changes ?? 0;

        return {
          students_cleared: studentIds.length,
          hypotheses: h, hint_sessions: hs, post_mortems: pm,
          mistake_patterns: mp, telemetry: tel,
          tutor_notes: tn, tutor_feedback: tf,
          cohort_members: cm, exercises: ex, cohort: c,
          nudges: nd,
        };
      });

      return run();
    },

    /**
     * Purge a user account. Not scoped — removes everything owned by
     * the user across all cohorts (their content rows, their membership
     * rows, their auth sessions, notes + feedback they authored).
     *
     * Callers must verify: instructors cannot self-delete if they own
     * any cohort. This function does NOT check that — it's the route's job.
     */
    purgeAccount(userId: string): {
      hypotheses: number;
      hint_sessions: number;
      post_mortems: number;
      mistake_patterns: number;
      telemetry: number;
      tutor_notes: number;
      tutor_feedback: number;
      cohort_members: number;
      auth_sessions: number;
      user: number;
    } {
      const run = sqlite.transaction(() => {
        const h = sqlite.prepare('DELETE FROM hypotheses WHERE student_id = ?').run(userId).changes ?? 0;
        const hs = sqlite.prepare('DELETE FROM hint_sessions WHERE student_id = ?').run(userId).changes ?? 0;
        const pm = sqlite.prepare('DELETE FROM post_mortems WHERE student_id = ?').run(userId).changes ?? 0;
        const mp = sqlite.prepare('DELETE FROM mistake_patterns WHERE student_id = ?').run(userId).changes ?? 0;
        const tel = sqlite.prepare('DELETE FROM telemetry WHERE student_id = ?').run(userId).changes ?? 0;
        // Notes / feedback they authored
        const tn = sqlite.prepare('DELETE FROM tutor_notes WHERE instructor_id = ? OR student_id = ?').run(userId, userId).changes ?? 0;
        const tf = sqlite.prepare('DELETE FROM tutor_feedback WHERE instructor_id = ? OR student_id = ?').run(userId, userId).changes ?? 0;
        // Membership + sessions + user row
        const cm = sqlite.prepare('DELETE FROM cohort_members WHERE user_id = ?').run(userId).changes ?? 0;
        const as = sqlite.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId).changes ?? 0;
        const u = sqlite.prepare('DELETE FROM users WHERE id = ?').run(userId).changes ?? 0;
        return {
          hypotheses: h, hint_sessions: hs, post_mortems: pm,
          mistake_patterns: mp, telemetry: tel,
          tutor_notes: tn, tutor_feedback: tf,
          cohort_members: cm, auth_sessions: as, user: u,
        };
      });
      return run();
    },

    /**
     * Record an audit entry. Called by routes after a successful purge.
     */
    recordAudit(data: {
      actorId: string;
      actorEmail: string | null;
      scope: 'student' | 'cohort' | 'account';
      targetId: string;
      targetLabel: string | null;
      counts: Record<string, number>;
    }): DeletionAudit {
      const id = randomUUID();
      stmt.insertDeletionAudit.run(
        id,
        data.actorId,
        data.actorEmail,
        data.scope,
        data.targetId,
        data.targetLabel,
        JSON.stringify(data.counts)
      );
      const row = sqlite.prepare('SELECT * FROM deletion_audit WHERE id = ?').get(id) as any;
      return {
        id: row.id,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        scope: row.scope,
        targetId: row.target_id,
        targetLabel: row.target_label,
        countsJson: row.counts_json,
        createdAt: parseSqliteTimestamp(row.created_at),
      };
    },

    /**
     * List recent audit entries for a given actor (used by a future
     * admin page). Not currently wired to the UI.
     */
    listAuditForActor(actorId: string, limit = 50): DeletionAudit[] {
      const rows = sqlite
        .prepare('SELECT * FROM deletion_audit WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(actorId, limit) as any[];
      return rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        actorEmail: row.actor_email,
        scope: row.scope,
        targetId: row.target_id,
        targetLabel: row.target_label,
        countsJson: row.counts_json,
        createdAt: parseSqliteTimestamp(row.created_at),
      }));
    },
  },

  inviteAudit: {
    record(data: {
      actorId: string;
      actorEmail: string | null;
      code: string;
      role: 'instructor' | 'student';
      expiresAt: string | null;
    }): void {
      const id = randomUUID();
      sqlite
        .prepare(
          `INSERT INTO invite_audit
             (id, actor_id, actor_email, code, role, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, data.actorId, data.actorEmail, data.code, data.role, data.expiresAt);
    },

    listForActor(actorId: string, limit = 100): Array<{
      id: string;
      actorId: string;
      actorEmail: string | null;
      code: string;
      role: string;
      expiresAt: string | null;
      createdAt: string;
    }> {
      return sqlite
        .prepare(
          `SELECT id, actor_id AS actorId, actor_email AS actorEmail,
                  code, role, expires_at AS expiresAt, created_at AS createdAt
           FROM invite_audit
           WHERE actor_id = ?
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(actorId, limit) as any[];
    },
  },

  tutorFeedback: {
    create(data: {
      instructorId: string;
      studentId: string;
      targetType: 'hypothesis' | 'post_mortem';
      targetId: string;
      text: string;
    }): TutorFeedback {
      const id = randomUUID();
      stmt.insertTutorFeedback.run(
        id,
        data.instructorId,
        data.studentId,
        data.targetType,
        data.targetId,
        data.text
      );
      const row = stmt.findTutorFeedbackById.get(id) as any;
      return rowToTutorFeedback(row);
    },

    delete(id: string, instructorId: string): boolean {
      const result = stmt.deleteTutorFeedback.run(id, instructorId);
      return result.changes > 0;
    },

    /**
     * List all feedback attached to any hypothesis or post-mortem
     * for a given (student, exercise) pair.
     */
    listForExercise(studentId: string, exerciseId: string): TutorFeedback[] {
      const rows = stmt.tutorFeedbackByExercise.all(
        studentId,
        studentId,
        exerciseId,
        studentId,
        exerciseId
      ) as any[];
      return rows.map(rowToTutorFeedback);
    },
  },

  inviteCodes: {
    async create(data: {
      code: string;
      role: 'instructor' | 'student';
      createdBy: string | null;
      expiresAt: Date | null;
    }): Promise<{
      id: string;
      code: string;
      role: string;
      createdBy: string | null;
      createdAt: Date;
      usedBy: string | null;
      usedAt: Date | null;
      expiresAt: Date | null;
    }> {
      const id = crypto.randomUUID();
      const expiresIso = data.expiresAt ? data.expiresAt.toISOString() : null;
      stmt.insertInviteCode.run(id, data.code, data.role, data.createdBy, expiresIso);
      const row = stmt.findInviteCode.get(data.code) as any;
      return rowToInviteCode(row);
    },
    async find(code: string) {
      const row = stmt.findInviteCode.get(code) as any;
      return row ? rowToInviteCode(row) : null;
    },
    async list() {
      return (stmt.listInviteCodes.all() as any[]).map(rowToInviteCode);
    },
    async markUsed(code: string, userId: string): Promise<boolean> {
      const info = stmt.markInviteCodeUsed.run(userId, code);
      return (info.changes ?? 0) > 0;
    },
    async delete(code: string): Promise<boolean> {
      const info = stmt.deleteInviteCode.run(code);
      return (info.changes ?? 0) > 0;
    },
  },

  hintDependency: {
    async forStudent(studentId: string): Promise<{
      sessions: number;
      totalHints: number;
      avgHintsPerSession: number;
    }> {
      const row = stmt.hintDependencyForStudent.get(studentId) as {
        sessions: number;
        total_hints: number;
      };
      const sessions = row?.sessions ?? 0;
      const totalHints = row?.total_hints ?? 0;
      return {
        sessions,
        totalHints,
        avgHintsPerSession: sessions > 0 ? totalHints / sessions : 0,
      };
    },

    async forStudentInWindow(
      studentId: string,
      since: Date
    ): Promise<{ sessions: number; totalHints: number; avgHintsPerSession: number }> {
      const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);
      const row = stmt.hintDependencyForStudentInWindow.get(
        studentId,
        sinceIso
      ) as { sessions: number; total_hints: number };
      const sessions = row?.sessions ?? 0;
      const totalHints = row?.total_hints ?? 0;
      return {
        sessions,
        totalHints,
        avgHintsPerSession: sessions > 0 ? totalHints / sessions : 0,
      };
    },

    async all(): Promise<{
      sessions: number;
      students: number;
      totalHints: number;
      avgHintsPerSession: number;
    }> {
      const row = stmt.hintDependencyAll.get() as {
        sessions: number;
        students: number;
        total_hints: number;
      };
      const sessions = row?.sessions ?? 0;
      const totalHints = row?.total_hints ?? 0;
      return {
        sessions,
        students: row?.students ?? 0,
        totalHints,
        avgHintsPerSession: sessions > 0 ? totalHints / sessions : 0,
      };
    },
  },

  hintSessions: {
    async findById(id: string): Promise<HintSession | null> {
      const row = sqlite
        .prepare('SELECT * FROM hint_sessions WHERE id = ?')
        .get(id) as any;
      return row ? rowToSession(row) : null;
    },

    async find(studentId: string, exerciseId: string): Promise<HintSession | null> {
      const row = stmt.findSession.get(studentId, exerciseId);
      return row ? rowToSession(row) : null;
    },
    async create(data: Omit<HintSession, 'id'>): Promise<HintSession> {
      const id = randomUUID();
      const state = data.state ?? 'open';
      const struggleMinutes = data.struggleMinutes ?? 0;
      const codeSubmissions = data.codeSubmissions ?? 0;
      stmt.insertSession.run(
        id, data.studentId, data.exerciseId,
        data.currentLevel, data.attemptsAtLevel, data.totalAttempts,
        data.resolved ? 1 : 0,
        data.hypothesisPending ? 1 : 0,
        state,
        struggleMinutes,
        codeSubmissions
      );
      return {
        id, ...data, state, struggleMinutes, codeSubmissions,
        createdAt: data.createdAt ?? new Date(),
      };
    },
    async update(id: string, patch: Partial<HintSession>): Promise<void> {
      const current = stmt.findSessionById.get(id) as any;
      if (!current) return;
      const merged = { ...rowToSession(current), ...patch };
      stmt.updateSession.run(
        merged.currentLevel, merged.attemptsAtLevel, merged.totalAttempts,
        merged.resolved ? 1 : 0,
        merged.hypothesisPending ? 1 : 0,
        merged.state,
        merged.struggleMinutes,
        merged.codeSubmissions,
        id
      );
    },
    async update2(studentId: string, exerciseId: string, patch: Partial<HintSession>): Promise<void> {
      const current = await db.hintSessions.find(studentId, exerciseId);
      if (!current) return;
      await db.hintSessions.update(current.id, patch);
    },
    async getOrCreate(
      studentId: string,
      exerciseId: string,
      options?: { struggleMinutes?: number }
    ): Promise<HintSession> {
      const existing = await db.hintSessions.find(studentId, exerciseId);
      if (existing) return existing;
      return db.hintSessions.create({
        studentId, exerciseId, currentLevel: 1,
        attemptsAtLevel: 0, totalAttempts: 0, resolved: false,
        hypothesisPending: true, state: 'open',
        struggleMinutes: options?.struggleMinutes ?? 0,
        codeSubmissions: 0,
        createdAt: new Date(),
      });
    },
  },

  mistakePatterns: {
    async record(rec: MistakePatternRecord): Promise<void> {
      stmt.insertPattern.run(
        rec.studentId, rec.exerciseId, rec.pattern,
        rec.confidence ?? null, rec.source
      );
    },
    async findRecent(studentId: string, limit: number) {
      return (stmt.patternsByStudent.all(studentId, limit) as any[]).map(rowToPattern);
    },
    async findAllForStudent(studentId: string) {
      return (stmt.allPatternsByStudent.all(studentId) as any[]).map(rowToPattern);
    },
    async findSince(since: Date) {
      return (stmt.patternsSince.all(since.toISOString()) as any[]).map(rowToPattern);
    },
  },

  hypotheses: {
    async record(rec: {
      studentId: string;
      exerciseId: string;
      hintLevel: number;
      text: string;
      quality?: string | null;
      scoreSource?: string | null;
    }): Promise<void> {
      stmt.insertHypothesis.run(
        rec.studentId,
        rec.exerciseId,
        rec.hintLevel,
        rec.text,
        rec.quality ?? null,
        rec.scoreSource ?? null
      );
    },
    async findRecent(studentId: string, exerciseId: string, limit = 10) {
      return (stmt.hypothesesByExercise.all(
        studentId, exerciseId, limit
      ) as any[]).map((row) => ({
        hintLevel: row.hint_level,
        text: row.text,
        timestamp: parseSqliteTimestamp(row.recorded_at),
      }));
    },

    async qualityStatsForStudent(studentId: string): Promise<{
      total: number;
      vague: number;
      plausible: number;
      precise: number;
      unscored: number;
    }> {
      const rows = stmt.hypothesisQualityByStudent.all(studentId) as Array<{
        quality: string;
        n: number;
      }>;
      const out = { total: 0, vague: 0, plausible: 0, precise: 0, unscored: 0 };
      for (const row of rows) {
        if (row.quality === 'vague') out.vague = row.n;
        else if (row.quality === 'plausible') out.plausible = row.n;
        else if (row.quality === 'precise') out.precise = row.n;
        else out.unscored += row.n;
        out.total += row.n;
      }
      return out;
    },

    async qualityStatsAll(): Promise<{
      total: number;
      vague: number;
      plausible: number;
      precise: number;
      unscored: number;
    }> {
      const rows = stmt.hypothesisQualityAll.all() as Array<{
        quality: string;
        n: number;
      }>;
      const out = { total: 0, vague: 0, plausible: 0, precise: 0, unscored: 0 };
      for (const row of rows) {
        if (row.quality === 'vague') out.vague = row.n;
        else if (row.quality === 'plausible') out.plausible = row.n;
        else if (row.quality === 'precise') out.precise = row.n;
        else out.unscored += row.n;
        out.total += row.n;
      }
      return out;
    },
    async qualityStatsForStudentInWindow(
      studentId: string,
      since: Date
    ): Promise<{ total: number; vague: number; plausible: number; precise: number }> {
      const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);
      const rows = stmt.hypothesisQualityByStudentRecent.all(
        studentId,
        sinceIso
      ) as Array<{ quality: string; n: number }>;
      const out = { total: 0, vague: 0, plausible: 0, precise: 0 };
      for (const row of rows) {
        if (row.quality === 'vague') out.vague = row.n;
        else if (row.quality === 'plausible') out.plausible = row.n;
        else if (row.quality === 'precise') out.precise = row.n;
        out.total += row.n;
      }
      return out;
    },

    async qualityStatsAllInWindow(
      since: Date
    ): Promise<{ total: number; vague: number; plausible: number; precise: number }> {
      const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);
      const rows = stmt.hypothesisQualityAllRecent.all(sinceIso) as Array<{
        quality: string;
        n: number;
      }>;
      const out = { total: 0, vague: 0, plausible: 0, precise: 0 };
      for (const row of rows) {
        if (row.quality === 'vague') out.vague = row.n;
        else if (row.quality === 'plausible') out.plausible = row.n;
        else if (row.quality === 'precise') out.precise = row.n;
        out.total += row.n;
      }
      return out;
    },

  },

  postMortems: {
    async record(rec: {
      sessionId: string;
      studentId: string;
      exerciseId: string;
      pattern: string | null;
      text: string;
      score: string;
      feedback: string;
    }): Promise<void> {
      stmt.insertPostMortem.run(
        rec.sessionId, rec.studentId, rec.exerciseId, rec.pattern,
        rec.text, rec.score, rec.feedback
      );
    },
    async findBySession(sessionId: string) {
      const row = stmt.postMortemBySession.get(sessionId) as any;
      if (!row) return null;
      return {
        text: row.text,
        score: row.score,
        feedback: row.feedback,
        timestamp: parseSqliteTimestamp(row.recorded_at),
      };
    },
    async findAllForStudent(studentId: string) {
      return (stmt.postMortemsByStudent.all(studentId) as any[]).map((row) => ({
        sessionId: row.session_id,
        exerciseId: row.exercise_id,
        pattern: row.pattern,
        text: row.text,
        score: row.score,
        feedback: row.feedback,
        timestamp: parseSqliteTimestamp(row.recorded_at),
      }));
    },
    async statsByStudent(studentId: string): Promise<Record<string, {
      correct: number;
      partial: number;
      incorrect: number;
      unscored: number;
      total: number;
    }>> {
      const rows = stmt.postMortemStatsByStudent.all(studentId) as Array<{
        pattern: string;
        score: string;
        n: number;
      }>;
      const out: Record<string, {
        correct: number;
        partial: number;
        incorrect: number;
        unscored: number;
        total: number;
      }> = {};
      for (const row of rows) {
        if (!row.pattern) continue;
        if (!out[row.pattern]) {
          out[row.pattern] = { correct: 0, partial: 0, incorrect: 0, unscored: 0, total: 0 };
        }
        const bucket = out[row.pattern];
        if (row.score === 'correct') bucket.correct += row.n;
        else if (row.score === 'partial') bucket.partial += row.n;
        else if (row.score === 'incorrect') bucket.incorrect += row.n;
        else bucket.unscored += row.n;
        bucket.total += row.n;
      }
      return out;
    },
  },

  telemetry: {
    async record(ev: TelemetryEvent): Promise<void> {
      stmt.insertTelemetry.run(
        ev.type, ev.studentId ?? null, ev.exerciseId ?? null,
        ev.reason ?? null, ev.latencyMs ?? null, ev.state ?? null,
        ev.failures ?? null, ev.openedAt ?? null
      );
    },
    async count({ type, since }: { type: string; since: Date }): Promise<number> {
      const row = stmt.countTelemetryByType.get(type, since.toISOString()) as any;
      return row?.n ?? 0;
    },
    async find({ type, since }: { type: string; since: Date }) {
      return (stmt.telemetryByType.all(type, since.toISOString()) as any[]).map(rowToTelemetry);
    },
    async findLatest({ type }: { type: string }) {
      const row = stmt.latestTelemetryByType.get(type) as any;
      return row ? rowToTelemetry(row) : null;
    },
  },
};
