'use client';

import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Circular meter. The unfilled track is a dim step of the same colour so the
 * state reads across the whole ring; the number in the centre is the value.
 */
export function RingGauge({
  fraction,
  color,
  label,
  value,
  unit,
  caption,
  size = 168,
  ariaLabel,
}: {
  fraction: number | null;
  color: string;
  label: string;
  value: string;
  unit?: string;
  caption?: ReactNode;
  size?: number;
  ariaLabel: string;
}) {
  const reduce = useReducedMotion();
  const stroke = 12;
  const r = (size - stroke) / 2 - 2;
  const c = size / 2;
  const f = fraction === null ? 0 : Math.max(0, Math.min(1, fraction));
  return (
    <figure className="flex flex-col items-center" aria-label={ariaLabel} role="img">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={c} cy={c} r={r} fill="none" stroke={color} strokeOpacity={0.16} strokeWidth={stroke} />
        {fraction !== null && (
          <motion.circle
            cx={c}
            cy={c}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            transform={`rotate(-90 ${c} ${c})`}
            initial={{ pathLength: reduce ? f : 0 }}
            animate={{ pathLength: f }}
            transition={{ duration: reduce ? 0 : 1.1, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        <text x={c} y={c - 4} textAnchor="middle" dominantBaseline="middle" fill="#fff" fontSize={size * 0.24} fontWeight={600}>
          {value}
          {unit && (
            <tspan fontSize={size * 0.11} fill="#c3c2b7" dx={2}>
              {unit}
            </tspan>
          )}
        </text>
        <text x={c} y={c + size * 0.17} textAnchor="middle" fill="#898781" fontSize={12} letterSpacing={0.4}>
          {label.toUpperCase()}
        </text>
      </svg>
      {caption && <figcaption className="mt-2 text-center text-xs text-ink-2">{caption}</figcaption>}
    </figure>
  );
}
