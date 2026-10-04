/**
 * Sleep need, performance and consistency.
 *
 *   Need = Baseline need (default 7.75 h)
 *        + Strain supplement: 3.5 min per strain point above 8 on the day before
 *          the night, capped at 50 min
 *        + Sleep-debt carryover: shortfall (need - actual) of the previous three
 *          nights, decayed with weights 1/2, 1/4, 1/8
 *   Performance = actual sleep / need x 100, capped at 100
 *   Consistency = mean overlap (intersection over union) of tonight's sleep
 *          window with each of the previous four nights, on a clock-time axis
 */
import { HOUR_MS, MINUTE_MS, minuteOfDay } from '../time';

export const DEBT_WEIGHTS = [0.5, 0.25, 0.125] as const;
export const STRAIN_SUPPLEMENT_THRESHOLD = 8;
export const STRAIN_SUPPLEMENT_MIN_PER_POINT = 3.5;
export const STRAIN_SUPPLEMENT_CAP_MIN = 50;

export interface SleepNeedInput {
  baselineHours: number;
  /** Day strain of the day that precedes the night (0-21), if known. */
  priorDayStrain: number | null;
  /** Previous nights, most recent first: need and actual sleep in ms. */
  previousNights: ReadonlyArray<{ needMs: number | null; actualMs: number | null }>;
}

export interface SleepNeed {
  needMs: number;
  baselineMs: number;
  strainMs: number;
  debtMs: number;
}

export function computeSleepNeed(input: SleepNeedInput): SleepNeed {
  const baselineMs = Math.round(input.baselineHours * HOUR_MS);
  const strainMinutes =
    input.priorDayStrain === null
      ? 0
      : Math.min(STRAIN_SUPPLEMENT_CAP_MIN, Math.max(0, input.priorDayStrain - STRAIN_SUPPLEMENT_THRESHOLD) * STRAIN_SUPPLEMENT_MIN_PER_POINT);
  const strainMs = Math.round(strainMinutes * MINUTE_MS);
  let debtMs = 0;
  DEBT_WEIGHTS.forEach((weight, i) => {
    const night = input.previousNights[i];
    if (!night || night.actualMs === null) return;
    const need = night.needMs ?? baselineMs;
    debtMs += weight * Math.max(0, need - night.actualMs);
  });
  debtMs = Math.round(debtMs);
  return { needMs: baselineMs + strainMs + debtMs, baselineMs, strainMs, debtMs };
}

export function sleepPerformance(actualMs: number, needMs: number): number {
  if (needMs <= 0) return 100;
  return Math.min(100, (actualMs / needMs) * 100);
}

/** Map an instant to minutes on an axis starting at 12:00 local, so nights do not wrap. */
function noonAxisMinute(ms: number, timeZone: string): number {
  return (minuteOfDay(ms, timeZone) - 12 * 60 + 1440) % 1440;
}

export function sleepConsistency(
  tonight: { start: number; end: number },
  previous: ReadonlyArray<{ start: number; end: number }>,
  timeZone: string,
): number | null {
  if (previous.length === 0) return null;
  const toInterval = (w: { start: number; end: number }) => {
    const a = noonAxisMinute(w.start, timeZone);
    const duration = Math.min(1440, (w.end - w.start) / MINUTE_MS);
    return [a, a + duration] as const;
  };
  const [a0, a1] = toInterval(tonight);
  const scores = previous.slice(0, 4).map((w) => {
    const [b0, b1] = toInterval(w);
    const intersection = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const union = Math.max(a1, b1) - Math.min(a0, b0);
    return union > 0 ? intersection / union : 0;
  });
  return (scores.reduce((s, v) => s + v, 0) / scores.length) * 100;
}
