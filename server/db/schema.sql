CREATE TABLE IF NOT EXISTS hint_sessions (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  current_level INTEGER NOT NULL DEFAULT 1,
  attempts_at_level INTEGER NOT NULL DEFAULT 0,
  total_attempts INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, exercise_id)
);

CREATE INDEX IF NOT EXISTS idx_hint_sessions_student
  ON hint_sessions(student_id);

CREATE TABLE IF NOT EXISTS mistake_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  pattern TEXT NOT NULL,
  confidence TEXT,
  source TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mistake_patterns_student_time
  ON mistake_patterns(student_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_mistake_patterns_time
  ON mistake_patterns(recorded_at);

CREATE TABLE IF NOT EXISTS telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  student_id TEXT,
  exercise_id TEXT,
  reason TEXT,
  latency_ms INTEGER,
  state TEXT,
  failures INTEGER,
  opened_at TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telemetry_type_time
  ON telemetry(type, recorded_at);

CREATE TABLE IF NOT EXISTS hypotheses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  hint_level INTEGER NOT NULL,
  text TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_student_exercise
  ON hypotheses(student_id, exercise_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS post_mortems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  exercise_id TEXT NOT NULL,
  pattern TEXT,
  text TEXT NOT NULL,
  score TEXT,
  feedback TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_post_mortems_student
  ON post_mortems(student_id, recorded_at DESC);
