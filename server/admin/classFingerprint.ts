import { sqlite } from '../db.js';

export interface PatternStat {
  pattern: string;
  occurrences: number;
  students: number;
  pctOfStudents: number;
  postMortems: {
    total: number;
    correct: number;
    partial: number;
    incorrect: number;
    unscored: number;
  };
}

export interface ExerciseStat {
  exerciseId: string;
  students: number;
  sessions: number;
  completed: number;
  completionRate: number;
  topPattern: string | null;
}

export interface StruggleRow {
  exerciseId: string;
  pattern: string;
  students: number;
  occurrences: number;
}

export interface ClassFingerprint {
  generatedAt: string;
  window: { hours: number; since: string };
  students: number;
  exercises: number;
  totalHints: number;
  patterns: PatternStat[];
  exercisesList: ExerciseStat[];
  struggles: StruggleRow[];
  anomalies: string[];
}

export async function getClassFingerprint(
  windowHours = 168
): Promise<ClassFingerprint> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const sinceIso = since.toISOString().replace('T', ' ').slice(0, 19);

  // ── Students count ──
  const studentsRow = sqlite
    .prepare(
      `SELECT COUNT(DISTINCT student_id) AS n FROM mistake_patterns WHERE recorded_at >= ?`
    )
    .get(sinceIso) as { n: number };
  const students = studentsRow?.n ?? 0;

  // ── Total hints in window ──
  const totalHintsRow = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM telemetry WHERE type = 'hint-served' AND recorded_at >= ?`
    )
    .get(sinceIso) as { n: number };
  const totalHints = totalHintsRow?.n ?? 0;

  // ── Pattern aggregate ──
  const patternRows = sqlite
    .prepare(
      `SELECT
         pattern,
         COUNT(*) AS occurrences,
         COUNT(DISTINCT student_id) AS students
       FROM mistake_patterns
       WHERE recorded_at >= ?
       GROUP BY pattern
       ORDER BY occurrences DESC`
    )
    .all(sinceIso) as Array<{ pattern: string; occurrences: number; students: number }>;

  // ── Post-mortem stats joined by pattern ──
  const pmRows = sqlite
    .prepare(
      `SELECT
         pattern,
         COALESCE(score, 'unscored') AS score,
         COUNT(*) AS n
       FROM post_mortems
       WHERE pattern IS NOT NULL AND recorded_at >= ?
       GROUP BY pattern, score`
    )
    .all(sinceIso) as Array<{ pattern: string; score: string; n: number }>;

  const pmByPattern: Record<string, PatternStat['postMortems']> = {};
  for (const row of pmRows) {
    if (!pmByPattern[row.pattern]) {
      pmByPattern[row.pattern] = { total: 0, correct: 0, partial: 0, incorrect: 0, unscored: 0 };
    }
    const bucket = pmByPattern[row.pattern];
    if (row.score === 'correct') bucket.correct += row.n;
    else if (row.score === 'partial') bucket.partial += row.n;
    else if (row.score === 'incorrect') bucket.incorrect += row.n;
    else bucket.unscored += row.n;
    bucket.total += row.n;
  }

  const patterns: PatternStat[] = patternRows.map((row) => ({
    pattern: row.pattern,
    occurrences: row.occurrences,
    students: row.students,
    pctOfStudents: students ? Math.round((row.students / students) * 100) : 0,
    postMortems: pmByPattern[row.pattern] ?? {
      total: 0, correct: 0, partial: 0, incorrect: 0, unscored: 0,
    },
  }));

  // ── Exercise aggregate ──
  const exerciseRows = sqlite
    .prepare(
      `SELECT
         exercise_id,
         COUNT(DISTINCT student_id) AS students,
         COUNT(*) AS sessions,
         SUM(CASE WHEN state = 'complete' THEN 1 ELSE 0 END) AS completed
       FROM hint_sessions
       WHERE created_at >= ?
       GROUP BY exercise_id
       ORDER BY students DESC`
    )
    .all(sinceIso) as Array<{
      exercise_id: string;
      students: number;
      sessions: number;
      completed: number;
    }>;

  // Top pattern per exercise
  const exerciseTopPatterns = sqlite
    .prepare(
      `SELECT exercise_id, pattern, COUNT(*) AS n
       FROM mistake_patterns
       WHERE recorded_at >= ?
       GROUP BY exercise_id, pattern`
    )
    .all(sinceIso) as Array<{ exercise_id: string; pattern: string; n: number }>;

  const topPatternByExercise: Record<string, { pattern: string; n: number }> = {};
  for (const row of exerciseTopPatterns) {
    const cur = topPatternByExercise[row.exercise_id];
    if (!cur || row.n > cur.n) {
      topPatternByExercise[row.exercise_id] = { pattern: row.pattern, n: row.n };
    }
  }

  const exercisesList: ExerciseStat[] = exerciseRows.map((row) => ({
    exerciseId: row.exercise_id,
    students: row.students,
    sessions: row.sessions,
    completed: row.completed,
    completionRate: row.sessions ? Math.round((row.completed / row.sessions) * 100) / 100 : 0,
    topPattern: topPatternByExercise[row.exercise_id]?.pattern ?? null,
  }));

  // ── Struggles: pattern × exercise where multiple students hit it ──
  const struggles = sqlite
    .prepare(
      `SELECT
         exercise_id AS exerciseId,
         pattern,
         COUNT(*) AS occurrences,
         COUNT(DISTINCT student_id) AS students
       FROM mistake_patterns
       WHERE recorded_at >= ?
       GROUP BY exercise_id, pattern
       HAVING students >= 2
       ORDER BY students DESC, occurrences DESC
       LIMIT 20`
    )
    .all(sinceIso) as StruggleRow[];

  const exercises = exercisesList.length;

  const fingerprint: ClassFingerprint = {
    generatedAt: new Date().toISOString(),
    window: { hours: windowHours, since: since.toISOString() },
    students,
    exercises,
    totalHints,
    patterns,
    exercisesList,
    struggles,
    anomalies: [],
  };

  fingerprint.anomalies = detectAnomalies(fingerprint);
  return fingerprint;
}

function detectAnomalies(f: ClassFingerprint): string[] {
  const out: string[] = [];

  // Pattern hitting most of the class
  for (const p of f.patterns.slice(0, 3)) {
    if (p.pctOfStudents >= 60 && p.occurrences >= 5) {
      out.push(
        `"${p.pattern}" appears in ${p.pctOfStudents}% of students (${p.students} of ${f.students})`
      );
    }
  }

  // Struggles where multiple students hit the same pattern in the same exercise
  for (const s of f.struggles.slice(0, 3)) {
    if (s.students >= 4) {
      out.push(
        `${s.students} students hit "${s.pattern}" on exercise "${s.exerciseId}"`
      );
    }
  }

  // Exercises with low completion
  for (const e of f.exercisesList) {
    if (e.sessions >= 3 && e.completionRate < 0.3) {
      out.push(
        `Exercise "${e.exerciseId}" has a ${Math.round(e.completionRate * 100)}% completion rate across ${e.sessions} sessions`
      );
    }
  }

  return out;
}
