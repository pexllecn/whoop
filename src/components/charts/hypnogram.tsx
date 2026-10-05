'use client';

import { useState, type PointerEvent } from 'react';
import { STAGE_META, fmtClock, fmtDuration } from '@/lib/format';
import { Legend, TableView, Tooltip, linear, useWidth } from './core';

type Stage = keyof typeof STAGE_META;
const ROWS: Stage[] = ['awake', 'rem', 'light', 'deep'];
const M = { l: 70, r: 12, t: 8, b: 26 };
const EPOCH = 30_000;

/**
 * Stage over time. Stage is encoded twice, by row (position) and by colour,
 * so the chart stays readable without colour.
 */
export function Hypnogram({ epochs, timeZone, height = 190 }: { epochs: Array<{ t: number; stage: Stage | null }>; timeZone: string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  if (epochs.length === 0) return null;
  const start = epochs[0]!.t;
  const end = epochs[epochs.length - 1]!.t + EPOCH;
  const x = linear([start, end], [M.l, width - M.r]);
  const rowH = (height - M.t - M.b) / ROWS.length;
  const rowY = (s: Stage) => M.t + ROWS.indexOf(s) * rowH + rowH / 2;

  const runs: Array<{ stage: Stage | null; start: number; end: number }> = [];
  for (const e of epochs) {
    const last = runs[runs.length - 1];
    if (last && last.stage === e.stage && last.end === e.t) last.end = e.t + EPOCH;
    else runs.push({ stage: e.stage, start: e.t, end: e.t + EPOCH });
  }
  const totals = Object.fromEntries(ROWS.map((s) => [s, runs.filter((r) => r.stage === s).reduce((sum, r) => sum + r.end - r.start, 0)])) as Record<Stage, number>;

  let step = '';
  for (const r of runs) {
    if (!r.stage) continue;
    step += `${step ? 'L' : 'M'}${x(r.start).toFixed(1)},${rowY(r.stage).toFixed(1)}L${x(r.end).toFixed(1)},${rowY(r.stage).toFixed(1)}`;
  }

  const hours: number[] = [];
  for (let t = Math.ceil(start / 3_600_000) * 3_600_000; t <= end; t += 3_600_000) hours.push(t);
  const every = Math.max(1, Math.ceil(hours.length / Math.max(1, Math.floor((width - M.l) / 60))));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const t = start + ((px - M.l) / Math.max(1, width - M.l - M.r)) * (end - start);
    const index = Math.floor((t - start) / EPOCH);
    setHover(index >= 0 && index < epochs.length ? index : null);
  };
  const hovered = hover !== null ? epochs[hover]! : null;

  return (
    <div>
      <Legend shape="rect" items={ROWS.map((s) => ({ label: STAGE_META[s].label, color: STAGE_META[s].color, value: fmtDuration(totals[s]) }))} />
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label="Hypnogram: sleep stage across the night" onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
          {ROWS.map((s) => (
            <g key={s}>
              <line x1={M.l} x2={width - M.r} y1={rowY(s)} y2={rowY(s)} stroke="var(--color-grid)" strokeWidth={1} />
              <text x={M.l - 10} y={rowY(s)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--color-ink-2)">
                {STAGE_META[s].label.replace(' (SWS)', '')}
              </text>
            </g>
          ))}
          <path d={step} fill="none" stroke="var(--color-axis)" strokeWidth={1.5} />
          {runs.map((r, i) =>
            r.stage ? (
              <rect key={i} x={x(r.start)} y={rowY(r.stage) - 5} width={Math.max(1.5, x(r.end) - x(r.start) - 1)} height={10} rx={3} fill={STAGE_META[r.stage].color} />
            ) : null,
          )}
          {hours.map((t, i) =>
            i % every === 0 ? (
              <text key={t} x={x(t)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--color-muted)" className="tabular">
                {fmtClock(t, timeZone)}
              </text>
            ) : null,
          )}
          {hovered && <line x1={x(hovered.t + EPOCH / 2)} x2={x(hovered.t + EPOCH / 2)} y1={M.t} y2={height - M.b} stroke="var(--color-ink-2)" strokeWidth={1} />}
        </svg>
        {hovered && (
          <Tooltip
            x={x(hovered.t)}
            y={4}
            width={width}
            title={fmtClock(hovered.t, timeZone)}
            rows={[{ label: 'stage', value: hovered.stage ? STAGE_META[hovered.stage].label : 'no data', color: hovered.stage ? STAGE_META[hovered.stage].color : undefined }]}
          />
        )}
      </div>
      <TableView
        caption="Sleep stages by period"
        columns={['From', 'To', 'Stage', 'Duration']}
        rows={runs.map((r) => [fmtClock(r.start, timeZone), fmtClock(r.end, timeZone), r.stage ? STAGE_META[r.stage].label : 'no data', fmtDuration(r.end - r.start)])}
      />
    </div>
  );
}
