'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { liveStore, useLive } from './live/live-store';
import { BluetoothButton, LinkBadge, useLiveConnection } from './live/live-view';
import { Badge, Card } from './ui';
import type { StressReference } from '@/lib/physiology/stressMonitor';

export function DeviceLivePanel({ port, timeZone, reference }: { port: number; timeZone: string; reference: StressReference }) {
  useLiveConnection(port);
  const live = useLive();
  const [busy, setBusy] = useState<string | null>(null);
  const clock = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);
  const commands = live.status?.commands ?? [];
  const connected = live.status?.state === 'streaming';

  const run = async (name: string) => {
    setBusy(name);
    await liveStore.sendCommand(name);
    setBusy(null);
  };

  return (
    <div className="grid gap-4">
      <Card title="Strap link" actions={<div className="flex items-center gap-2"><LinkBadge /><BluetoothButton reference={reference} /></div>}>
        <p className="text-sm text-ink-2">
          {live.link === 'daemon'
            ? `Daemon state: ${live.status?.state ?? 'unknown'}${live.status?.error ? ` — ${live.status.error}` : ''}`
            : live.link === 'web-bluetooth'
              ? 'Connected from this browser. Raw packets are forwarded to the local database before decoding.'
              : 'Start the daemon (`npm run daemon`) or connect from this browser with Web Bluetooth.'}
        </p>
        {live.link === 'daemon' && (
          <button type="button" onClick={() => liveStore.reconnectStrap()} className="mt-3 rounded-lg border border-hair px-3 py-1.5 text-sm text-ink-2 hover:bg-raised">
            Reconnect strap
          </button>
        )}
      </Card>

      <Card title="Commands" subtitle="Written to the command characteristic as AA01 frames with CRC16 header and CRC32 payload checksums">
        {commands.length === 0 ? (
          <p className="text-sm text-muted">Commands appear once a link is up.</p>
        ) : (
          <ul className="divide-y divide-hair">
            {commands.map((c) => (
              <li key={c.name} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="text-sm">{c.label}</div>
                  <div className="mt-0.5 flex gap-1.5">
                    <Badge tone={c.provenance === 'spec' ? 'good' : c.provenance === 'user' ? 'accent' : 'neutral'}>{c.provenance}</Badge>
                    {c.verified ? <Badge tone="good">test-vector verified</Badge> : <Badge tone="warn">unverified on hardware</Badge>}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!connected || busy !== null}
                  onClick={() => void run(c.name)}
                  className="rounded-lg border border-hair px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40"
                >
                  {busy === c.name ? 'Sending…' : 'Send'}
                </button>
              </li>
            ))}
          </ul>
        )}
        {live.lastCommand && (
          <p className="mt-3 break-all text-xs text-ink-2 tabular">
            {live.lastCommand.name}: {live.lastCommand.ok ? `seq ${live.lastCommand.sequence}, ack ${live.lastCommand.ack}, frame ${live.lastCommand.hex}` : live.lastCommand.error}
          </p>
        )}
      </Card>

      <Card title="Live packet log" subtitle="Every notification, as received (first 48 bytes), with its decode status">
        {live.packets.length === 0 ? (
          <p className="text-sm text-muted">No packets yet.</p>
        ) : (
          <div className="max-h-80 overflow-auto rounded-lg border border-hair">
            <table className="w-full text-left text-xs tabular">
              <thead className="sticky top-0 bg-raised text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Char</th>
                  <th className="px-2 py-1.5 font-medium">Status</th>
                  <th className="px-2 py-1.5 font-medium">Bytes</th>
                </tr>
              </thead>
              <tbody>
                {live.packets.map((p) => (
                  <tr key={`${p.id}-${p.t}`} className="border-t border-hair">
                    <td className="px-2 py-1 text-ink-2">{clock(p.t)}</td>
                    <td className="px-2 py-1 text-ink-2">{p.uuid.slice(4, 8)}</td>
                    <td className="px-2 py-1">{p.status}</td>
                    <td className="max-w-[28rem] truncate px-2 py-1 font-mono text-ink-2" title={p.hex}>
                      {p.hex}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {live.log.length > 0 && (
        <Card title="Daemon log">
          <ul className="max-h-48 space-y-1 overflow-auto text-xs">
            {live.log.map((l, i) => (
              <li key={i} className={l.level === 'error' ? 'text-bad' : l.level === 'warn' ? 'text-warn' : 'text-ink-2'}>
                {clock(l.t)} {l.message}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export function MaintenanceActions({ stale }: { stale: number }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const post = async (url: string, body: object, describe: (r: Record<string, unknown>) => string) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = (await response.json()) as Record<string, unknown>;
      setMessage(response.ok ? describe(result) : String(result.error ?? 'Failed'));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void post('/api/replay', { all: false }, (r) => `Replayed ${r.packets} packets, rescored ${r.daysRescored} days.`)} className="rounded-lg border border-hair px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40">
          Replay {stale > 0 ? `${stale} stale` : 'stale'} packets
        </button>
        <button type="button" disabled={busy} onClick={() => void post('/api/replay', { all: true }, (r) => `Replayed ${r.packets} packets, rescored ${r.daysRescored} days.`)} className="rounded-lg border border-hair px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40">
          Replay all raw packets
        </button>
        <button type="button" disabled={busy} onClick={() => void post('/api/recompute', { days: 30 }, (r) => `Rescored ${r.scored} of ${r.days} days.`)} className="rounded-lg border border-hair px-3 py-1.5 text-sm hover:bg-raised disabled:opacity-40">
          Rescore last 30 days
        </button>
      </div>
      {busy && <p className="mt-2 text-xs text-muted">Working…</p>}
      {message && <p className="mt-2 text-xs text-ink-2">{message}</p>}
    </div>
  );
}
