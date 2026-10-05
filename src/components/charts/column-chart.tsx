'use client';

import { useState } from 'react';
import { Legend, TableView, Tooltip, linear, niceTicks, useWidth } from './core';

export interface Column {
  key: string;
  label: string;
  value: number | null;
  color: string;
  /** Extra tooltip lines, e.g. the band name. */
  detail?: string;
}

interface Props {
  columns: Column[];
  max: number;
  formatY: (v: number) => string;
  height?: number;
  ariaLabel: string;
  legend?: Array<{ label: string; color: string }>;
  valueLabel: string;
}

const M = { l: 42, r: 8, t: 10, b: 24 };

/** Daily columns: <= 24 px wide, 4 px rounded tops, square at the baseline, one tooltip per column. */
export function ColumnChart({ columns, max, formatY, height = 180, ariaLabel, legend, valueLabel }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const band = (width - M.l - M.r) / Math.max(1, columns.length);
  const barWidth = Math.max(2, Math.min(24, band - 2));
  const y = linear([0, max], [height - M.b, M.t]);
  const ticks = niceTicks(0, max, 4).filter((t) => t <= max);
  const labelEvery = Math.max(1, Math.ceil(columns.length / Math.max(1, Math.floor((width - M.l) / 48))));

  const bar = (i: number, value: number) => {
    const cx = M.l + band * i + band / 2;
    const top = y(value);
    const bottom = y(0);
    const h = Math.max(0, bottom - top);
    const r = Math.min(4, h, barWidth / 2);
    const x0 = cx - barWidth / 2;
    const x1 = cx + barWidth / 2;
    return `M${x0},${bottom}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${bottom}Z`;
  };

  return (
    <div>
      {legend && <Legend items={legend} shape="rect" />}
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} stroke="var(--color-grid)" strokeWidth={1} />
              <text x={M.l - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="var(--color-muted)" className="tabular">
                {formatY(t)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => (
            <g key={c.key}>
              {c.value !== null && c.value > 0 && <path d={bar(i, Math.min(max, c.value))} fill={c.color} opacity={hover === null || hover === i ? 1 : 0.55} />}
              {i % labelEvery === 0 && (
                <text x={M.l + band * i + band / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
                  {c.label}
                </text>
              )}
              <rect
                x={M.l + band * i}
                y={M.t}
                width={band}
                height={height - M.t - M.b}
                fill="transparent"
                tabIndex={0}
                role="presentation"
                aria-label={`${c.label}: ${c.value === null ? 'no data' : formatY(c.value)}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              />
            </g>
          ))}
        </svg>
        {hover !== null && (
          <Tooltip
            x={M.l + band * hover + band / 2}
            y={4}
            width={width}
            title={columns[hover]!.label}
            rows={[
              { label: valueLabel, value: columns[hover]!.value === null ? 'no data' : formatY(columns[hover]!.value!), color: columns[hover]!.color },
              ...(columns[hover]!.detail ? [{ label: columns[hover]!.detail!, value: '' }] : []),
            ]}
          />
        )}
      </div>
      <TableView caption={ariaLabel} columns={['Day', valueLabel]} rows={columns.map((c) => [c.label, c.value === null ? '—' : `${formatY(c.value)}${c.detail ? ` · ${c.detail}` : ''}`])} />
    </div>
  );
}
