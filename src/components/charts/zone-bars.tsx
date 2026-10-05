'use client';

import { ZONE_COLORS, fmtDuration } from '@/lib/format';
import { TableView } from './core';

const ZONE_LABELS = ['Zone 0 · < 50% HRR', 'Zone 1 · 50–60%', 'Zone 2 · 60–70%', 'Zone 3 · 70–80%', 'Zone 4 · 80–90%', 'Zone 5 · 90–100%'];

/** Time per heart-rate-reserve zone (one ordinal blue ramp, value at the bar end). */
export function ZoneBars({ zoneMs }: { zoneMs: Array<number | null> }) {
  const values = zoneMs.map((v) => v ?? 0);
  const max = Math.max(...values, 1);
  return (
    <div>
      <ul className="space-y-1.5">
        {values.map((v, i) => (
          <li key={i} className="grid grid-cols-[8.5rem_1fr_4rem] items-center gap-3 text-xs">
            <span className="text-ink-2">{ZONE_LABELS[i]}</span>
            <span className="h-3 rounded-r bg-raised">
              <span className="block h-3 rounded-r" style={{ width: `${(v / max) * 100}%`, background: ZONE_COLORS[i] }} />
            </span>
            <span className="text-right text-ink tabular">{fmtDuration(v)}</span>
          </li>
        ))}
      </ul>
      <TableView caption="Time in heart-rate zones" columns={['Zone', 'Time']} rows={values.map((v, i) => [ZONE_LABELS[i], fmtDuration(v)])} />
    </div>
  );
}
