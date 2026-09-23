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

export async function getWeakSpots(studentId: string) {
  const patterns = await db.mistakePatterns.findAllForStudent(studentId);
  const counts = patterns.reduce<Record<string, number>>((acc, p) => {
    acc[p.pattern] = (acc[p.pattern] || 0) + 1;
    return acc;
  }, {});
  const total = patterns.length;

  const postMortemStats = await db.postMortems.statsByStudent(studentId);

  return Object.entries(counts)
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
