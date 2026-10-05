'use client';

import { useState, type PointerEvent } from 'react';
import { STRESS_META, fmt, fmtClock, stressLevelOf } from '@/lib/format';
import { Legend, TableView, Tooltip, linear, useWidth } from './core';

/**
 * Stress (0-3) as a ribbon of one-minute cells coloured by level. Minutes
 * without a score (asleep, moving, exercising, not worn) stay empty.
 */
export function StressRibbon({ points, from, to, timeZone, height = 34, compact = false }: { points: Array<{ t: number; score: number }>; from: number; to: number; timeZone: string; height?: number; compact?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ t: number; score: number } | null>(null);
  const x = linear([from, to], [0, width]);
  const cell = Math.max(1, (60_000 / (to - from)) * width);
  const labelEvery = Math.max(1, Math.round(((to - from) / 3_600_000) / Math.max(1, Math.floor(width / 70))));

  const ticks: number[] = [];
  for (let t = Math.ceil(from / 3_600_000) * 3_600_000; t <= to; t += 3_600_000 * labelEvery) ticks.push(t);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const t = from + (px / width) * (to - from);
    let best: { t: number; score: number } | null = null;
    for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    setHover(best && Math.abs(best.t - t) < 90_000 ? best : null);
  };

  return (
    <div>
      {!compact && <Legend shape="rect" items={(['low', 'elevated', 'high'] as const).map((l) => ({ label: `${STRESS_META[l].label} ${l === 'low' ? '0–1' : l === 'elevated' ? '1–2' : '2–3'}`, color: STRESS_META[l].color }))} />}
      <div ref={ref} className="relative">
        <svg width={width} height={height + 18} role="img" aria-label="Stress level by minute" onPointerMove={onMove} onPointerLeave={() => setHover(null)} className="block touch-none">
          <rect x={0} y={0} width={width} height={height} rx={6} fill="var(--color-raised)" />
          {points.map((p) => (
            <rect key={p.t} x={x(p.t - 60_000)} y={0} width={cell + 0.5} height={height} fill={STRESS_META[stressLevelOf(p.score)].color} opacity={0.35 + 0.65 * (p.score / 3)} />
          ))}
          {ticks.map((t) => {
            const px = x(t);
            const anchor = px < 22 ? 'start' : width - px < 22 ? 'end' : 'middle';
            return (
              <text key={t} x={px} y={height + 14} textAnchor={anchor} fontSize={11} fill="var(--color-muted)" className="tabular">
                {fmtClock(t, timeZone)}
              </text>
            );
          })}
          {hover && <line x1={x(hover.t)} x2={x(hover.t)} y1={0} y2={height} stroke="#fff" strokeWidth={1} />}
        </svg>
        {hover && (
          <Tooltip
            x={x(hover.t)}
            y={height + 4}
            width={width}
            title={fmtClock(hover.t, timeZone)}
            rows={[{ label: `stress · ${STRESS_META[stressLevelOf(hover.score)].label.toLowerCase()}`, value: fmt(hover.score, 1), color: STRESS_META[stressLevelOf(hover.score)].color }]}
          />
        )}
      </div>
      {!compact && <TableView caption="Stress by minute" columns={['Time', 'Stress (0–3)', 'Level']} rows={points.map((p) => [fmtClock(p.t, timeZone), fmt(p.score, 2), STRESS_META[stressLevelOf(p.score)].label])} />}
    </div>
  );
}
