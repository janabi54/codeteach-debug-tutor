/**
 * Status derivation for students.
 *
 * Two tiers:
 *   - deriveRosterStatus: cheap signals only, used on the roster list.
 *   - escalateWithTrends: adds trend-based signals, used on the detail page.
 *
 * Status vocabulary:
 *   'new'       — no exercises attempted yet
 *   'on-track'  — active, progressing
 *   'slipping'  — one soft signal (stalling or drifting)
 *   'at-risk'   — a hard signal (long absence) or multiple soft signals
 *
 * Reasons are short human-readable strings; the client renders them as
 * a tooltip on the status badge.
 */

export type StudentStatus = 'new' | 'on-track' | 'slipping' | 'at-risk';

export interface StatusResult {
  status: StudentStatus;
  reasons: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days between an ISO timestamp and now. Returns Infinity for null. */
function daysSince(iso: string | null): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return Infinity;
  return (Date.now() - t) / DAY_MS;
}

function plural(n: number, word: string): string {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/**
 * Cheap roster status. Uses only exercisesAttempted, exercisesCompleted,
 * and lastActiveAt (all already on the roster row).
 */
export function deriveRosterStatus(input: {
  exercisesAttempted: number;
  exercisesCompleted: number;
  lastActiveAt: string | null;
}): StatusResult {
  const { exercisesAttempted, exercisesCompleted, lastActiveAt } = input;

  if (exercisesAttempted === 0) {
    return { status: 'new', reasons: [] };
  }

  const days = daysSince(lastActiveAt);
  const reasons: string[] = [];

  // Hard signal: long absence
  if (days > 14) {
    reasons.push('No activity for ' + plural(Math.floor(days), 'day'));
    return { status: 'at-risk', reasons };
  }

  // Soft signal: stalling (started but rarely completed)
  const completionRatio =
    exercisesAttempted > 0 ? exercisesCompleted / exercisesAttempted : 1;
  const isStalling = exercisesAttempted >= 3 && completionRatio < 0.4;
  if (isStalling) {
    reasons.push(
      'Completed only ' +
        exercisesCompleted +
        ' of ' +
        exercisesAttempted +
        ' started'
    );
  }

  // Soft signal: drifting (quiet 7–14 days)
  if (days > 7) {
    reasons.push('Quiet for ' + plural(Math.floor(days), 'day'));
  }

  if (reasons.length >= 2) {
    return { status: 'at-risk', reasons };
  }
  if (reasons.length === 1) {
    return { status: 'slipping', reasons };
  }
  return { status: 'on-track', reasons: [] };
}

/**
 * Escalate a roster status using trend classifications from the detail page.
 *
 * - If already at-risk: keep at-risk, append any new reasons.
 * - If slipping and a trend signal fires: escalate to at-risk.
 * - If on-track / new and 1 trend signal fires: slipping.
 * - If on-track / new and 2+ trend signals fire: at-risk.
 */
export function escalateWithTrends(
  base: StatusResult,
  trends: {
    reasoningQuality: { classification: 'improving' | 'worsening' | 'stable' };
    hintDependency: { classification: 'improving' | 'worsening' | 'stable' };
  }
): StatusResult {
  const trendReasons: string[] = [];
  if (trends.reasoningQuality.classification === 'worsening') {
    trendReasons.push('Reasoning quality declining');
  }
  if (trends.hintDependency.classification === 'worsening') {
    trendReasons.push('Increasing reliance on hints');
  }

  if (trendReasons.length === 0) return base;

  const reasons = base.reasons.concat(trendReasons);

  if (base.status === 'at-risk') {
    return { status: 'at-risk', reasons };
  }
  if (base.status === 'slipping' || trendReasons.length >= 2) {
    return { status: 'at-risk', reasons };
  }
  return { status: 'slipping', reasons };
}
