/**
 * Real-time stress (0.0-3.0): autonomic arousal while the body is still.
 *
 * Every minute, using the trailing 60 seconds:
 *   - skip when motion is above the active threshold (0.05 g), because a
 *     raised HR then means movement or exercise, not stress; without motion
 *     data, skip when HR exceeds 40 % of heart-rate reserve (likely exercise)
 *   HR component  = 1.5 * clamp((HR60 - restingDayHR) / (0.15 * HRR), 0, 1)
 *   HRV component = 1.5 * clamp((mu_dayLnRMSSD - lnRMSSD60) / (1.5 * sigma), 0, 1)
 *   Stress = HR component + HRV component; with no usable R-R data, 2 x HR component.
 * restingDayHR and the day-time ln RMSSD reference are the user's own awake,
 * still baselines; before they exist, sleeping RHR + 15 bpm and overnight
 * ln RMSSD - 0.6 stand in for them.
 * Levels: 0-1 low, 1-2 elevated, 2-3 high.
 */
import { computeHrv, sliceBeats, type FilteredBeat } from './hrv';
import { clamp } from './stats';
import { heartRateReserveFraction } from './strain';

export const ACTIVE_MOTION_G = 0.05;
export const EXERCISE_HRR = 0.4;

export interface StressReference {
  restingHr: number;
  maxHr: number;
  /** Awake & still resting HR baseline. */
  dayRestHr: number;
  /** Awake & still ln RMSSD baseline (mean and SD). */
  dayLnRmssd: number;
  dayLnRmssdSd: number;
}

export interface StressPoint {
  t: number;
  score: number | null;
  hrComponent: number | null;
  hrvComponent: number | null;
  reason: 'ok' | 'moving' | 'exercise' | 'no_data';
  hr60: number | null;
  lnRmssd60: number | null;
}

export function stressLevel(score: number): 'low' | 'elevated' | 'high' {
  if (score < 1) return 'low';
  if (score < 2) return 'elevated';
  return 'high';
}

export function scoreStress(
  window: { hr60: number | null; lnRmssd60: number | null; motion60: number | null },
  reference: StressReference,
): Omit<StressPoint, 't'> {
  const { hr60, lnRmssd60, motion60 } = window;
  if (hr60 === null) return { score: null, hrComponent: null, hrvComponent: null, reason: 'no_data', hr60, lnRmssd60 };
  if (motion60 !== null && motion60 > ACTIVE_MOTION_G) return { score: null, hrComponent: null, hrvComponent: null, reason: 'moving', hr60, lnRmssd60 };
  if (motion60 === null && heartRateReserveFraction(hr60, reference.restingHr, reference.maxHr) > EXERCISE_HRR) {
    return { score: null, hrComponent: null, hrvComponent: null, reason: 'exercise', hr60, lnRmssd60 };
  }
  const reserve = Math.max(20, reference.maxHr - reference.restingHr);
  const hrComponent = 1.5 * clamp((hr60 - reference.dayRestHr) / (0.15 * reserve), 0, 1);
  if (lnRmssd60 === null) {
    return { score: clamp(2 * hrComponent, 0, 3), hrComponent, hrvComponent: null, reason: 'ok', hr60, lnRmssd60 };
  }
  const hrvComponent = 1.5 * clamp((reference.dayLnRmssd - lnRmssd60) / (1.5 * Math.max(0.1, reference.dayLnRmssdSd)), 0, 1);
  return { score: clamp(hrComponent + hrvComponent, 0, 3), hrComponent, hrvComponent, reason: 'ok', hr60, lnRmssd60 };
}

export interface StressSeries {
  hr: ReadonlyArray<{ t: number; hr: number }>;
  beats: readonly FilteredBeat[];
  motion: ReadonlyArray<{ ts: number; activity: number }>;
}

function windowMean<T>(items: readonly T[], time: (item: T) => number, value: (item: T) => number, from: number, to: number): number | null {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid]!) < from) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  let n = 0;
  for (let i = lo; i < items.length && time(items[i]!) < to; i++) {
    total += value(items[i]!);
    n++;
  }
  return n ? total / n : null;
}

/** Minute-by-minute stress over [from, to), skipping `exclude` periods (sleep). */
export function stressTimeline(
  series: StressSeries,
  from: number,
  to: number,
  reference: StressReference,
  exclude: ReadonlyArray<{ start: number; end: number }> = [],
  stepMs = 60_000,
): StressPoint[] {
  const points: StressPoint[] = [];
  for (let t = Math.ceil(from / stepMs) * stepMs; t <= to; t += stepMs) {
    if (exclude.some((p) => t > p.start && t <= p.end)) continue;
    const hr60 = windowMean(series.hr, (s) => s.t, (s) => s.hr, t - 60_000, t);
    const hrv = computeHrv(sliceBeats(series.beats, t - 60_000, t), { prefiltered: true, minPairs: 30 });
    const motion60 = windowMean(series.motion, (s) => s.ts, (s) => s.activity, t - 60_000, t);
    points.push({ t, ...scoreStress({ hr60, lnRmssd60: hrv?.lnRmssd ?? null, motion60 }, reference) });
  }
  return points;
}
