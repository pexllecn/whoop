/**
 * Chat providers for the coach. Ollama runs on this computer and is the
 * default. OpenAI and Anthropic are cloud services: they are only contacted
 * when the user selected them AND ticked "allow sending summaries".
 */
import type { AppSettings } from '../storage/settings';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class CoachConfigError extends Error {}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function assertProviderAllowed(coach: AppSettings['coach']): void {
  if (coach.provider === 'ollama') {
    let host = '';
    try {
      host = new URL(coach.ollamaUrl).hostname;
    } catch {
      throw new CoachConfigError(`Invalid Ollama URL: ${coach.ollamaUrl}`);
    }
    if (!LOOPBACK_HOSTS.has(host)) throw new CoachConfigError('The Ollama URL must point at this computer (127.0.0.1 or localhost).');
    return;
  }
  if (!coach.allowExternal) {
    throw new CoachConfigError(`Sending data to ${coach.provider === 'openai' ? 'OpenAI' : 'Anthropic'} is disabled. Enable it in Settings, or use Ollama locally.`);
  }
}

export function resolveApiKey(coach: AppSettings['coach']): string {
  const key = coach.provider === 'openai' ? process.env.OPENAI_API_KEY || coach.openaiApiKey : process.env.ANTHROPIC_API_KEY || coach.anthropicApiKey;
  if (!key) throw new CoachConfigError(`No ${coach.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key configured.`);
  return key;
}

export function providerModel(coach: AppSettings['coach']): string {
  return coach.provider === 'ollama' ? coach.ollamaModel : coach.provider === 'openai' ? coach.openaiModel : coach.anthropicModel;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${new URL(url).host} responded ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as unknown;
}

export async function chat(coach: AppSettings['coach'], system: string, messages: ChatMessage[], fetchImpl: typeof fetch = fetch): Promise<string> {
  assertProviderAllowed(coach);
  switch (coach.provider) {
    case 'ollama': {
      const data = (await postJson(
        `${coach.ollamaUrl.replace(/\/$/, '')}/api/chat`,
        {},
        { model: coach.ollamaModel, stream: false, options: { temperature: 0.4 }, messages: [{ role: 'system', content: system }, ...messages] },
        fetchImpl,
      )) as { message?: { content?: string } };
      return data.message?.content?.trim() ?? '';
    }
    case 'openai': {
      const data = (await postJson(
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${resolveApiKey(coach)}` },
        { model: coach.openaiModel, temperature: 0.4, messages: [{ role: 'system', content: system }, ...messages] },
        fetchImpl,
      )) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content?.trim() ?? '';
    }
    case 'anthropic': {
      const data = (await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': resolveApiKey(coach), 'anthropic-version': '2023-06-01' },
        { model: coach.anthropicModel, max_tokens: 1024, system, messages },
        fetchImpl,
      )) as { content?: Array<{ type: string; text?: string }> };
      return (data.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim();
    }
  }
}
