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

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS invite_codes (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'instructor',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_by TEXT,
  used_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);
CREATE INDEX IF NOT EXISTS idx_invite_codes_unused
  ON invite_codes(used_by, expires_at);

CREATE TABLE IF NOT EXISTS cohorts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instructor_id TEXT NOT NULL,
  enrollment_code TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cohorts_instructor ON cohorts(instructor_id);
CREATE INDEX IF NOT EXISTS idx_cohorts_enrollment_code ON cohorts(enrollment_code);

CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'javascript',
  starter_code TEXT NOT NULL DEFAULT '',
  expected_concepts TEXT NOT NULL DEFAULT '[]',
  learning_objectives TEXT NOT NULL DEFAULT '[]',
  struggle_minutes INTEGER NOT NULL DEFAULT 0,
  cohort_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_exercises_cohort ON exercises(cohort_id);
CREATE INDEX IF NOT EXISTS idx_exercises_slug ON exercises(slug);

CREATE TABLE IF NOT EXISTS cohort_members (
  cohort_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cohort_id, user_id),
  FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_cohort_members_user ON cohort_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cohort_members_cohort ON cohort_members(cohort_id);

CREATE TABLE IF NOT EXISTS tutor_notes (
  id TEXT PRIMARY KEY,
  instructor_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  cohort_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tutor_notes_student
  ON tutor_notes(instructor_id, student_id, cohort_id);

CREATE TABLE IF NOT EXISTS tutor_feedback (
  id TEXT PRIMARY KEY,
  instructor_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  target_type TEXT NOT NULL,      -- 'hypothesis' | 'post_mortem'
  target_id TEXT NOT NULL,        -- stringified id of the target row
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tutor_feedback_target
  ON tutor_feedback(target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_tutor_feedback_student
  ON tutor_feedback(student_id, created_at);

CREATE TABLE IF NOT EXISTS deletion_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,          -- who triggered the deletion
  actor_email TEXT,                -- denormalized for history (survives actor delete)
  scope TEXT NOT NULL,             -- 'student' | 'cohort' | 'account'
  target_id TEXT NOT NULL,         -- student id / cohort id / actor id
  target_label TEXT,               -- human-readable (student name / cohort name)
  counts_json TEXT NOT NULL,       -- { hypotheses: 9, sessions: 1, ... }
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deletion_audit_time
  ON deletion_audit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deletion_audit_actor
  ON deletion_audit(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invite_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  actor_email TEXT,
  code TEXT NOT NULL,
  role TEXT NOT NULL,                 -- 'instructor' | 'student'
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_invite_audit_time
  ON invite_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_audit_actor
  ON invite_audit(actor_id, created_at DESC);

-- ── Nudges (tutor ↔ student messaging) ──

CREATE TABLE IF NOT EXISTS nudge_threads (
  id TEXT PRIMARY KEY,
  instructor_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  subject TEXT,
  last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(instructor_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_nudge_threads_student
  ON nudge_threads(student_id, last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_nudge_threads_instructor
  ON nudge_threads(instructor_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS nudge_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_role TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  email_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES nudge_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_nudge_messages_thread
  ON nudge_messages(thread_id, created_at);
