/** Small numeric helpers shared by the scoring engine. Inputs are never mutated. */

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? sum(values) / values.length : null;
}

/** Sample variance (n - 1 denominator). */
export function variance(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = sum(values) / values.length;
  let acc = 0;
  for (const v of values) acc += (v - m) * (v - m);
  return acc / (values.length - 1);
}

export function sd(values: readonly number[]): number | null {
  const v = variance(values);
  return v === null ? null : Math.sqrt(v);
}

/** Linear-interpolated quantile, q in [0, 1]. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Weighted mean; returns null when the total weight is zero. */
export function weightedMean(values: readonly number[], weights: readonly number[]): number | null {
  let num = 0;
  let den = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i] ?? 0;
    num += values[i]! * w;
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Trailing/centred moving average over `radius` neighbours each side. */
export function movingAverage(values: readonly (number | null)[], radius: number): (number | null)[] {
  return values.map((_, i) => {
    let total = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      const v = values[j];
      if (v !== null && v !== undefined) {
        total += v;
        n++;
      }
    }
    return n ? total / n : null;
  });
}

export function round(value: number | null | undefined, digits = 0): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
