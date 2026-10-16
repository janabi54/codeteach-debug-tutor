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
  /** Prerequisites. Empty array means no prerequisites. Optional for
   *  backwards compatibility with callers that haven't been updated. */
  requiredConcepts?: string[];
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
  /** Concept slugs the student has already unlocked (completed a teaching
   *  exercise). Optional. When provided, enables concept-aware
   *  recommendations in Rule 4. */
  unlockedConcepts?: string[];
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
    // Concept-aware first: pick the smallest "next learnable step" whose
    // prerequisites are already unlocked. Falls through to weak-spot
    // matching if no candidate qualifies.
    const unlockedSet = new Set(input.unlockedConcepts ?? []);
    const weakSet = new Set(weakSpots.map((w) => w.pattern));
    const conceptPick = input.unlockedConcepts
      ? pickConceptAwareCandidate(unattempted, unlockedSet)
      : null;

    let chosen: ViewableExercise;
    if (conceptPick) {
      chosen = conceptPick;
    } else {
      chosen = unattempted[0];
      for (const ex of unattempted) {
        if (ex.expectedConcepts.some((c) => weakSet.has(c))) {
          chosen = ex;
          break;
        }
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

/**
 * Student-facing variant of deriveNextAction.
 *
 * Same rule priority, but written in the student's voice ("Try X next"
 * rather than "Assign X to Y"). Used by GET /api/me/progress.
 *
 * Unlike the tutor version, 'assign' and 're-engage' are both clickable:
 * the student opens the exercise directly.
 */
export function deriveStudentNextAction(input: NextActionInput): NextAction {
  const {
    status,
    statusReasons,
    viewableExercises,
    sessionHistory,
    weakSpots,
  } = input;

  // ── Rule 1: get back into it ───────────────────────────────────
  if (status === 'at-risk') {
    const reason = firstReason(statusReasons);
    return {
      kind: 'reach-out',
      title: 'Pick up where you left off',
      detail: reason
        ? reason + '. Even one short session helps.'
        : 'It\'s been a few days. Even one short session helps.',
      clickable: false,
    };
  }

  // ── Rule 2: a gentle push ──────────────────────────────────────
  if (status === 'slipping') {
    return {
      kind: 'nudge',
      title: 'A little practice would help',
      detail: firstReason(statusReasons) || 'Try a short session this week.',
      clickable: false,
    };
  }

  // ── Rule 3: finish what you started ────────────────────────────
  const incomplete = sessionHistory.filter((s) => s.state !== 'complete');
  if (incomplete.length > 0) {
    const target = incomplete
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
    return {
      kind: 're-engage',
      title: 'Finish ' + (target.exerciseTitle || target.exerciseId),
      detail: 'You started this one — picking it back up is the fastest win.',
      exerciseId: target.exerciseId,
      exerciseTitle: target.exerciseTitle,
      clickable: true,
    };
  }

  // ── Rule 4: try something new ──────────────────────────────────
  const attemptedSlugs = new Set(sessionHistory.map((s) => s.exerciseId));
  const unattempted = viewableExercises.filter((e) => !attemptedSlugs.has(e.slug));
  if (unattempted.length > 0) {
    // Concept-aware first: pick the smallest "next learnable step" whose
    // prerequisites are already unlocked. Falls through to weak-spot
    // matching if no candidate qualifies.
    const unlockedSet = new Set(input.unlockedConcepts ?? []);
    const weakSet = new Set(weakSpots.map((w) => w.pattern));
    const conceptPick = input.unlockedConcepts
      ? pickConceptAwareCandidate(unattempted, unlockedSet)
      : null;

    let chosen: ViewableExercise;
    if (conceptPick) {
      chosen = conceptPick;
    } else {
      chosen = unattempted[0];
      for (const ex of unattempted) {
        if (ex.expectedConcepts.some((c) => weakSet.has(c))) {
          chosen = ex;
          break;
        }
      }
    }

    const concepts = chosen.expectedConcepts;
    let detail: string;
    if (concepts.length > 0 && concepts.some((c) => weakSet.has(c))) {
      const matching = concepts.filter((c) => weakSet.has(c));
      detail = 'Targets ' + matching.join(', ') + ' — a recent pattern.';
    } else if (concepts.length > 0) {
      detail = 'Covers ' + concepts.slice(0, 3).join(', ') + '.';
    } else {
      detail = 'Not yet attempted.';
    }

    return {
      kind: 'assign',
      title: 'Try ' + (chosen.title || chosen.slug) + ' next',
      detail,
      exerciseId: chosen.slug,
      exerciseTitle: chosen.title,
      clickable: true,
    };
  }

  // ── Rule 5: celebrate ──────────────────────────────────────────
  if (viewableExercises.length > 0 && sessionHistory.length >= viewableExercises.length) {
    return {
      kind: 'celebrate',
      title: 'All done — nice work',
      detail: 'Every assigned exercise is complete.',
      clickable: false,
    };
  }

  // ── Fallback ───────────────────────────────────────────────────
  return {
    kind: 'none',
    title: 'You\'re on track',
    detail: '',
    clickable: false,
  };
}


/**
 * Concept-aware candidate selection for Rule 4 (assign / try next).
 *
 * Given a set of unattempted exercises and the student's unlocked
 * concepts, pick the best "next learnable step":
 *
 *   1. Filter out exercises whose requiredConcepts aren't all unlocked
 *   2. Among the rest, prefer ones that teach ≥1 concept not yet unlocked
 *      (i.e. that advance the graph)
 *   3. Tiebreak by fewest NEW concepts (smallest leap)
 *   4. Tiebreak by original order (callers can pre-sort by difficulty)
 *
 * Returns null if no candidate qualifies — caller falls back to
 * pre-existing logic.
 */
function pickConceptAwareCandidate(
  unattempted: ViewableExercise[],
  unlockedConcepts: Set<string>
): ViewableExercise | null {
  const eligible = unattempted.filter((ex) => {
    const reqs = ex.requiredConcepts ?? [];
    return reqs.every((r) => unlockedConcepts.has(r));
  });
  if (eligible.length === 0) return null;

  // Prefer exercises that teach something new.
  const advancing = eligible.filter((ex) => {
    const teaches = ex.expectedConcepts ?? [];
    return teaches.some((c) => !unlockedConcepts.has(c));
  });
  const pool = advancing.length > 0 ? advancing : eligible;

  // Score: fewer new concepts is better. Among ties, original order wins.
  let best = pool[0];
  let bestNew = countNew(best, unlockedConcepts);
  for (let i = 1; i < pool.length; i++) {
    const n = countNew(pool[i], unlockedConcepts);
    if (n < bestNew) {
      best = pool[i];
      bestNew = n;
    }
  }
  return best;
}

function countNew(ex: ViewableExercise, unlockedConcepts: Set<string>): number {
  let n = 0;
  for (const c of ex.expectedConcepts ?? []) {
    if (!unlockedConcepts.has(c)) n++;
  }
  return n;
}
