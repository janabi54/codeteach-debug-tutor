import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type LLMFailureReason =
  | 'llm-error'
  | 'llm-timeout'
  | 'llm-rate-limit'
  | 'llm-invalid-response'
  | 'disabled'
  | 'not-configured';

export class LLMUnavailableError extends Error {
  constructor(public reason: LLMFailureReason, message: string) {
    super(message);
    this.name = 'LLMUnavailableError';
  }
}

type Provider = 'anthropic' | 'deepseek' | 'bazaarlink' | 'qwen' | 'disabled';

function resolveProvider(): Provider {
  const raw = (process.env.LLM_PROVIDER ?? 'disabled').toLowerCase().trim();
  if (
    raw === 'anthropic' ||
    raw === 'deepseek' ||
    raw === 'bazaarlink' ||
    raw === 'qwen'
  ) return raw;
  return 'disabled';
}

interface ProviderConfig {
  kind: 'anthropic' | 'openai-compatible';
  apiKey: string;
  baseURL?: string;
  defaultModel: string;
}

function resolveConfig(provider: Provider): ProviderConfig {
  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey || apiKey.startsWith('sk-ant-...')) {
      throw new LLMUnavailableError('not-configured', 'ANTHROPIC_API_KEY missing or placeholder');
    }
    return {
      kind: 'anthropic',
      apiKey,
      defaultModel: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    };
  }

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LLMUnavailableError('not-configured', 'DEEPSEEK_API_KEY missing');
    }
    return {
      kind: 'openai-compatible',
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
      defaultModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    };
  }

  if (provider === 'bazaarlink') {
    const apiKey = process.env.BAZAARLINK_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LLMUnavailableError('not-configured', 'BAZAARLINK_API_KEY missing');
    }
    return {
      kind: 'openai-compatible',
      apiKey,
      baseURL: process.env.BAZAARLINK_BASE_URL ?? 'https://api.bazaarlink.ai/v1',
      defaultModel: process.env.BAZAARLINK_MODEL ?? 'deepseek-v4-flash',
    };
  }

  if (provider === 'qwen') {
    const apiKey = process.env.QWEN_API_KEY;
    if (!apiKey || apiKey.trim().length === 0) {
      throw new LLMUnavailableError('not-configured', 'QWEN_API_KEY missing');
    }
    return {
      kind: 'openai-compatible',
      apiKey,
      baseURL:
        process.env.QWEN_BASE_URL ??
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      defaultModel: process.env.QWEN_MODEL ?? 'qwen-plus',
    };
  }

  throw new LLMUnavailableError('disabled', 'LLM_PROVIDER is disabled');
}

const TIMEOUT_MS = 8000;
const breaker = { failures: 0, threshold: 5, cooldownMs: 30_000, openedAt: 0 };

function breakerIsOpen(): boolean {
  if (breaker.failures < breaker.threshold) return false;
  if (Date.now() - breaker.openedAt > breaker.cooldownMs) {
    breaker.failures = 0;
    return false;
  }
  return true;
}

export interface LLMCallParams {
  system: string;
  user: string;
  maxTokens?: number;
}

export async function callLLM(params: LLMCallParams): Promise<string> {
  const provider = resolveProvider();

  if (provider === 'disabled') {
    throw new LLMUnavailableError('disabled', 'LLM disabled by config');
  }

  if (breakerIsOpen()) {
    throw new LLMUnavailableError('llm-error', 'Circuit breaker open');
  }

  let config: ProviderConfig;
  try {
    config = resolveConfig(provider);
  } catch (err) {
    if (err instanceof LLMUnavailableError) throw err;
    throw new LLMUnavailableError('not-configured', String((err as any)?.message ?? err));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const text = await callProvider(config, params, controller.signal);
    breaker.failures = 0;
    return text;
  } catch (err: any) {
    breaker.failures++;
    breaker.openedAt = Date.now();
    console.error(`[llm] provider=${provider} error:`, err?.message ?? err);

    if (err.name === 'AbortError') {
      throw new LLMUnavailableError('llm-timeout', `LLM timed out after ${TIMEOUT_MS}ms`);
    }
    if (err.status === 429 || err?.response?.status === 429) {
      throw new LLMUnavailableError('llm-rate-limit', 'Rate limited');
    }
    throw new LLMUnavailableError('llm-error', err?.message ?? 'Unknown LLM error');
  } finally {
    clearTimeout(timeout);
  }
}

async function callProvider(
  config: ProviderConfig,
  params: LLMCallParams,
  signal: AbortSignal
): Promise<string> {
  if (config.kind === 'anthropic') {
    const client = new Anthropic({ apiKey: config.apiKey });
    const completion = await client.messages.create(
      {
        model: config.defaultModel,
        max_tokens: params.maxTokens ?? 500,
        system: params.system,
        messages: [{ role: 'user', content: params.user }],
      },
      { signal }
    );
    const block = completion.content[0];
    return block?.type === 'text' ? block.text : '';
  }

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
  const completion = await client.chat.completions.create(
    {
      model: config.defaultModel,
      max_tokens: params.maxTokens ?? 500,
      messages: [
        { role: 'system', content: params.system },
        { role: 'user', content: params.user },
      ],
    },
    { signal }
  );
  return completion.choices?.[0]?.message?.content ?? '';
}
