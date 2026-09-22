import { Linter } from 'eslint';
import { mapEslintRule } from './ruleMap.js';
import type { PatternCandidate } from './index.js';
import { loopBoundHeuristic } from './rules/loopBoundHeuristic.js';
import { mutationInIteration } from './rules/mutationInIteration.js';
import { asyncMissingAwait } from './rules/asyncMissingAwait.js';
import { runPythonFallback } from './pythonFallback.js';

const codeteachPlugin = {
  rules: {
    'loop-bound-heuristic': loopBoundHeuristic,
    'mutation-in-iteration': mutationInIteration,
    'async-missing-await': asyncMissingAwait,
  },
};

const COMMON_GLOBALS = {
  console: 'readonly',
  process: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  fetch: 'readonly',
  Promise: 'readonly',
  Array: 'readonly',
  Object: 'readonly',
  String: 'readonly',
  Number: 'readonly',
  Boolean: 'readonly',
  JSON: 'readonly',
  Math: 'readonly',
  Date: 'readonly',
  RegExp: 'readonly',
  Error: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
};

const CONFIGS: Record<string, any[]> = {
  javascript: [{
    plugins: { codeteach: codeteachPlugin },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: COMMON_GLOBALS },
    rules: {
      'no-undef': 'off',
      eqeqeq: ['warn', 'always'],
      'no-constant-condition': 'warn',
      'no-unreachable': 'warn',
      'no-self-compare': 'warn',
      'array-callback-return': 'warn',
      'no-unsafe-optional-chaining': 'warn',
      'no-async-promise-executor': 'warn',
      'require-atomic-updates': 'warn',
      'no-return-assign': 'warn',
      'no-dupe-keys': 'warn',
      'codeteach/loop-bound-heuristic': 'warn',
      'codeteach/mutation-in-iteration': 'warn',
      'codeteach/async-missing-await': 'warn',
    },
  }],
  typescript: [{
    plugins: { codeteach: codeteachPlugin },
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: COMMON_GLOBALS },
    rules: {
      eqeqeq: ['warn', 'always'],
      'no-constant-condition': 'warn',
      'no-unreachable': 'warn',
      'codeteach/loop-bound-heuristic': 'warn',
      'codeteach/mutation-in-iteration': 'warn',
      'codeteach/async-missing-await': 'warn',
    },
  }],
  python: [],
};

let sharedLinter: Linter | null = null;
function getLinter(): Linter {
  if (!sharedLinter) sharedLinter = new Linter({ configType: 'flat' } as any);
  return sharedLinter;
}

export async function lintWithESLint(code: string, language: string): Promise<PatternCandidate[]> {
  const configs = CONFIGS[language];
  if (!configs || configs.length === 0) return runPythonFallback(code, language);

  const linter = getLinter();
  let messages: any[] = [];
  try {
    messages = linter.verify(code, configs[0], { filename: 's.' + (language === 'typescript' ? 'ts' : 'js') });
  } catch (e: any) {
    console.error('[eslintRunner] verify threw:', e?.message ?? e);
    return [];
  }

  const out: PatternCandidate[] = [];

  // Detect parse errors first — if ESLint can't parse, its other messages
  // are meaningless. Surface the parse error explicitly.
  const parseError = messages.find(
    (m: any) => m.fatal === true || /Parsing error/i.test(m.message ?? '')
  );
  if (parseError) {
    out.push({
      pattern: 'syntax-error',
      confidence: 'high',
      source: 'eslint',
      evidence: `Code does not parse: ${parseError.message} (line ${parseError.line ?? '?'})`,
      location: { line: parseError.line ?? 1, column: parseError.column ?? 1 },
      ruleId: 'parse-error',
    });
    return out;
  }

  for (const msg of messages) {
    if (msg.severity === 0) continue;
    const mapped = mapEslintRule(msg.ruleId ?? '', msg, code);
    if (mapped) out.push(mapped);
  }
  return out;
}
