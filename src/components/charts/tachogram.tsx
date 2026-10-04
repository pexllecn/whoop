'use client';

import { LineChart } from './line-chart';

/** Beat-to-beat R-R intervals: the raw signal behind HRV. */
export function Tachogram({ beats, timeZone, height = 180 }: { beats: Array<{ t: number; rr: number }>; timeZone: string; height?: number }) {
  const clock = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);
  return (
    <LineChart
      series={[{ id: 'rr', label: 'R-R interval', color: 'var(--color-accent)', points: beats.map((b) => ({ x: b.t, y: b.rr })) }]}
      height={height}
      formatY={(v) => `${Math.round(v)}`}
      formatXTick={clock}
      formatXTooltip={(t) => {
        const beat = beats.find((b) => b.t === t);
        return beat ? `${clock(t)} · ${Math.round(60_000 / beat.rr)} bpm` : clock(t);
      }}
      gap={4000}
      ariaLabel="R-R tachogram, milliseconds per beat"
    />
  );
}
