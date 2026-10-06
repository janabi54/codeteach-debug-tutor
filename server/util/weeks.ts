/**
 * Week utilities for trend sparklines.
 *
 * Weeks are Monday-anchored (ISO 8601). The SQLite expression
 * `date(recorded_at, 'weekday 1', '-7 days')` yields the Monday that
 * starts the week containing `recorded_at`, in UTC.
 *
 * The frontend receives `weekStart` as 'YYYY-MM-DD'.
 */

export interface TrendPoint {
  weekStart: string;   // 'YYYY-MM-DD'
  value: number | null;
  sample: number;
}

/**
 * Returns the last N Mondays (as ISO date strings), oldest first.
 * The last entry is the Monday of the current week.
 */
export function lastNWeekStarts(n: number): string[] {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const offsetToMonday = (day + 6) % 7;

  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - offsetToMonday
  ));

  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() - i * 7);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Merge SQL rows (each with `week_start`, `value`, `sample`) into a
 * full 12-week array. Weeks with no row become null values.
 */
export function fillWeeks(
  rows: Array<{ week_start: string; value: number | null; sample: number }>,
  weekStarts: string[]
): TrendPoint[] {
  const byWeek = new Map(rows.map((r) => [r.week_start, r]));
  return weekStarts.map((weekStart) => {
    const row = byWeek.get(weekStart);
    if (!row) return { weekStart, value: null, sample: 0 };
    return {
      weekStart,
      value: row.value,
      sample: row.sample,
    };
  });
}

/**
 * Classify a 12-week series into a trend.
 *
 * Compares the average of the last 4 non-null weeks against the average
 * of the 4 weeks before that. If either side has fewer than 2 valid
 * weeks, returns 'stable' — not enough signal.
 *
 * The caller passes `lowerIsBetter` for metrics like hint dependency
 * where a decrease is an improvement.
 */
export function classifyTrend(
  points: TrendPoint[],
  opts: { lowerIsBetter?: boolean; threshold?: number } = {}
): 'improving' | 'worsening' | 'stable' {
  const threshold = opts.threshold ?? 0.1;

  const recent = points
    .slice(-4)
    .filter((p) => p.value !== null)
    .map((p) => p.value as number);

  const prior = points
    .slice(-8, -4)
    .filter((p) => p.value !== null)
    .map((p) => p.value as number);

  if (recent.length < 2 || prior.length < 2) return 'stable';

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  let delta = avg(recent) - avg(prior);
  if (opts.lowerIsBetter) delta = -delta;

  if (delta > threshold) return 'improving';
  if (delta < -threshold) return 'worsening';
  return 'stable';
}
