import { desc } from 'drizzle-orm';
import { jsonError, readJson } from '@/lib/api';
import { buildCoachContext } from '@/lib/coach/contextBuilder';
import { systemPromptWithContext } from '@/lib/coach/prompts';
import { CoachConfigError, chat, providerModel, type ChatMessage } from '@/lib/coach/providers';
import { getDb } from '@/lib/storage/db';
import { coachMessages } from '@/lib/storage/schema';
import { getSettings } from '@/lib/storage/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** Conversation history (last 40 messages) and the context the next question would carry. */
export function GET() {
  const db = getDb();
  const history = db.select().from(coachMessages).orderBy(desc(coachMessages.id)).limit(40).all().reverse();
  return Response.json({ history, context: buildCoachContext(db) });
}

export async function POST(request: Request) {
  let body: { message?: string; reset?: boolean };
  try {
    body = await readJson(request, 64 * 1024);
  } catch {
    return jsonError('Invalid JSON');
  }
  const db = getDb();
  if (body.reset) {
    db.delete(coachMessages).run();
    return Response.json({ ok: true });
  }
  const message = body.message?.trim();
  if (!message || message.length > 4000) return jsonError('Message must be 1-4000 characters');

  const settings = getSettings(db);
  const context = buildCoachContext(db);
  const previous: ChatMessage[] = db
    .select({ role: coachMessages.role, content: coachMessages.content })
    .from(coachMessages)
    .orderBy(desc(coachMessages.id))
    .limit(12)
    .all()
    .reverse()
    .filter((m): m is ChatMessage => m.role === 'user' || m.role === 'assistant');

  try {
    const reply = await chat(settings.coach, systemPromptWithContext(context), [...previous, { role: 'user', content: message }]);
    const now = Date.now();
    const model = providerModel(settings.coach);
    db.insert(coachMessages).values({ ts: now, role: 'user', content: message, provider: settings.coach.provider, model }).run();
    db.insert(coachMessages).values({ ts: now + 1, role: 'assistant', content: reply || '(empty response)', provider: settings.coach.provider, model }).run();
    return Response.json({ reply, provider: settings.coach.provider, model, context });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (error instanceof CoachConfigError) return jsonError(text, 400);
    const hint = settings.coach.provider === 'ollama' ? ' Is Ollama running (`ollama serve`) and is the model pulled (`ollama pull ' + settings.coach.ollamaModel + '`)?' : '';
    return jsonError(`Coach request failed: ${text}.${hint}`, 502);
  }
}

