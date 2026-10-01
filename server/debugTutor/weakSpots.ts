import { db } from '../db.js';

const LABELS: Record<string, { label: string; tip: string }> = {
  'off-by-one': { label: 'Off-by-one errors', tip: 'Double-check loop bounds and array indices.' },
  'type-mismatch': { label: 'Type mismatches', tip: 'Trace the type of each value through your expression.' },
  'scope-issue': { label: 'Variable scope', tip: 'Sketch which variables exist where.' },
  'infinite-loop': { label: 'Loop termination', tip: 'Does each iteration move closer to the exit condition?' },
  'null-undefined': { label: 'Null / undefined handling', tip: 'Could this value be empty here?' },
  'mutation-side-effect': { label: 'Unintended mutation', tip: 'Watch for functions that modify their arguments.' },
  'logic-inversion': { label: 'Inverted logic', tip: 'Say your condition out loud.' },
  'async-await': { label: 'Async / await pitfalls', tip: 'Is every promise awaited?' },
  'syntax-error': {
    label: 'Syntax errors',
    tip: 'Small typos — missing brackets, stray characters, unmatched quotes — are the most common cause. Read the error line carefully.',
  },
};

export interface WeakSpotPattern {
  pattern: string;
  label: string;
  tip: string;
  count: number;
  percentage: number;
  recentTrend: 'improving' | 'worsening' | 'stable';
  postMortems: {
    total: number;
    correct: number;
    partial: number;
    incorrect: number;
    unscored: number;
  } | null;
}

export interface ReasoningStats {
  total: number;
  vague: number;
  plausible: number;
  precise: number;
  unscored: number;
  recentTrend: 'improving' | 'worsening' | 'stable';
}

export interface WeakSpotsResponse {
  patterns: WeakSpotPattern[];
  reasoning: ReasoningStats;
}

export async function getWeakSpots(studentId: string): Promise<WeakSpotsResponse> {
  const patterns = await db.mistakePatterns.findAllForStudent(studentId);
  const counts = patterns.reduce<Record<string, number>>((acc, p) => {
    acc[p.pattern] = (acc[p.pattern] || 0) + 1;
    return acc;
  }, {});
  const total = patterns.length;

  const postMortemStats = await db.postMortems.statsByStudent(studentId);

  const patternList: WeakSpotPattern[] = Object.entries(counts)
    .map(([pattern, count]) => {
      const pm = postMortemStats[pattern];
      return {
        pattern,
        label: LABELS[pattern]?.label ?? pattern,
        tip: LABELS[pattern]?.tip ?? '',
        count,
        percentage: total ? Math.round((count / total) * 100) : 0,
        recentTrend: computeTrend(patterns, pattern),
        postMortems: pm
          ? {
              total: pm.total,
              correct: pm.correct,
              partial: pm.partial,
              incorrect: pm.incorrect,
              unscored: pm.unscored,
            }
          : null,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Reasoning stats — total, plus trend over recent vs. prior window.
  const allTime = await db.hypotheses.qualityStatsForStudent(studentId);

  const now = Date.now();
  const recentSince = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const priorSince = new Date(now - 14 * 24 * 60 * 60 * 1000);

  const recentWindow = await db.hypotheses.qualityStatsForStudentInWindow(
    studentId,
    recentSince
  );
  const priorFullWindow = await db.hypotheses.qualityStatsForStudentInWindow(
    studentId,
    priorSince
  );
  // Prior = the 7-day window before recent. Compute by subtraction.
  const priorVague = Math.max(0, priorFullWindow.vague - recentWindow.vague);
  const priorPlausible = Math.max(0, priorFullWindow.plausible - recentWindow.plausible);
  const priorPrecise = Math.max(0, priorFullWindow.precise - recentWindow.precise);

  const reasoningTrend = computeReasoningTrend(
    { vague: recentWindow.vague, plausible: recentWindow.plausible, precise: recentWindow.precise },
    { vague: priorVague, plausible: priorPlausible, precise: priorPrecise }
  );

  const reasoning: ReasoningStats = {
    total: allTime.total,
    vague: allTime.vague,
    plausible: allTime.plausible,
    precise: allTime.precise,
    unscored: allTime.unscored,
    recentTrend: reasoningTrend,
  };

  return { patterns: patternList, reasoning };
}

function computeTrend(
  patterns: any[],
  pattern: string
): 'improving' | 'worsening' | 'stable' {
  const now = Date.now();
  const week = 7 * 24 * 60 * 60 * 1000;
  const recent = patterns.filter(
    (p) => p.pattern === pattern && now - p.timestamp < week
  ).length;
  const prior = patterns.filter(
    (p) =>
      p.pattern === pattern &&
      now - p.timestamp >= week &&
      now - p.timestamp < 2 * week
  ).length;
  if (recent < prior) return 'improving';
  if (recent > prior) return 'worsening';
  return 'stable';
}

/**
 * Trend for reasoning quality: compares a weighted "quality score" of the
 * recent window vs. the prior window. Precise hypotheses are worth more
 * than plausible ones; vague ones are worth nothing. If the average quality
 * of the recent window is meaningfully higher, it's "improving."
 */
function computeReasoningTrend(
  recent: { vague: number; plausible: number; precise: number },
  prior: { vague: number; plausible: number; precise: number }
): 'improving' | 'worsening' | 'stable' {
  const scoreOf = (w: typeof recent) => {
    const total = w.vague + w.plausible + w.precise;
    if (total === 0) return null;
    // vague = 0, plausible = 1, precise = 2 → range 0-2
    return (w.plausible * 1 + w.precise * 2) / total;
  };

  const recentScore = scoreOf(recent);
  const priorScore = scoreOf(prior);

  // Need enough data on both sides to call a trend
  const recentTotal = recent.vague + recent.plausible + recent.precise;
  const priorTotal = prior.vague + prior.plausible + prior.precise;
  if (recentTotal < 3 || priorTotal < 3) return 'stable';

  if (recentScore === null || priorScore === null) return 'stable';

  const delta = recentScore - priorScore;
  if (delta > 0.3) return 'improving';
  if (delta < -0.3) return 'worsening';
  return 'stable';
}
