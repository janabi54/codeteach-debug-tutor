/**
 * Rule engine for "Recommended next action" on the student detail page.
 *
 * Given a student's current status, session history, weak spots, and
 * the set of viewable exercises, produce ONE actionable recommendation.
 *
 * Priority order (first rule that fires wins):
 *   1. reach-out   — student is at-risk
 *   2. nudge       — student is slipping
 *   3. re-engage   — an exercise was started but not completed
 *   4. assign      — an unattempted exercise remains
 *   5. celebrate   — everything is complete
 *   6. none        — fallback (should be rare)
 *
 * Concept matching: if an unattempted exercise's `expected_concepts`
 * overlaps with the student's weak-spot patterns, prefer that exercise.
 */

export type NextActionKind =
  | 'reach-out'
  | 'nudge'
  | 're-engage'
  | 'assign'
  | 'celebrate'
  | 'none';

export interface NextAction {
  kind: NextActionKind;
  title: string;
  detail: string;
  exerciseId?: string;
  exerciseTitle?: string;
  /** True when the banner should be clickable (opens the exercise detail). */
  clickable: boolean;
}

export interface ViewableExercise {
  slug: string;
  title: string;
  expectedConcepts: string[];
}

export interface NextActionInput {
  status: 'new' | 'on-track' | 'slipping' | 'at-risk';
  statusReasons: string[];
  studentName: string;
  viewableExercises: ViewableExercise[];
  sessionHistory: Array<{
    exerciseId: string;
    exerciseTitle: string;
    state: string;
    updatedAt: string;
  }>;
  weakSpots: Array<{ pattern: string; count: number }>;
}

function firstReason(reasons: string[]): string {
  return reasons.length > 0 ? reasons[0] : '';
}

export function deriveNextAction(input: NextActionInput): NextAction {
  const {
    status,
    statusReasons,
    studentName,
    viewableExercises,
    sessionHistory,
    weakSpots,
  } = input;

  // ── Rule 1: reach-out ──────────────────────────────────────────
  if (status === 'at-risk') {
    const reason = firstReason(statusReasons);
    return {
      kind: 'reach-out',
      title: 'Reach out to ' + studentName,
      detail: reason ? reason + '. A short check-in goes a long way.' : 'A short check-in goes a long way.',
      clickable: false,
    };
  }

  // ── Rule 2: nudge ──────────────────────────────────────────────
  if (status === 'slipping') {
    const reason = firstReason(statusReasons);
    return {
      kind: 'nudge',
      title: 'Check in with ' + studentName,
      detail: reason || 'They may benefit from a quick nudge.',
      clickable: false,
    };
  }

  // ── Rule 3: re-engage ──────────────────────────────────────────
  const incomplete = sessionHistory.filter((s) => s.state !== 'complete');
  if (incomplete.length > 0) {
    // Most-recent incomplete session
    const target = incomplete
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    const days = Math.max(
      1,
      Math.round(
        (Date.now() - new Date(target.updatedAt.replace(' ', 'T') + 'Z').getTime()) /
          (1000 * 60 * 60 * 24)
      )
    );
    return {
      kind: 're-engage',
      title: 'Re-engage on ' + (target.exerciseTitle || target.exerciseId),
      detail: 'Started ' + days + ' day' + (days === 1 ? '' : 's') + ' ago, not yet complete.',
      exerciseId: target.exerciseId,
      exerciseTitle: target.exerciseTitle,
      clickable: true,
    };
  }

  // ── Rule 4: assign ─────────────────────────────────────────────
  const attemptedSlugs = new Set(sessionHistory.map((s) => s.exerciseId));
  const unattempted = viewableExercises.filter((e) => !attemptedSlugs.has(e.slug));
  if (unattempted.length > 0) {
    // Prefer an exercise that matches a weak-spot pattern in expected_concepts
    const weakSet = new Set(weakSpots.map((w) => w.pattern));
    let chosen = unattempted[0];
    for (const ex of unattempted) {
      if (ex.expectedConcepts.some((c) => weakSet.has(c))) {
        chosen = ex;
        break;
      }
    }

    const concepts = chosen.expectedConcepts;
    let detail: string;
    if (concepts.length > 0 && concepts.some((c) => weakSet.has(c))) {
      const matching = concepts.filter((c) => weakSet.has(c));
      detail = 'Targets ' + matching.join(', ') + ' — addresses a recent pattern.';
    } else if (concepts.length > 0) {
      detail = 'Covers ' + concepts.slice(0, 3).join(', ') + '.';
    } else {
      detail = 'Not yet attempted.';
    }

    return {
      kind: 'assign',
      title: 'Assign ' + (chosen.title || chosen.slug) + ' next',
      detail,
      exerciseId: chosen.slug,
      exerciseTitle: chosen.title,
      clickable: false,
    };
  }

  // ── Rule 5: celebrate ──────────────────────────────────────────
  if (viewableExercises.length > 0 && sessionHistory.length >= viewableExercises.length) {
    return {
      kind: 'celebrate',
      title: 'All assigned work complete',
      detail: 'Consider a stretch exercise or a peer review.',
      clickable: false,
    };
  }

  // ── Fallback ───────────────────────────────────────────────────
  return {
    kind: 'none',
    title: 'On track',
    detail: 'No action needed this week.',
    clickable: false,
  };
}
