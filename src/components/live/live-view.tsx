'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { LineChart } from '@/components/charts/line-chart';
import { StressRibbon } from '@/components/charts/stress-ribbon';
import { Tachogram } from '@/components/charts/tachogram';
import { Badge, Card, KeyValue } from '@/components/ui';
import { isWebBluetoothAvailable } from '@/lib/ble/webBluetoothTransport';
import { STRESS_META, fmt, fmtRelative, stressLevelOf } from '@/lib/format';
import type { StressReference } from '@/lib/physiology/stressMonitor';
import { liveStore, useLive } from './live-store';

export function LinkBadge() {
  const live = useLive();
  if (live.link === 'daemon') return <Badge tone="good">● Daemon {live.status?.transport === 'simulator' ? '(simulator)' : ''}</Badge>;
  if (live.link === 'web-bluetooth') return <Badge tone="accent">● Web Bluetooth</Badge>;
  if (live.link === 'connecting') return <Badge tone="warn">Connecting…</Badge>;
  return <Badge tone="bad">○ Not connected</Badge>;
}

export function useLiveConnection(port: number) {
  useEffect(() => {
    liveStore.connectDaemon(port);
  }, [port]);
}

export function BluetoothButton({ reference }: { reference: StressReference }) {
  const live = useLive();
  const supported = useSyncExternalStore(
    () => () => undefined,
    isWebBluetoothAvailable,
    () => false,
  );
  if (live.link === 'daemon') return null;
  if (live.link === 'web-bluetooth') {
    return (
      <button type="button" onClick={() => void liveStore.disconnectBluetooth()} className="rounded-lg border border-hair px-3 py-1.5 text-sm text-ink-2 hover:bg-card">
        Disconnect strap
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={!supported}
      title={supported ? 'Pair directly from this browser' : 'Web Bluetooth needs Chrome or Edge on desktop or Android'}
      onClick={() => void liveStore.connectBluetooth(reference)}
      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
    >
      Connect via Web Bluetooth
    </button>
  );
}

export function LiveView({ port, timeZone }: { port: number; timeZone: string }) {
  useLiveConnection(port);
  const live = useLive();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const current = live.hr[live.hr.length - 1] ?? null;
  const stale = !current || now - current.t > 10_000;
  const latestStress = [...live.stress].reverse().find((s) => s.score !== null) ?? null;
  const lastWindow = live.stress[live.stress.length - 1] ?? null;
  const hr5 = live.hr.filter((p) => p.t > now - 5 * 60_000);
  const beats2 = live.beats.filter((b) => b.t > now - 2 * 60_000);
  const stressMinutes = useMemo(() => {
    const byMinute = new Map<number, number[]>();
    for (const s of live.stress) {
      if (s.score === null) continue;
      const minute = Math.ceil(s.t / 60_000) * 60_000;
      byMinute.set(minute, [...(byMinute.get(minute) ?? []), s.score]);
    }
    return [...byMinute.entries()].map(([t, v]) => ({ t, score: v.reduce((a, b) => a + b, 0) / v.length }));
  }, [live.stress]);
  const status = live.status;
  const clock = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);

  return (
    <div className="grid gap-4">
      {live.linkError && live.link === 'disconnected' && (
        <div className="rounded-xl border border-hair bg-card px-4 py-3 text-sm text-ink-2">{live.linkError}</div>
      )}
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr_1fr]">
        <Card>
          <div className="text-xs text-muted">Heart rate</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className={`text-6xl font-semibold tracking-tight ${stale ? 'text-muted' : ''}`} aria-live="polite">
              {current ? current.bpm : '—'}
            </span>
            <span className="text-lg text-ink-2">bpm</span>
          </div>
          <div className="mt-1 text-xs text-muted">{current ? `updated ${fmtRelative(current.t, now)}` : 'waiting for data'}</div>
        </Card>
        <Card>
          <div className="text-xs text-muted">HRV, last 60 s (RMSSD)</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">{fmt(lastWindow?.rmssd60, 0)}</span>
            <span className="text-ink-2">ms</span>
          </div>
          <div className="mt-1 text-xs text-muted">{beats2.length} beats in the last 2 min</div>
        </Card>
        <Card>
          <div className="text-xs text-muted">Stress now (0–3)</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight">{latestStress ? fmt(latestStress.score, 1) : '—'}</span>
            {latestStress?.score != null && (
              <span className="text-sm" style={{ color: STRESS_META[stressLevelOf(latestStress.score)].color }}>
                {STRESS_META[stressLevelOf(latestStress.score)].label}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted">
            {!lastWindow
              ? 'waiting for 60 s of data'
              : lastWindow.score === null
                ? lastWindow.reason === 'moving'
                  ? 'paused while moving'
                  : lastWindow.reason === 'exercise'
                    ? 'paused: likely exercise'
                    : 'not enough R-R data'
                : 'scored while still'}
          </div>
        </Card>
      </div>

      <Card title="Heart rate, last 5 minutes" subtitle="1 Hz">
        {hr5.length > 1 ? (
          <LineChart
            series={[{ id: 'hr', label: 'Heart rate', color: 'var(--color-hr)', points: hr5.map((p) => ({ x: p.t, y: p.bpm })) }]}
            height={200}
            gap={5000}
            formatY={(v) => `${Math.round(v)}`}
            formatXTick={clock}
            formatXTooltip={(t) => `${clock(t)} · bpm`}
            ariaLabel="Live heart rate"
          />
        ) : (
          <p className="text-sm text-muted">No live heart rate yet.</p>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="R-R tachogram" subtitle="Beat-to-beat intervals, last 2 minutes (ms)">
          {beats2.length > 2 ? <Tachogram beats={beats2} timeZone={timeZone} /> : <p className="text-sm text-muted">No R-R intervals yet. They arrive with 0x2A37 notifications.</p>}
        </Card>
        <Card title="Stress ribbon" subtitle="Last 60 minutes">
          {stressMinutes.length ? <StressRibbon points={stressMinutes} from={now - 60 * 60_000} to={now} timeZone={timeZone} /> : <p className="text-sm text-muted">Stress needs a minute of still data with R-R intervals.</p>}
        </Card>
      </div>

      <Card title="Connection" actions={<LinkBadge />}>
        <KeyValue
          items={[
            ['State', status?.state ?? '—'],
            ['Device', status?.device?.name ?? status?.device?.id ?? '—'],
            ['Model / firmware', status?.device ? `${status.device.model ?? '—'} / ${status.device.firmware ?? '—'}` : '—'],
            ['Battery', live.battery !== null ? `${live.battery}%` : '—'],
            ['Bond check', status?.bond ?? '—'],
            ['Hello ack', status?.helloAck ?? '—'],
            ['Packets (session)', status ? fmt(status.packetsThisSession) : '—'],
            ['Last packet', fmtRelative(status?.lastPacketAt ?? null, now)],
            ['Service', status?.device?.serviceVariant ?? '—'],
          ]}
        />
        {status?.error && <p className="mt-3 text-xs text-serious">{status.error}</p>}
      </Card>
    </div>
  );
}
