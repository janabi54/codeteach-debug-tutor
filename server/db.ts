import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
    createdAt: parseSqliteTimestamp(row.created_at),
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

  // ── Auth: users ──
  insertUser: sqlite.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, role) VALUES (?, ?, ?, ?, ?)'
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
    }): Promise<User> {
      const id = randomUUID();
      const email = data.email.toLowerCase().trim();
      stmt.insertUser.run(id, email, data.passwordHash, data.displayName, data.role);
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
