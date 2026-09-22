import { lintWithESLint } from './eslintRunner.js';
import { analyzeErrorOutput } from './errorHeuristics.js';
import type { MistakePattern } from '../tutorService.js';

export interface PatternCandidate {
  pattern: MistakePattern;
  confidence: 'high' | 'medium' | 'low';
  source: 'eslint' | 'error-output' | 'both';
  evidence: string;
  location?: { line: number; column: number };
  ruleId?: string;
}
export interface PreClassificationResult {
  candidates: PatternCandidate[];
  topPattern: MistakePattern | null;
  summaryForLLM: string;
}

export async function preClassify(code: string, language: string,
  errorOutput: string): Promise<PreClassificationResult> {
  const [eslintCandidates, errorCandidates] = await Promise.all([
    lintWithESLint(code, language).catch((e: any) => { console.error('[preClassify] eslint threw:', e?.message ?? e); return [] as PatternCandidate[]; }),
    Promise.resolve(analyzeErrorOutput(errorOutput, language)),
  ]);
  const merged = mergeCandidates(eslintCandidates, errorCandidates);
  return { candidates: merged, topPattern: pickTop(merged), summaryForLLM: formatForLLM(merged) };
}

function mergeCandidates(a: PatternCandidate[], b: PatternCandidate[]): PatternCandidate[] {
  const byPattern = new Map<MistakePattern, PatternCandidate>();
  for (const c of a) byPattern.set(c.pattern, { ...c });
  for (const c of b) {
    const existing = byPattern.get(c.pattern);
    if (existing) {
      existing.confidence = 'high'; existing.source = 'both';
      existing.evidence = `${existing.evidence}; ${c.evidence}`;
    } else byPattern.set(c.pattern, { ...c });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return [...byPattern.values()].sort((x, y) => order[x.confidence] - order[y.confidence]);
}

function pickTop(candidates: PatternCandidate[]): MistakePattern | null {
  // Prefer any ESLint signal over error-output — code analysis points at
  // the root cause; error strings describe the symptom.
  const fromEslint = candidates.find(
    c => c.source === 'eslint' || c.source === 'both'
  );
  if (fromEslint) return fromEslint.pattern;

  const strong = candidates.filter(
    c => c.confidence === 'high' || c.confidence === 'medium'
  );
  return strong[0]?.pattern ?? null;
}

function formatForLLM(candidates: PatternCandidate[]): string {
  if (!candidates.length) return 'Pre-classifier found no static patterns. Rely on your own analysis.';
  const lines = candidates.slice(0, 3).map(c =>
    `- ${c.pattern} (${c.confidence}, ${c.source}): ${c.evidence}` +
    (c.location ? ` [line ${c.location.line}]` : ''));
  return ['PRE-CLASSIFIER SIGNALS (confirm, refine, or reject — do not repeat verbatim):',
    ...lines, '', 'Use these to sharpen your Socratic question.',
    'NEVER tell the student "the classifier says…".'].join('\n');
}
