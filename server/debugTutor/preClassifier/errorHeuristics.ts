import type { PatternCandidate } from './index.js';
import type { MistakePattern } from '../tutorService.js';

interface H { pattern: MistakePattern; confidence: 'high' | 'medium' | 'low';
  test: RegExp; describe: (m: RegExpMatchArray) => string; languages?: string[]; }

const H: H[] = [
  { pattern: 'off-by-one', confidence: 'high', test: /IndexError:\s*list index out of range/i, describe: () => `Runtime index error`, languages: ['python'] },
  { pattern: 'type-mismatch', confidence: 'high', test: /TypeError:\s*(?:unsupported operand|can only concatenate)/i, describe: m => `Type error: ${m[0].trim()}`, languages: ['python'] },
  { pattern: 'null-undefined', confidence: 'high', test: /AttributeError:\s*'NoneType' object has no attribute/i, describe: () => `Attribute access on None`, languages: ['python'] },
  { pattern: 'scope-issue', confidence: 'high', test: /UnboundLocalError|NameError:\s*name '[^']+' is not defined/i, describe: () => `Variable not in scope`, languages: ['python'] },
  { pattern: 'null-undefined', confidence: 'high', test: /TypeError:\s*Cannot read propert(?:y|ies) of (?:undefined|null)/i, describe: () => `Property access on undefined`, languages: ['javascript', 'typescript'] },
  { pattern: 'null-undefined', confidence: 'high', test: /TypeError:\s*(?:undefined|null) is not a function/i, describe: () => `Called a non-function`, languages: ['javascript', 'typescript'] },
  { pattern: 'scope-issue', confidence: 'high', test: /ReferenceError:\s*([a-zA-Z_$][\w$]*)\s+is not defined/i, describe: m => `\`${m[1]}\` not defined`, languages: ['javascript', 'typescript'] },
  { pattern: 'infinite-loop', confidence: 'medium', test: /Maximum call stack size exceeded/i, describe: () => `Stack overflow`, languages: ['javascript', 'typescript'] },
  { pattern: 'async-await', confidence: 'medium', test: /(?:await is only valid|Unexpected reserved word 'await')/i, describe: () => `await outside async`, languages: ['javascript', 'typescript'] },
];

export function analyzeErrorOutput(err: string, language: string): PatternCandidate[] {
  if (!err?.trim()) return [];
  const out: PatternCandidate[] = [];
  for (const h of H) {
    if (h.languages && !h.languages.includes(language)) continue;
    const match = err.match(h.test);
    if (match) out.push({ pattern: h.pattern, confidence: h.confidence, source: 'error-output', evidence: h.describe(match) });
  }
  return out;
}
