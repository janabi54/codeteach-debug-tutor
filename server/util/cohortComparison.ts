/**
 * Cohort comparison: compare one student's metrics against the
 * median of their same-cohort peers.
 *
 * Fairness rule: peers are students who share a cohort with the
 * target student AND are visible to the same instructor. We do NOT
 * compare across cohorts — different skills / pacing.
 */

export interface CohortComparisonMetric {
  student: number | null;
  median: number | null;
  higherIsBetter: boolean;
  /** Short caption e.g. "% precise", "hints / session", "% complete". */
  unit: string;
}

export interface CohortComparison {
  cohortNames: string[];
  peerCount: number;
  metrics: {
    reasoningQuality: CohortComparisonMetric;
    hintDependency: CohortComparisonMetric;
    progress: CohortComparisonMetric;
  };
}

/**
 * Compute the median of an array of numbers. Returns null for an
 * empty array. For even-length arrays, averages the two middle values.
 */
export function median(values: number[]): number | null {
  const arr = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (arr.length === 0) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}
