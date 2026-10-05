'use client';

import { fmt, fmtDayShort, fmtDuration } from '@/lib/format';
import { LineChart } from './charts/line-chart';

export function SleepTrend({ nights }: { nights: Array<{ date: string; asleepMs: number; needMs: number | null; performance: number | null }> }) {
  const x = (date: string) => Date.parse(`${date}T12:00:00Z`);
  const label = (t: number) => fmtDayShort(new Date(t).toISOString().slice(0, 10));
  return (
    <LineChart
      series={[
        { id: 'asleep', label: 'Asleep', color: 'var(--color-sleep)', points: nights.map((n) => ({ x: x(n.date), y: n.asleepMs / 3_600_000 })) },
        { id: 'need', label: 'Need', color: 'var(--color-ink-2)', points: nights.map((n) => ({ x: x(n.date), y: n.needMs === null ? null : n.needMs / 3_600_000 })) },
      ]}
      height={180}
      yFloor={0}
      formatY={(v) => fmtDuration(v * 3_600_000)}
      formatYTick={(v) => `${fmt(v, v % 1 === 0 ? 0 : 1)} h`}
      formatXTick={label}
      formatXTooltip={label}
      ariaLabel="Sleep and sleep need over the last 14 nights"
    />
  );
}
