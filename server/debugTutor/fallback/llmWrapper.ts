import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type LLMFailureReason = 'llm-error' | 'llm-timeout' | 'llm-rate-limit' | 'llm-invalid-response' | 'disabled';
export class LLMUnavailableError extends Error {
  constructor(public reason: LLMFailureReason, message: string) { super(message); this.name = 'LLMUnavailableError'; }
}
const TIMEOUT = 8000;
const breaker = { failures: 0, threshold: 5, cooldownMs: 30_000, openedAt: 0 };
function isOpen() {
  if (breaker.failures < breaker.threshold) return false;
  if (Date.now() - breaker.openedAt > breaker.cooldownMs) { breaker.failures = 0; return false; }
  return true;
}
export async function callLLM(p: { system: string; user: string; maxTokens?: number }): Promise<string> {
  if (process.env.DEBUG_TUTOR_LLM_DISABLED === 'true')
    throw new LLMUnavailableError('disabled', 'LLM disabled by config');
  if (isOpen()) throw new LLMUnavailableError('llm-error', 'Circuit breaker open');
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const c = await anthropic.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: p.maxTokens ?? 500,
      system: p.system, messages: [{ role: 'user', content: p.user }],
    }, { signal: controller.signal } as any);
    breaker.failures = 0;
    return c.content[0].type === 'text' ? c.content[0].text : '';
  } catch (err: any) {
    breaker.failures++; breaker.openedAt = Date.now();
    if (err.name === 'AbortError') throw new LLMUnavailableError('llm-timeout', 'Timed out');
    if (err.status === 429) throw new LLMUnavailableError('llm-rate-limit', 'Rate limited');
    throw new LLMUnavailableError('llm-error', err.message ?? 'Unknown');
  } finally { clearTimeout(to); }
}
