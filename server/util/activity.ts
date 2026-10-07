/**
 * Activity bucketing + streak computation for the heatmap.
 *
 * Events are counted from three sources, deduped by (student, day):
 *   - hypotheses.recorded_at
 *   - hint_sessions.updated_at
 *   - post_mortems.recorded_at
 *
 * Each source contributes 1 to a day's count. Days with no events are
 * omitted from `events[]` (the client fills gaps for rendering).
 */

export interface ActivityDay {
  date: string;   // 'YYYY-MM-DD'
  count: number;
}

export interface ActivitySummary {
  windowDays: number;
  events: ActivityDay[];
  totalEvents: number;
  currentStreak: number;
  longestStreak: number;
  mostActiveDay: ActivityDay | null;
}

/**
 * Compute streak fields from a set of active dates.
 *
 * `currentStreak` counts consecutive active days ending today or
 * yesterday (grace period — so a student who hasn't been active yet
 * today keeps their streak). Anything older breaks the streak.
 *
 * `longestStreak` is the maximum consecutive run in the window.
 */
export function computeStreaks(dates: string[]): {
  currentStreak: number;
  longestStreak: number;
} {
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  // Dedup + sort ascending
  const sorted = Array.from(new Set(dates)).sort();

  // Compute longest
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (isNextDay(sorted[i - 1], sorted[i])) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Compute current streak — walk backward from the most recent active
  // date, checking if it is today or yesterday (UTC).
  const today = todayUTC();
  const yesterday = addDays(today, -1);
  const lastActive = sorted[sorted.length - 1];
  if (lastActive !== today && lastActive !== yesterday) {
    return { currentStreak: 0, longestStreak: longest };
  }

  let current = 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (isNextDay(sorted[i - 1], sorted[i])) {
      current++;
    } else {
      break;
    }
  }

  return { currentStreak: current, longestStreak: longest };
}

/**
 * Build the final summary from a list of (date, count) events.
 */
export function buildActivitySummary(
  events: ActivityDay[],
  windowDays: number
): ActivitySummary {
  const totalEvents = events.reduce((sum, e) => sum + e.count, 0);
  const dates = events.map((e) => e.date);
  const { currentStreak, longestStreak } = computeStreaks(dates);

  let mostActiveDay: ActivityDay | null = null;
  for (const e of events) {
    if (!mostActiveDay || e.count > mostActiveDay.count) mostActiveDay = e;
  }

  return {
    windowDays,
    events,
    totalEvents,
    currentStreak,
    longestStreak,
    mostActiveDay,
  };
}

// ── helpers ──────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isNextDay(a: string, b: string): boolean {
  return addDays(a, 1) === b;
}
