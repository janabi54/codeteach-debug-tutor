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
    'INSERT INTO hypotheses (student_id, exercise_id, hint_level, text) VALUES (?, ?, ?, ?)'
  ),
  hypothesesByExercise: sqlite.prepare(
    'SELECT * FROM hypotheses WHERE student_id = ? AND exercise_id = ? ORDER BY recorded_at DESC LIMIT ?'
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
};

export const db = {
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
    }): Promise<void> {
      stmt.insertHypothesis.run(
        rec.studentId, rec.exerciseId, rec.hintLevel, rec.text
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
