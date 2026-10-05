/**
 * Heart-rate variability from beat-to-beat (R-R / NN) intervals.
 *
 * Artefact filtering (per the OpenPulse spec):
 *   1. reject intervals outside 300..2000 ms;
 *   2. reject intervals deviating by more than 20 % from the median of the
 *      local 5-beat window (the beat and two neighbours each side).
 * Time-domain metrics follow the Task Force of the ESC/NASPE (1996):
 *   RMSSD = sqrt( 1/(N-1) * sum_{i=1}^{N-1} (RR_{i+1} - RR_i)^2 )
 *   SDNN  = sample standard deviation of NN intervals
 *   pNN50 = % of successive differences > 50 ms
 * Successive differences are only formed between two accepted beats that are
 * also adjacent in time, so rejected beats and data gaps never fabricate a
 * difference. ln(RMSSD) is reported because HRV is log-normally distributed
 * (Plews et al., 2012).
 */
import { mean, sd, median, weightedMean } from './stats';

export interface RrBeat {
  /** Epoch ms at which the interval ends (R peak). */
  t: number;
  rr: number;
}

export type RejectReason = 'out_of_range' | 'median_deviation';

export interface FilteredBeat extends RrBeat {
  valid: boolean;
  reason: RejectReason | null;
}

export interface FilterOptions {
  minMs?: number;
  maxMs?: number;
  /** Maximum relative deviation from the local median (0.2 = 20 %). */
  maxDeviation?: number;
  /** Local window length in beats (odd). */
  window?: number;
}

export const DEFAULT_FILTER = { minMs: 300, maxMs: 2000, maxDeviation: 0.2, window: 5 } as const;

export function filterRR(beats: readonly RrBeat[], options: FilterOptions = {}): FilteredBeat[] {
  const { minMs, maxMs, maxDeviation, window } = { ...DEFAULT_FILTER, ...options };
  const radius = Math.floor(window / 2);
  const inRange = beats.map((b) => b.rr >= minMs && b.rr <= maxMs);
  return beats.map((beat, i) => {
    if (!inRange[i]) return { ...beat, valid: false, reason: 'out_of_range' as const };
    const neighbourhood: number[] = [];
    for (let j = Math.max(0, i - radius); j <= Math.min(beats.length - 1, i + radius); j++) {
      if (inRange[j]) neighbourhood.push(beats[j]!.rr);
    }
    const localMedian = median(neighbourhood)!;
    if (Math.abs(beat.rr - localMedian) / localMedian > maxDeviation) {
      return { ...beat, valid: false, reason: 'median_deviation' as const };
    }
    return { ...beat, valid: true, reason: null };
  });
}

/**
 * Two beats are adjacent when the second interval starts where the first one
 * ended (within tolerance), i.e. no beat is missing between them.
 */
export function areAdjacent(previous: RrBeat, current: RrBeat): boolean {
  const gap = current.t - current.rr - previous.t;
  return Math.abs(gap) <= Math.max(300, 0.3 * current.rr);
}

/** Successive differences RR_{i+1} - RR_i over accepted, adjacent pairs. */
export function successiveDifferences(beats: readonly FilteredBeat[]): number[] {
  const diffs: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1]!;
    const cur = beats[i]!;
    if (prev.valid && cur.valid && areAdjacent(prev, cur)) diffs.push(cur.rr - prev.rr);
  }
  return diffs;
}

export function rmssdFromDifferences(diffs: readonly number[]): number | null {
  if (diffs.length === 0) return null;
  let acc = 0;
  for (const d of diffs) acc += d * d;
  return Math.sqrt(acc / diffs.length);
}

export function pnn50FromDifferences(diffs: readonly number[]): number | null {
  if (diffs.length === 0) return null;
  return (diffs.filter((d) => Math.abs(d) > 50).length / diffs.length) * 100;
}

export interface HrvMetrics {
  rmssd: number;
  lnRmssd: number;
  sdnn: number | null;
  pnn50: number;
  meanNn: number;
  meanHr: number;
  /** Accepted beats. */
  validBeats: number;
  /** Successive-difference pairs used for RMSSD (N - 1). */
  pairs: number;
  rejectedFraction: number;
}

export interface HrvOptions extends FilterOptions {
  /** Minimum successive pairs required to report a value. */
  minPairs?: number;
  /** Skip filtering when beats were already filtered. */
  prefiltered?: boolean;
}

export function computeHrv(beats: readonly RrBeat[] | readonly FilteredBeat[], options: HrvOptions = {}): HrvMetrics | null {
  if (beats.length === 0) return null;
  const filtered: FilteredBeat[] =
    options.prefiltered && 'valid' in beats[0]! ? (beats as FilteredBeat[]) : filterRR(beats as RrBeat[], options);
  const valid = filtered.filter((b) => b.valid).map((b) => b.rr);
  const diffs = successiveDifferences(filtered);
  if (diffs.length < (options.minPairs ?? 10)) return null;
  const rmssd = rmssdFromDifferences(diffs)!;
  const meanNn = mean(valid)!;
  return {
    rmssd,
    lnRmssd: Math.log(rmssd),
    sdnn: sd(valid),
    pnn50: pnn50FromDifferences(diffs)!,
    meanNn,
    meanHr: 60_000 / meanNn,
    validBeats: valid.length,
    pairs: diffs.length,
    rejectedFraction: 1 - valid.length / filtered.length,
  };
}

/** Beats with t in [from, to). Input must be sorted by t. */
export function sliceBeats<T extends RrBeat>(beats: readonly T[], from: number, to: number): T[] {
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid]!.t < from) lo = mid + 1;
    else hi = mid;
  }
  const out: T[] = [];
  for (let i = lo; i < beats.length && beats[i]!.t < to; i++) out.push(beats[i]!);
  return out;
}

export interface WindowHrv {
  start: number;
  end: number;
  rmssd: number;
  lnRmssd: number;
  pairs: number;
  /** Fraction of the window spent in slow-wave sleep. */
  swsFraction: number;
}

export interface OvernightHrv {
  rmssd: number;
  lnRmssd: number;
  method: 'sws_weighted' | 'full_night';
  windows: WindowHrv[];
}

export interface StageSpan {
  start: number;
  end: number;
  stage: 'awake' | 'light' | 'deep' | 'rem';
}

/**
 * Overnight HRV from rolling 5-minute windows (2.5-minute step).
 * When at least two windows are mostly slow-wave sleep, the night's value is
 * the mean of ln(RMSSD) weighted by (SWS fraction x pairs) — deep sleep gives
 * the most stable, parasympathetically dominated reading. Otherwise it is the
 * pair-weighted mean of ln(RMSSD) over all windows of the night.
 */
export function overnightHrv(
  beats: readonly FilteredBeat[],
  sleepStart: number,
  sleepEnd: number,
  stages: readonly StageSpan[],
  options: { windowMs?: number; stepMs?: number; minPairs?: number } = {},
): OvernightHrv | null {
  const windowMs = options.windowMs ?? 5 * 60_000;
  const stepMs = options.stepMs ?? windowMs / 2;
  const minPairs = options.minPairs ?? 60;
  const windows: WindowHrv[] = [];
  for (let start = sleepStart; start + windowMs <= sleepEnd; start += stepMs) {
    const end = start + windowMs;
    const slice = sliceBeats(beats, start, end);
    const metrics = computeHrv(slice, { prefiltered: true, minPairs });
    if (!metrics || metrics.rejectedFraction > 0.3) continue;
    let deepMs = 0;
    for (const span of stages) {
      if (span.stage !== 'deep') continue;
      deepMs += Math.max(0, Math.min(end, span.end) - Math.max(start, span.start));
    }
    windows.push({ start, end, rmssd: metrics.rmssd, lnRmssd: metrics.lnRmssd, pairs: metrics.pairs, swsFraction: deepMs / windowMs });
  }
  if (windows.length === 0) return null;

  const deep = windows.filter((w) => w.swsFraction >= 0.5);
  if (deep.length >= 2) {
    const ln = weightedMean(
      deep.map((w) => w.lnRmssd),
      deep.map((w) => w.swsFraction * w.pairs),
    )!;
    return { rmssd: Math.exp(ln), lnRmssd: ln, method: 'sws_weighted', windows };
  }
  const ln = weightedMean(
    windows.map((w) => w.lnRmssd),
    windows.map((w) => w.pairs),
  )!;
  return { rmssd: Math.exp(ln), lnRmssd: ln, method: 'full_night', windows };
}
