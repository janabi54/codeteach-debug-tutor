/**
 * Derive a list of strengths from a student's aggregate signals.
 *
 * Each strength is a small object with a stable key (for CSS),
 * a short label, and a one-line supporting detail string.
 *
 * Rules are intentionally conservative — a strength should only
 * show up when there is enough evidence. Tune thresholds as the
 * product matures.
 */

export interface Strength {
  key: string;
  label: string;
  detail: string;
}

export interface StrengthsInput {
  reasoning: {
    total: number;
    precise: number;
    plausible: number;
    vague: number;
    unscored: number;
  };
  reasoningTrend: { classification: 'improving' | 'worsening' | 'stable' };
  hintDependency: {
    sessions: number;
    totalHints: number;
    avgHintsPerSession: number;
  };
  sessionsAttempted: number;
  sessionsCompleted: number;
  postMortemStrongCount: number;
  postMortemTotal: number;
}

export function deriveStrengths(input: StrengthsInput): Strength[] {
  const out: Strength[] = [];

  const {
    reasoning,
    reasoningTrend,
    hintDependency,
    sessionsAttempted,
    sessionsCompleted,
    postMortemStrongCount,
    postMortemTotal,
  } = input;

  // 1. Strong reasoning: at least half of scored hypotheses are precise,
  //    and there are enough to be meaningful.
  const scored = reasoning.precise + reasoning.plausible + reasoning.vague;
  if (scored >= 4 && reasoning.precise / scored >= 0.5) {
    const pct = Math.round((reasoning.precise / scored) * 100);
    out.push({
      key: 'reasoning-precise',
      label: 'Strong reasoning',
      detail: pct + '% of hypotheses precise (' + reasoning.precise + ' of ' + scored + ')',
    });
  }

  // 2. Improving reasoning week-over-week
  if (reasoningTrend.classification === 'improving') {
    out.push({
      key: 'reasoning-improving',
      label: 'Reasoning improving',
      detail: 'Quality trending up over the last several weeks',
    });
  }

  // 3. Strong self-reflection: multiple post-mortems scored strong
  if (postMortemStrongCount >= 2) {
    out.push({
      key: 'reflection',
      label: 'Reflects deeply',
      detail: postMortemStrongCount + ' of ' + postMortemTotal + ' post-mortems scored strong',
    });
  }

  // 4. Finishes what they start
  if (sessionsAttempted >= 2 && sessionsCompleted / sessionsAttempted >= 0.8) {
    out.push({
      key: 'completion',
      label: 'Finishes what they start',
      detail: sessionsCompleted + ' of ' + sessionsAttempted + ' sessions completed',
    });
  }

  // 5. Independent: low hint usage, enough sessions to be meaningful
  if (hintDependency.sessions >= 2 && hintDependency.avgHintsPerSession <= 0.5) {
    out.push({
      key: 'independent',
      label: 'Solves independently',
      detail: hintDependency.avgHintsPerSession.toFixed(1) + ' hints per session',
    });
  }

  return out;
}
