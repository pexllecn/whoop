'use client';

import { useEffect, useRef, useState } from 'react';
import { Badge, Card } from './ui';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export function CoachChat({ provider, model, external, starters }: { provider: string; model: string; external: boolean; starters: string[] }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [context, setContext] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void fetch('/api/coach')
      .then((r) => r.json())
      .then((data: { history: Array<{ role: string; content: string }>; context: unknown }) => {
        setMessages(data.history.filter((m): m is Message => m.role === 'user' || m.role === 'assistant'));
        setContext(data.context);
      });
  }, []);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), [messages, busy]);

  const ask = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setDraft('');
    setError(null);
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: message }]);
    try {
      const response = await fetch('/api/coach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
      const data = (await response.json()) as { reply?: string; error?: string; context?: unknown };
      if (!response.ok) throw new Error(data.error ?? 'Request failed');
      setMessages((m) => [...m, { role: 'assistant', content: data.reply ?? '' }]);
      if (data.context) setContext(data.context);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed');
      setMessages((m) => m.slice(0, -1));
      setDraft(message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    await fetch('/api/coach', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reset: true }) });
    setMessages([]);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card
        title="Conversation"
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={external ? 'warn' : 'good'}>{external ? 'cloud' : 'local'} · {provider}</Badge>
            {messages.length > 0 && (
              <button type="button" onClick={() => void reset()} className="text-xs text-muted hover:text-ink-2">
                Clear
              </button>
            )}
          </div>
        }
      >
        <div className="flex min-h-[380px] flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto" aria-live="polite">
            {messages.length === 0 && (
              <div className="py-6 text-sm text-muted">
                Ask about today’s readiness, sleep or training load. The coach only sees your daily summaries (listed on the right), never raw samples.
                <div className="mt-4 flex flex-wrap gap-2">
                  {starters.map((q) => (
                    <button key={q} type="button" onClick={() => void ask(q)} className="rounded-full border border-hair px-3 py-1.5 text-xs text-ink-2 hover:bg-raised">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : ''}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${m.role === 'user' ? 'bg-accent/20 text-ink' : 'bg-raised text-ink'}`}>{m.content}</div>
              </div>
            ))}
            {busy && <div className="text-sm text-muted">Thinking with {model}…</div>}
            <div ref={endRef} />
          </div>
          {error && <p className="mt-3 text-sm text-bad">{error}</p>}
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <label className="sr-only" htmlFor="coach-input">
              Message
            </label>
            <input
              id="coach-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask the coach…"
              className="flex-1 rounded-lg border border-hair bg-raised px-3 py-2 text-sm"
              maxLength={4000}
            />
            <button type="submit" disabled={busy || !draft.trim()} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
              Send
            </button>
          </form>
        </div>
      </Card>
      <Card title="Context sent with each question" subtitle={external ? 'This JSON leaves your computer when you ask a question.' : 'Stays on this computer (Ollama).'}>
        <pre className="max-h-[520px] overflow-auto rounded-lg bg-raised p-3 text-[11px] leading-relaxed text-ink-2">{context ? JSON.stringify(context, null, 1) : 'Loading…'}</pre>
      </Card>
    </div>
  );
}
