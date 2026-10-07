/**
 * Aggregate time metrics for the "Time on task" card.
 *
 * Inputs: per-session rows with `struggleMinutes` and `durationMinutes`.
 * `struggleMinutes` is a first-class signal set by the tutor app (via
 * telemetry). `durationMinutes` is derived from created→updated delta
 * and is only meaningful when a session finished within a reasonable
 * window (sub-day).
 *
 * "Sessions with time" = sessions where struggleMinutes > 0.
 */

export interface SessionTimeInput {
  exerciseId: string;
  exerciseTitle: string;
  struggleMinutes: number;
  durationMinutes: number | null;
}

export interface TimeMetrics {
  totalStruggleMinutes: number;
  avgStruggleMinutes: number;    // across sessionsWithTime
  longestStruggle: { exerciseId: string; exerciseTitle: string; minutes: number } | null;
  sessionsWithTime: number;
  totalSessions: number;
}

export function deriveTimeMetrics(sessions: SessionTimeInput[]): TimeMetrics {
  const totalSessions = sessions.length;
  const withTime = sessions.filter((s) => s.struggleMinutes > 0);
  const sessionsWithTime = withTime.length;

  const totalStruggleMinutes = withTime.reduce((sum, s) => sum + s.struggleMinutes, 0);
  const avgStruggleMinutes = sessionsWithTime > 0
    ? Math.round(totalStruggleMinutes / sessionsWithTime)
    : 0;

  let longestStruggle: TimeMetrics['longestStruggle'] = null;
  for (const s of withTime) {
    if (!longestStruggle || s.struggleMinutes > longestStruggle.minutes) {
      longestStruggle = {
        exerciseId: s.exerciseId,
        exerciseTitle: s.exerciseTitle,
        minutes: s.struggleMinutes,
      };
    }
  }

  return {
    totalStruggleMinutes,
    avgStruggleMinutes,
    longestStruggle,
    sessionsWithTime,
    totalSessions,
  };
}
