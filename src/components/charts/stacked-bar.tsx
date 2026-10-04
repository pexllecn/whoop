'use client';

import { useState } from 'react';
import { Legend, TableView, Tooltip, useWidth } from './core';

export interface Segment {
  label: string;
  value: number;
  color: string;
  display: string;
}

/** One horizontal part-to-whole bar; segments separated by a 2 px surface gap. */
export function StackedBar({ segments, ariaLabel, height = 18, total }: { segments: Segment[]; ariaLabel: string; height?: number; total?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const sum = total ?? segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  if (sum <= 0) return null;
  const visible = segments.filter((s) => s.value > 0);
  const gaps = Math.max(0, visible.length - 1) * 2;
  const rects: Array<{ x: number; w: number }> = [];
  for (let i = 0, cursor = 0; i < segments.length; i++) {
    const w = segments[i]!.value > 0 ? (segments[i]!.value / sum) * (width - gaps) : 0;
    rects.push({ x: cursor, w });
    if (w > 0) cursor += w + 2;
  }
  return (
    <div>
      <Legend shape="rect" items={segments.map((s) => ({ label: s.label, color: s.color, value: s.display }))} />
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
          {segments.map((s, i) =>
            rects[i]!.w > 0 ? (
              <rect
                key={s.label}
                x={rects[i]!.x}
                y={0}
                width={rects[i]!.w}
                height={height}
                rx={4}
                fill={s.color}
                opacity={hover === null || hover === i ? 1 : 0.55}
                tabIndex={0}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                className="outline-none"
              />
            ) : null,
          )}
        </svg>
        {hover !== null && (
          <Tooltip
            x={rects[hover]!.x + rects[hover]!.w / 2}
            y={height + 6}
            width={width}
            title={segments[hover]!.label}
            rows={[{ label: `${Math.round((segments[hover]!.value / sum) * 100)}% of total`, value: segments[hover]!.display, color: segments[hover]!.color }]}
          />
        )}
      </div>
      <TableView caption={ariaLabel} columns={['Part', 'Value', 'Share']} rows={segments.map((s) => [s.label, s.display, `${Math.round((s.value / sum) * 100)}%`])} />
    </div>
  );
}
