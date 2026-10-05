'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Width of a container element, tracked with ResizeObserver. */
export function useWidth<T extends HTMLElement>(fallback = 600): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(120, Math.floor(el.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v / step) * step);
  return ticks;
}

export function niceDomain(values: number[], padFraction = 0.08, floor?: number): [number, number] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return [0, 1];
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * padFraction;
  lo -= pad;
  hi += pad;
  if (floor !== undefined) lo = Math.max(floor, lo);
  const ticks = niceTicks(lo, hi);
  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
  return [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
}

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export function Tooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: TooltipRow[] }) {
  const boxWidth = 176;
  const left = Math.min(Math.max(0, x + 12), Math.max(0, width - boxWidth));
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 rounded-lg border border-hair bg-raised px-3 py-2 text-xs shadow-xl"
      style={{ left, top: Math.max(0, y), width: boxWidth }}
    >
      <div className="mb-1 text-muted">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2 py-0.5">
          {row.color && <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: row.color }} aria-hidden="true" />}
          <span className="font-semibold text-ink tabular">{row.value}</span>
          <span className="truncate text-ink-2">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items, shape = 'line' }: { items: Array<{ label: string; color: string; value?: string }>; shape?: 'line' | 'rect' }) {
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={shape === 'line' ? 'h-0.5 w-3.5 rounded' : 'h-2.5 w-2.5 rounded-sm'}
            style={{ background: item.color }}
          />
          <span>{item.label}</span>
          {item.value && <span className="text-ink tabular">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Accessible twin of every chart: the same values as a table. */
export function TableView({ caption, columns, rows }: { caption: string; columns: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer select-none text-muted hover:text-ink-2">Data table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-hair">
        <table className="w-full text-left tabular">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-raised text-muted">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="px-3 py-1.5 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t border-hair">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1 text-ink-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
