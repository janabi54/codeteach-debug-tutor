import { callLLM, LLMUnavailableError } from './fallback/llmWrapper.js';

export type PostMortemScore = 'correct' | 'partial' | 'incorrect' | 'unscored';

export interface PostMortemResult {
  score: PostMortemScore;
  feedback: string;
  scoredBy: 'llm' | 'heuristic';
}

const SCORING_PROMPT = `You are evaluating a student's post-mortem explanation of a bug they just fixed.

The bug pattern detected was: "{pattern}"
The student wrote: "{explanation}"

Classify the explanation into exactly one of these:

- "correct" — captures the actual root cause. Names the mechanism, not just the symptom.
- "partial" — shows some understanding but misses the core reason. Points at the right area without nailing why.
- "incorrect" — misunderstands the cause, or just restates the symptom.

Then write ONE sentence of feedback (max 25 words) addressed to the student. Be encouraging but honest. Do not give a fuller explanation — you're confirming or gently correcting.

Respond with JSON only:
{ "score": "correct" | "partial" | "incorrect", "feedback": "<one sentence>" }`;

export async function scorePostMortem(
  explanation: string,
  pattern: string | null
): Promise<PostMortemResult> {
  const trimmed = explanation.trim();
  if (trimmed.length < 15) {
    return {
      score: 'unscored',
      feedback: 'Write a bit more next time — a sentence or two is enough.',
      scoredBy: 'heuristic',
    };
  }

  try {
    const raw = await callLLM({
      system: SCORING_PROMPT
        .replace('{pattern}', pattern ?? 'unknown')
        .replace('{explanation}', trimmed),
      user: 'Score this post-mortem.',
      maxTokens: 200,
    });
    const parsed = safeParse(raw);
    if (
      parsed.score &&
      ['correct', 'partial', 'incorrect'].includes(parsed.score) &&
      typeof parsed.feedback === 'string'
    ) {
      return {
        score: parsed.score,
        feedback: parsed.feedback,
        scoredBy: 'llm',
      };
    }
    throw new LLMUnavailableError('llm-invalid-response', 'Bad shape');
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      return heuristicScore(trimmed, pattern);
    }
    throw err;
  }
}

function heuristicScore(
  explanation: string,
  pattern: string | null
): PostMortemResult {
  const lower = explanation.toLowerCase();

  const causeWords = [
    'because', 'since', 'due to', 'reason', 'off by one',
    'one too', 'one more', 'one less', 'past the end',
    'never reset', 'mutating', 'changed while', 'await', 'promise',
  ];
  const symptomOnly = [
    'it crashed', 'it errored', 'it said', 'it complained',
    'undefined', 'null', 'not working',
  ];

  const hasCause = causeWords.some((w) => lower.includes(w));
  const hasSymptom = symptomOnly.some((w) => lower.includes(w));
  const lengthOk = explanation.split(/\s+/).length >= 8;

  if (hasCause && lengthOk) {
    return {
      score: 'partial',
      feedback:
        'Good — you pointed at a cause. The LLM scorer would confirm or refine this.',
      scoredBy: 'heuristic',
    };
  }
  if (hasSymptom && !hasCause) {
    return {
      score: 'incorrect',
      feedback:
        'Try explaining why it happened, not just what the error said.',
      scoredBy: 'heuristic',
    };
  }
  return {
    score: 'unscored',
    feedback:
      'Saved. Your instructor will review this once the AI scorer is turned on.',
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
