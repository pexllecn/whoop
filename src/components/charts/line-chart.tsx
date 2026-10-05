'use client';

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Legend, TableView, Tooltip, linear, niceDomain, niceTicks, useWidth, type TooltipRow } from './core';

export interface LineSeries {
  id: string;
  label: string;
  color: string;
  points: Array<{ x: number; y: number | null }>;
}

export interface Band {
  label: string;
  color: string;
  points: Array<{ x: number; lo: number; hi: number }>;
}

interface Props {
  series: LineSeries[];
  band?: Band;
  height?: number;
  yDomain?: [number, number];
  yFloor?: number;
  formatY: (v: number) => string;
  /** Axis tick labels (defaults to formatY); keep them short. */
  formatYTick?: (v: number) => string;
  formatXTick: (x: number) => string;
  formatXTooltip: (x: number) => string;
  /** Break the line when consecutive points are further apart than this. */
  gap?: number;
  ariaLabel: string;
  tableCaption?: string;
  xTicks?: number[];
}

const M = { l: 44, r: 14, t: 10, b: 26 };

/** Multi-series line chart with crosshair tooltip, keyboard support and a data table. */
export function LineChart({ series, band, height = 200, yDomain, yFloor, formatY, formatYTick, formatXTick, formatXTooltip, gap, ariaLabel, tableCaption, xTicks }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.filter((p) => p.y !== null).map((p) => p.x)))].sort((a, b) => a - b), [series]);
  const allY = series.flatMap((s) => s.points.map((p) => p.y).filter((y): y is number => y !== null)).concat(band ? band.points.flatMap((p) => [p.lo, p.hi]) : []);
  const domain = yDomain ?? niceDomain(allY, 0.08, yFloor);
  const xMin = xs[0] ?? 0;
  const xMax = xs[xs.length - 1] ?? 1;
  const x = linear([xMin, xMax === xMin ? xMin + 1 : xMax], [M.l, width - M.r]);
  const y = linear(domain, [height - M.b, M.t]);
  const yTicks = niceTicks(domain[0], domain[1], 4).filter((t) => t >= domain[0] && t <= domain[1]);
  const maxTicks = Math.max(2, Math.min(7, Math.floor((width - M.l - M.r) / 84)));
  const tickCount = Math.min(maxTicks, xs.length);
  const ticksX = (xTicks ?? (xs.length ? Array.from({ length: tickCount }, (_, i) => xs[Math.round((i * (xs.length - 1)) / Math.max(1, tickCount - 1))]!) : [])).filter(
    (t) => t >= xMin && t <= xMax,
  );
  const tickY = formatYTick ?? formatY;

  const pathFor = (points: LineSeries['points']) => {
    let d = '';
    let prev: number | null = null;
    for (const p of points) {
      if (p.y === null) {
        prev = null;
        continue;
      }
      const broken = prev === null || (gap !== undefined && p.x - prev > gap);
      d += `${broken ? 'M' : 'L'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
      prev = p.x;
    }
    return d;
  };

  const bandPath = band && band.points.length > 1
    ? `M${band.points.map((p) => `${x(p.x).toFixed(1)},${y(p.hi).toFixed(1)}`).join('L')}L${[...band.points].reverse().map((p) => `${x(p.x).toFixed(1)},${y(p.lo).toFixed(1)}`).join('L')}Z`
    : null;

  const nearestIndex = (px: number) => {
    if (!xs.length) return null;
    const target = xMin + ((px - M.l) / Math.max(1, width - M.l - M.r)) * (xMax - xMin);
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i]! - target) < Math.abs(xs[best]! - target)) best = i;
    return best;
  };

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(e.clientX - rect.left));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!xs.length) return;
    if (e.key === 'ArrowRight') setHover((h) => Math.min(xs.length - 1, (h ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? xs.length) - 1));
    else if (e.key === 'Escape') setHover(null);
  };

  const hoverX = hover !== null ? xs[hover]! : null;
  const valueAt = (s: LineSeries, at: number) => s.points.find((p) => p.x === at)?.y ?? null;
  const tooltipRows: TooltipRow[] =
    hoverX === null
      ? []
      : series.map((s) => {
          const v = valueAt(s, hoverX);
          return { label: s.label, value: v === null ? '—' : formatY(v), color: s.color };
        });
  if (hoverX !== null && band) {
    const b = band.points.find((p) => p.x === hoverX);
    if (b) tooltipRows.push({ label: band.label, value: `${formatY(b.lo)}–${formatY(b.hi)}` });
  }

  return (
    <div>
      {series.length > 1 && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      <div ref={ref} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          className="block touch-none outline-none"
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth={1} />
              <text x={M.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--color-muted)" className="tabular">
                {tickY(t)}
              </text>
            </g>
          ))}
          {ticksX.map((t, i) => {
            const px = x(t);
            const anchor = px - M.l < 24 ? 'start' : width - M.r - px < 24 ? 'end' : 'middle';
            return (
              <text key={`${t}-${i}`} x={px} y={height - 6} textAnchor={anchor} fontSize={11} fill="var(--color-muted)" className="tabular">
                {formatXTick(t)}
              </text>
            );
          })}
          {bandPath && <path d={bandPath} fill={band!.color} fillOpacity={0.12} />}
          {series.map((s) => (
            <path key={s.id} d={pathFor(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const last = [...s.points].reverse().find((p) => p.y !== null);
            return last ? <circle key={`${s.id}-end`} cx={x(last.x)} cy={y(last.y!)} r={4} fill={s.color} stroke="var(--color-card)" strokeWidth={2} /> : null;
          })}
          {hoverX !== null && (
            <g>
              <line x1={x(hoverX)} x2={x(hoverX)} y1={M.t} y2={height - M.b} stroke="var(--color-ink-2)" strokeWidth={1} />
              {series.map((s) => {
                const v = valueAt(s, hoverX);
                return v === null ? null : <circle key={s.id} cx={x(hoverX)} cy={y(v)} r={4} fill={s.color} stroke="var(--color-card)" strokeWidth={2} />;
              })}
            </g>
          )}
        </svg>
        {hoverX !== null && <Tooltip x={x(hoverX)} y={4} width={width} title={formatXTooltip(hoverX)} rows={tooltipRows} />}
      </div>
      <TableView
        caption={tableCaption ?? ariaLabel}
        columns={['Time', ...series.map((s) => s.label), ...(band ? [band.label] : [])]}
        rows={xs.map((at) => [
          formatXTooltip(at),
          ...series.map((s) => {
            const v = valueAt(s, at);
            return v === null ? '—' : formatY(v);
          }),
          ...(band ? [(() => { const b = band.points.find((p) => p.x === at); return b ? `${formatY(b.lo)}–${formatY(b.hi)}` : '—'; })()] : []),
        ])}
      />
    </div>
  );
}
