import type { PreClassificationResult } from '../preClassifier/index.js';
import type { MistakePattern, HintLevel } from '../tutorService.js';

export interface RunEvidence {
  submitted: string;
  expected: string;
  predicted?: string;
  trace?: Array<{ step: number; loopVar: string; value: string }>;
}

export interface FallbackHint {
  message: string;
  hintLevel: HintLevel;
  detectedPattern: MistakePattern | null;
  isFallback: true;
  reason: 'llm-error' | 'llm-timeout' | 'llm-rate-limit' | 'llm-invalid-response' | 'disabled' | 'not-configured';
}

/**
 * Fallback hint generator.
 *
 * Prefers evidence-based hints (prediction, actual output, trace) when a
 * run is available. Falls back to pattern or generic nudges otherwise.
 * Always respects the requested hint level — early levels are open-ended,
 * later levels are specific.
 */
export function generateFallbackHint(
  c: PreClassificationResult,
  reason: FallbackHint['reason'],
  run: RunEvidence | null = null,
  hintLevel: HintLevel = 1
): FallbackHint {
  const pattern = c.topPattern;

  if (run && (run.submitted || run.expected || (run.trace && run.trace.length > 0))) {
    return {
      message: evidenceNudge(run, hintLevel, pattern),
      hintLevel,
      detectedPattern: pattern,
      isFallback: true,
      reason,
    };
  }

  return {
    message: pattern ? patternNudge(pattern, hintLevel) : genericNudge(hintLevel),
    hintLevel,
    detectedPattern: pattern,
    isFallback: true,
    reason,
  };
}

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\n/g, ' / ');
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n) + '…';
}

function evidenceNudge(run: RunEvidence, level: HintLevel, pattern: MistakePattern | null): string {
  const submitted = (run.submitted || '').trim();
  const expected = (run.expected || '').trim();
  const predicted = (run.predicted || '').trim();
  const trace = run.trace || [];
  const matches = submitted === expected && expected.length > 0;

  // A. The student's code already matches — reinforce understanding.
  if (matches) {
    if (level >= 3) {
      return 'Your output matches. Look at the trace — what changed between the broken and working versions, and why does the new version produce the right result on every iteration?';
    }
    return 'Your output matches now. Before we move on — in your own words, why does the fix work?';
  }

  // B. Student predicted but was wrong. That's the most specific lever.
  if (predicted && predicted !== submitted && predicted !== expected) {
    if (level >= 3) {
      return 'You predicted "' + truncate(predicted, 50) + '" — the code printed "' +
        truncate(submitted || '(nothing)', 50) + '". Look at the trace and find the exact step where the actual behavior diverged from your prediction.';
    }
    if (level === 2) {
      return 'Your prediction was "' + truncate(predicted, 40) + '". Your code printed "' +
        truncate(submitted || '(nothing)', 40) + '". Compare them side by side — what is the first difference?';
    }
    return 'You predicted "' + truncate(predicted, 30) + '", your code printed "' +
      truncate(submitted || '(nothing)', 30) + '". Where do they diverge?';
  }

  // C. We have a trace and the code doesn't match. Point at a specific iteration.
  if (trace.length > 0) {
    const last = trace[trace.length - 1];
    if (level >= 3) {
      return 'Your loop ran ' + trace.length + ' iteration(s). On step ' + last.step + ', ' +
        last.loopVar + '=' + last.value + '. What condition made it stop — and is that the condition you meant?';
    }
    if (level === 2) {
      return 'Look at the trace: the loop ran ' + trace.length + ' time(s). On step ' + last.step + ', ' +
        last.loopVar + '=' + last.value + '. What would have to be different for one more iteration?';
    }
    return 'Your loop ran ' + trace.length + ' time(s) — compare that to how many you expected. What in the loop condition decides that count?';
  }

  if (pattern) return patternNudge(pattern, level);
  return genericNudge(level);
}

function genericNudge(level: HintLevel = 1): string {
  if (level >= 3) {
    return pick([
      'If you had to name the exact line where the behavior diverges from what you expected — which line would it be?',
      'Try printing every value right before the failing line. Compare each to what you thought it would be.',
    ]);
  }
  if (level === 2) {
    return pick([
      'Trace through what your code does with the smallest possible input. Where does the first surprise happen?',
      'What is the smallest input where your code still fails? Try running it.',
    ]);
  }
  return pick([
    "Let's slow down — can you walk me through what you expect your code to do, line by line, out loud?",
    'Before we look for the bug, describe the last thing your code does correctly.',
    'Try adding a print/log statement just before the failure point. What value do you expect?',
    'Break the problem into the smallest input that still fails.',
  ]);
}

function patternNudge(p: MistakePattern, level: HintLevel = 1): string {
  if (level <= 2) {
    return pick(PATTERN_NUDGES[p] ?? [genericNudge(level)]);
  }
  const sharpened: Partial<Record<MistakePattern, string>> = {
    'off-by-one': 'Look at the boundary of your loop — the smallest value and the largest. Is the loop stopping at the right place? Compare the trace against your expected iteration count.',
    'index-out-of-bounds': 'The last valid index for a collection of length N is N-1. What index is your code trying to reach, and how does it compare to that boundary?',
    'infinite-loop': 'Watch the value your loop condition tests. Does every iteration move it toward the exit? Look at the trace — is the same value repeating?',
  };
  if (sharpened[p]) return sharpened[p]!;
  return pick(PATTERN_NUDGES[p] ?? [genericNudge(level)]);
}

const PATTERN_NUDGES: Record<MistakePattern, string[]> = {
  'off-by-one': ['Take another look at how your loop decides when to stop. Is that the boundary you actually want?', 'What value does your loop variable hold on the very last iteration?'],
  'type-mismatch': ['Check the type of each value as it flows through your expression. Do any of them surprise you?', 'If you printed the type of every variable on the failing line, what would you see?'],
  'scope-issue': ['Sketch where each variable is declared and where it is used.', 'Is the value you are looking for declared before the line that uses it?'],
  'infinite-loop': ['Does every iteration of your loop move the loop variable closer to its exit condition?', 'Which line changes the thing your loop is testing?'],
  'null-undefined': ['Could that value be empty here? What would that mean for the next line?', 'Which variable on the failing line might not have been set the way you expect?'],
  'mutation-side-effect': ['Are you changing a collection while you are still walking through it?', 'Does the function you called modify the thing you passed it?'],
  'wrong-operator': ['Say your condition out loud in English. Does the operator match?', "Would 'and' and 'or' give different results here?"],
  'missing-return': ['What does your function actually hand back — on every path, or just one?', "If you assigned the call's result to a variable, what would it hold?"],
  'async-await': ['Is the value you are using the result itself, or a promise of the result?', 'Which function is doing the waiting, and is it allowed to wait?'],
  'index-out-of-bounds': ["What is the largest valid index for your collection?", 'Is the length changing between when you checked it and when you used it?'],
  'logic-inversion': ["Say your condition out loud. 'If not empty' and 'if empty' sound alike — which did you write?", 'For the failing input, which branch runs? Is that the one you meant?'],
  'uninitialized-variable': ['Where does that variable first get a value — and is that before the line that reads it?', 'Is there a path where it is used before it is set?'],
  'syntax-error': ["The parser couldn't make sense of this line — read it character by character. Is there a stray symbol, a missing bracket, or an unmatched quote?", 'This looks like a small typo rather than a logic bug. What does the error message say is wrong, and where?', 'Try reading the failing line out loud, character by character. Does it say what you meant to write?'],
};
