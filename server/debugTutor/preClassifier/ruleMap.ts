import type { PatternCandidate } from './index.js';
import type { MistakePattern } from '../tutorService.js';

interface M { pattern: MistakePattern; confidence: 'high' | 'medium' | 'low'; describe: (m: any) => string; }

const RULE_MAP: Record<string, M> = {
  // no-undef intentionally unmapped: see eslintRunner.ts
  'no-unused-vars': { pattern: 'logic-inversion', confidence: 'low', describe: m => `Unused: ${m.message}` },
  eqeqeq: { pattern: 'type-mismatch', confidence: 'medium', describe: () => `Loose equality may cause coercion bugs` },
  'no-constant-condition': { pattern: 'infinite-loop', confidence: 'high', describe: () => `Constant condition — loop may not exit` },
  'no-unreachable': { pattern: 'logic-inversion', confidence: 'high', describe: () => `Unreachable code — check control flow` },
  'no-self-compare': { pattern: 'logic-inversion', confidence: 'high', describe: () => `Variable compared to itself` },
  'array-callback-return': { pattern: 'missing-return', confidence: 'high', describe: () => `Callback missing return on some path` },
  'no-unsafe-optional-chaining': { pattern: 'null-undefined', confidence: 'high', describe: () => `Optional chaining may short-circuit to undefined` },
  'no-async-promise-executor': { pattern: 'async-await', confidence: 'high', describe: () => `async function passed to Promise executor` },
  'require-atomic-updates': { pattern: 'mutation-side-effect', confidence: 'medium', describe: () => `Race or shared-state mutation` },
  'no-return-assign': { pattern: 'logic-inversion', confidence: 'high', describe: () => `Assignment in return position` },
  'no-dupe-keys': { pattern: 'logic-inversion', confidence: 'high', describe: () => `Duplicate object key` },
  'codeteach/loop-bound-heuristic': { pattern: 'off-by-one', confidence: 'medium', describe: m => m.message },
  'codeteach/mutation-in-iteration': { pattern: 'mutation-side-effect', confidence: 'medium', describe: m => m.message },
  'codeteach/async-missing-await': { pattern: 'async-await', confidence: 'high', describe: m => m.message },
};

export function mapEslintRule(ruleId: string, msg: any, _code: string): PatternCandidate | null {
  const mapping = RULE_MAP[ruleId];
  if (!mapping) return null;
  return {
    pattern: mapping.pattern, confidence: mapping.confidence, source: 'eslint',
    evidence: mapping.describe(msg),
    location: { line: msg.line ?? 1, column: msg.column ?? 1 },
    ruleId,
  };
}
