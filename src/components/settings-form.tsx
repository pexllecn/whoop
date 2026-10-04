'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import type { AppSettings } from '@/lib/storage/settings';
import { Card } from './ui';

type PublicSettings = AppSettings & { coach: AppSettings['coach'] & { hasOpenaiKey: boolean; hasAnthropicKey: boolean } };

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-ink-2">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

const input = 'w-full rounded-lg border border-hair bg-raised px-3 py-2 text-sm text-ink';

export function SettingsForm({ initial, protocolMapPath }: { initial: PublicSettings; protocolMapPath: string }) {
  const router = useRouter();
  const [s, setS] = useState(initial);
  const [keys, setKeys] = useState({ openai: '', anthropic: '' });
  const [state, setState] = useState<{ saving: boolean; message: string | null }>({ saving: false, message: null });
  const zones = useMemo(() => (typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [initial.timeZone]), [initial.timeZone]);
  const set = <K extends keyof PublicSettings>(key: K, value: PublicSettings[K]) => setS((prev) => ({ ...prev, [key]: value }));

  const save = async (extra: Record<string, unknown> = {}) => {
    setState({ saving: true, message: null });
    const response = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: s.profile,
        timeZone: s.timeZone,
        daemon: s.daemon,
        coach: { ...s.coach, openaiApiKey: keys.openai, anthropicApiKey: keys.anthropic, hasOpenaiKey: undefined, hasAnthropicKey: undefined },
        ...extra,
      }),
    });
    const body = (await response.json()) as PublicSettings & { error?: string };
    if (response.ok) {
      setS(body);
      setKeys({ openai: '', anthropic: '' });
      setState({ saving: false, message: 'Saved. Rescore days on the Device page to apply profile changes to past scores.' });
      router.refresh();
    } else {
      setState({ saving: false, message: body.error ?? 'Save failed' });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="grid gap-4 lg:grid-cols-2"
    >
      <Card title="Profile" subtitle="Used for heart-rate reserve, TRIMP, calories and sleep need">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Age">
            <input className={input} type="number" min={13} max={100} value={s.profile.age} onChange={(e) => set('profile', { ...s.profile, age: Number(e.target.value) })} />
          </Field>
          <Field label="Sex" hint="Selects the Banister and Keytel coefficients">
            <select className={input} value={s.profile.sex} onChange={(e) => set('profile', { ...s.profile, sex: e.target.value as 'male' | 'female' })}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </Field>
          <Field label="Weight (kg)">
            <input className={input} type="number" step="0.1" value={s.profile.weightKg} onChange={(e) => set('profile', { ...s.profile, weightKg: Number(e.target.value) })} />
          </Field>
          <Field label="Height (cm)">
            <input className={input} type="number" value={s.profile.heightCm} onChange={(e) => set('profile', { ...s.profile, heightCm: Number(e.target.value) })} />
          </Field>
          <Field label="Max heart rate" hint={`Blank = Tanaka estimate (${Math.round(208 - 0.7 * s.profile.age)} bpm)`}>
            <input
              className={input}
              type="number"
              placeholder="auto"
              value={s.profile.maxHrOverride ?? ''}
              onChange={(e) => set('profile', { ...s.profile, maxHrOverride: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </Field>
          <Field label="Baseline sleep need (h)">
            <input className={input} type="number" step="0.25" value={s.profile.baselineSleepNeedHours} onChange={(e) => set('profile', { ...s.profile, baselineSleepNeedHours: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="mt-3">
          <Field label="Time zone" hint="Calendar days and charts use this zone">
            <select className={input} value={s.timeZone} onChange={(e) => set('timeZone', e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card title="Daemon" subtitle="Applied on the daemon's next reconnect">
        <div className="grid gap-3">
          <Field label="Device id" hint="Leave blank to connect to the first strap found">
            <input className={input} value={s.daemon.deviceId ?? ''} onChange={(e) => set('daemon', { ...s.daemon, deviceId: e.target.value || null })} />
          </Field>
          <Field label="Name filter" hint="Substring of the advertised name">
            <input className={input} value={s.daemon.nameFilter ?? ''} onChange={(e) => set('daemon', { ...s.daemon, nameFilter: e.target.value || null })} />
          </Field>
          <Field label="Startup commands" hint="Comma-separated names sent after CLIENT_HELLO, e.g. toggleRealtimeHr (community-mapped, unverified)">
            <input
              className={input}
              value={s.daemon.startupCommands.join(', ')}
              onChange={(e) => set('daemon', { ...s.daemon, startupCommands: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={s.daemon.useHistoricalRr} onChange={(e) => set('daemon', { ...s.daemon, useHistoricalRr: e.target.checked })} />
            Use R-R intervals from historical (0x2F) records for HRV
          </label>
          <Field label="WebSocket port">
            <input className={input} type="number" value={s.daemon.wsPort} onChange={(e) => set('daemon', { ...s.daemon, wsPort: Number(e.target.value) })} />
          </Field>
          <p className="text-xs text-muted">Protocol map: {protocolMapPath}</p>
        </div>
      </Card>

      <Card title="AI coach" subtitle="Local by default. Cloud providers receive your daily summaries only after you allow it." className="lg:col-span-2">
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Provider">
            <select className={input} value={s.coach.provider} onChange={(e) => set('coach', { ...s.coach, provider: e.target.value as AppSettings['coach']['provider'] })}>
              <option value="ollama">Ollama (local)</option>
              <option value="openai">OpenAI (cloud)</option>
              <option value="anthropic">Anthropic (cloud)</option>
            </select>
          </Field>
          <Field label="Ollama URL" hint="Only loopback addresses are accepted">
            <input className={input} value={s.coach.ollamaUrl} onChange={(e) => set('coach', { ...s.coach, ollamaUrl: e.target.value })} />
          </Field>
          <Field label="Ollama model">
            <input className={input} value={s.coach.ollamaModel} onChange={(e) => set('coach', { ...s.coach, ollamaModel: e.target.value })} />
          </Field>
          <Field label="OpenAI model">
            <input className={input} value={s.coach.openaiModel} onChange={(e) => set('coach', { ...s.coach, openaiModel: e.target.value })} />
          </Field>
          <Field label="OpenAI API key" hint={s.coach.hasOpenaiKey ? 'A key is stored (or set via OPENAI_API_KEY)' : 'Not set'}>
            <input className={input} type="password" autoComplete="off" value={keys.openai} placeholder={s.coach.hasOpenaiKey ? '••••••••' : ''} onChange={(e) => setKeys({ ...keys, openai: e.target.value })} />
          </Field>
          <Field label="Anthropic model">
            <input className={input} value={s.coach.anthropicModel} onChange={(e) => set('coach', { ...s.coach, anthropicModel: e.target.value })} />
          </Field>
          <Field label="Anthropic API key" hint={s.coach.hasAnthropicKey ? 'A key is stored (or set via ANTHROPIC_API_KEY)' : 'Not set'}>
            <input className={input} type="password" autoComplete="off" value={keys.anthropic} placeholder={s.coach.hasAnthropicKey ? '••••••••' : ''} onChange={(e) => setKeys({ ...keys, anthropic: e.target.value })} />
          </Field>
          <label className="flex items-start gap-2 text-sm text-ink-2 md:col-span-2">
            <input type="checkbox" className="mt-1" checked={s.coach.allowExternal} onChange={(e) => set('coach', { ...s.coach, allowExternal: e.target.checked })} />
            Allow sending my biometric summaries to the selected cloud provider. Leave this off to keep everything on this computer.
          </label>
        </div>
        {(s.coach.hasOpenaiKey || s.coach.hasAnthropicKey) && (
          <button type="button" onClick={() => void save({ clearKeys: ['openai', 'anthropic'] })} className="mt-3 text-xs text-serious hover:underline">
            Remove stored API keys
          </button>
        )}
      </Card>

      <div className="flex items-center gap-3 lg:col-span-2">
        <button type="submit" disabled={state.saving} className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-40">
          {state.saving ? 'Saving…' : 'Save settings'}
        </button>
        {state.message && <span className="text-sm text-ink-2">{state.message}</span>}
      </div>
    </form>
  );
}
