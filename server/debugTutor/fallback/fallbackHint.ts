import type { PreClassificationResult } from '../preClassifier/index.js';
import type { MistakePattern } from '../tutorService.js';

export interface FallbackHint {
  message: string; hintLevel: 1;
  detectedPattern: MistakePattern | null;
  isFallback: true;
  reason: 'llm-error' | 'llm-timeout' | 'llm-rate-limit' | 'llm-invalid-response' | 'disabled';
}

export function generateFallbackHint(c: PreClassificationResult, reason: FallbackHint['reason']): FallbackHint {
  const pattern = c.topPattern;
  return {
    message: pattern ? patternNudge(pattern) : genericNudge(),
    hintLevel: 1,
    detectedPattern: pattern,
    isFallback: true, reason,
  };
}
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
function genericNudge() {
  return pick([
    "Let's slow down — can you walk me through what you expect your code to do, line by line, out loud?",
    "Before we look for the bug, describe the last thing your code does correctly.",
    "Try adding a print/log statement just before the failure point. What value do you expect?",
    "Break the problem into the smallest input that still fails.",
  ]);
}
function patternNudge(p: MistakePattern): string {
  return pick(PATTERN_NUDGES[p] ?? [genericNudge()]);
}
const PATTERN_NUDGES: Record<MistakePattern, string[]> = {
  'off-by-one': ["Take another look at how your loop decides when to stop. Is that the boundary you actually want?", "What value does your loop variable hold on the very last iteration?"],
  'type-mismatch': ["Check the type of each value as it flows through your expression. Do any of them surprise you?", "If you printed the type of every variable on the failing line, what would you see?"],
  'scope-issue': ["Sketch where each variable is declared and where it's used.", "Is the value you're looking for declared before the line that uses it?"],
  'infinite-loop': ["Does every iteration of your loop move the loop variable closer to its exit condition?", "Which line changes the thing your loop is testing?"],
  'null-undefined': ["Could that value be empty here? What would that mean for the next line?", "Which variable on the failing line might not have been set the way you expect?"],
  'mutation-side-effect': ["Are you changing a collection while you're still walking through it?", "Does the function you called modify the thing you passed it?"],
  'wrong-operator': ["Say your condition out loud in English. Does the operator match?", "Would 'and' and 'or' give different results here?"],
  'missing-return': ["What does your function actually hand back — on every path, or just one?", "If you assigned the call's result to a variable, what would it hold?"],
  'async-await': ["Is the value you're using the result itself, or a promise of the result?", "Which function is doing the waiting, and is it allowed to wait?"],
  'index-out-of-bounds': ["What's the largest valid index for your collection?", "Is the length changing between when you checked it and when you used it?"],
  'logic-inversion': ["Say your condition out loud. 'If not empty' and 'if empty' sound alike — which did you write?", "For the failing input, which branch runs? Is that the one you meant?"],
  'uninitialized-variable': ["Where does that variable first get a value — and is that before the line that reads it?", "Is there a path where it's used before it's set?"],
  'syntax-error': ["The parser couldn't make sense of this line — read it character by character. Is there a stray symbol, a missing bracket, or an unmatched quote?", "This looks like a small typo rather than a logic bug. What does the error message say is wrong, and where?", "Try reading the failing line out loud, character by character. Does it say what you meant to write?"],
};
