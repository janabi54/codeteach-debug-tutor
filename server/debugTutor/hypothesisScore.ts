import { callLLM, LLMUnavailableError } from './fallback/llmWrapper.js';

export type HypothesisQuality = 'vague' | 'plausible' | 'precise' | 'unscored';

export interface HypothesisScore {
  quality: HypothesisQuality;
  feedback: string;
  scoredBy: 'llm' | 'heuristic';
}

const SCORING_PROMPT = `You are grading a student's hypothesis about a bug in their code.

The detected bug pattern was: "{pattern}"
The student's code (excerpt): "{code}"
The student wrote: "{hypothesis}"

Grade the REASONING, not whether it's correct. A wrong but specific theory
is better reasoning than a right but vague one.

- "vague"     — names a symptom or restates the error. No mechanism proposed.
- "plausible" — points at the right area and proposes a mechanism, but stays general.
- "precise"   — names a specific mechanism, location, or fix direction.

Then write ONE sentence of feedback (max 20 words) addressed to the student.
Feedback should acknowledge what they got right and nudge them to be more
specific if they were vague. Do NOT reveal the answer.

Respond with JSON only:
{ "quality": "vague" | "plausible" | "precise", "feedback": "<one sentence>" }`;

export async function scoreHypothesis(
  text: string,
  pattern: string | null,
  codeSnippet?: string
): Promise<HypothesisScore> {
  const trimmed = text.trim();

  if (trimmed.length < 10) {
    return {
      quality: 'unscored',
      feedback: 'Try a full sentence next time — even a rough theory helps.',
      scoredBy: 'heuristic',
    };
  }

  try {
    const snippet = (codeSnippet ?? '').slice(0, 500);
    const raw = await callLLM({
      system: SCORING_PROMPT
        .replace('{pattern}', pattern ?? 'unknown')
        .replace('{code}', snippet || '(not provided)')
        .replace('{hypothesis}', trimmed),
      user: 'Grade this hypothesis.',
      maxTokens: 200,
    });
    const parsed = safeParse(raw);
    if (
      parsed.quality &&
      ['vague', 'plausible', 'precise'].includes(parsed.quality) &&
      typeof parsed.feedback === 'string'
    ) {
      return {
        quality: parsed.quality,
        feedback: parsed.feedback,
        scoredBy: 'llm',
      };
    }
    throw new LLMUnavailableError('llm-invalid-response', 'Bad shape');
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      return heuristicScore(trimmed);
    }
    throw err;
  }
}

/**
 * The heuristic scorer is a fallback. It's deliberately conservative —
 * it returns 'vague' or 'plausible' only, never 'precise'. Distinguishing
 * plausible from precise requires understanding what the student actually
 * meant, which is what the LLM does. When there's no LLM key, marking
 * everything as at-most-plausible is honest.
 */
function heuristicScore(text: string): HypothesisScore {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const lower = text.toLowerCase();

  if (words < 5) {
    return {
      quality: 'vague',
      feedback: 'Try a longer, more specific sentence.',
      scoredBy: 'heuristic',
    };
  }

  const hasMechanism = /\b(because|since|so|when|if|which means|that means|due to)\b/.test(lower);
  const hasSpecific = /(<=|>=|==|!=|length|index|undefined|null|await|promise|return|off by|one too|past the end|too far)/.test(lower);

  if (hasMechanism && hasSpecific) {
    return {
      quality: 'plausible',
      feedback: 'Right area. If you can, name the exact mechanism.',
      scoredBy: 'heuristic',
    };
  }

  return {
    quality: 'vague',
    feedback: 'Can you say what specifically might be causing it?',
    scoredBy: 'heuristic',
  };
}

function safeParse(text: string): any {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : {};
  } catch {
    return {};
  }
}
