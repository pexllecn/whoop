/**
 * 30-day rolling baselines as exponentially weighted moving average (EWMA)
 * and exponentially weighted variance.
 *
 *   alpha = 2 / (N + 1), N = 30 days  (alpha ~= 0.0645)
 *   During warm-up the effective alpha is max(alpha, 1/(n+1)), i.e. a plain
 *   cumulative mean until the series is long enough for the EWMA to dominate.
 *   mean' = mean + a * (x - mean)
 *   var'  = (1 - a) * (var + a * (x - mean)^2)          (Finch, 2009)
 *
 * The reported SD is shrunk towards a population prior while n is small,
 * sd^2 = (n * var + k * prior^2) / (n + k) with k = 3, and never drops below a
 * metric-specific floor, so a few identical nights cannot produce a near-zero
 * SD and absurd z-scores.
 */

export type BaselineMetric = 'ln_rmssd' | 'resting_hr' | 'resp_rate' | 'skin_temp' | 'day_rest_hr' | 'day_ln_rmssd';

export interface BaselineState {
  mean: number;
  variance: number;
  n: number;
}

export interface Baseline {
  mean: number;
  sd: number;
  n: number;
}

export const BASELINE_WINDOW_DAYS = 30;
export const BASELINE_ALPHA = 2 / (BASELINE_WINDOW_DAYS + 1);
/** Nights needed before recovery leaves the calibration state. */
export const CALIBRATION_NIGHTS = 4;
const PRIOR_WEIGHT = 3;

/** Population-level prior SDs and hard floors for each metric. */
export const METRIC_SD: Record<BaselineMetric, { prior: number; floor: number }> = {
  ln_rmssd: { prior: 0.15, floor: 0.05 },
  resting_hr: { prior: 2.5, floor: 1.0 },
  resp_rate: { prior: 0.6, floor: 0.25 },
  skin_temp: { prior: 0.3, floor: 0.1 },
  day_rest_hr: { prior: 4, floor: 1.5 },
  day_ln_rmssd: { prior: 0.3, floor: 0.08 },
};

export function updateBaseline(state: BaselineState | null, x: number, alpha = BASELINE_ALPHA): BaselineState {
  if (!Number.isFinite(x)) return state ?? { mean: NaN, variance: 0, n: 0 };
  if (!state || state.n === 0 || !Number.isFinite(state.mean)) return { mean: x, variance: 0, n: 1 };
  const a = Math.max(alpha, 1 / (state.n + 1));
  const diff = x - state.mean;
  const increment = a * diff;
  return {
    mean: state.mean + increment,
    variance: (1 - a) * (state.variance + diff * increment),
    n: state.n + 1,
  };
}

export function toBaseline(metric: BaselineMetric, state: BaselineState | null): Baseline | null {
  if (!state || state.n === 0 || !Number.isFinite(state.mean)) return null;
  const { prior, floor } = METRIC_SD[metric];
  const shrunk = Math.sqrt((state.n * state.variance + PRIOR_WEIGHT * prior * prior) / (state.n + PRIOR_WEIGHT));
  return { mean: state.mean, sd: Math.max(floor, shrunk), n: state.n };
}

/** Recover an EW state from a stored baseline row (sd was stored after shrinkage). */
export function stateFromStored(metric: BaselineMetric, row: { mean: number; sd: number; n: number }): BaselineState {
  const { prior } = METRIC_SD[metric];
  const variance = Math.max(0, (row.sd * row.sd * (row.n + PRIOR_WEIGHT) - PRIOR_WEIGHT * prior * prior) / Math.max(1, row.n));
  return { mean: row.mean, variance, n: row.n };
}

export function zScore(value: number, baseline: Baseline): number {
  return (value - baseline.mean) / baseline.sd;
}
