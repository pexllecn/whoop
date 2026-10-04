/**
 * Workout detection from heart rate: sustained effort at or above 40 % of
 * heart-rate reserve (ACSM "moderate" lower bound) for at least 8 minutes,
 * on a 60-second moving average, tolerating dips of up to 2 minutes.
 * Detected workouts are labelled by intensity, never by a guessed sport.
 */
import { energyKcal, type EnergyProfile } from './energy';
import { computeLoad, heartRateReserveFraction, strainFromLoad, type StrainParams } from './strain';

export interface DetectedWorkout {
  start: number;
  end: number;
  label: string;
  intensity: 'moderate' | 'vigorous';
  strain: number;
  trimp: number;
  edwards: number;
  avgHr: number | null;
  maxHr: number | null;
  kcal: number;
  zoneMs: [number, number, number, number, number, number];
  meanMotion: number | null;
}

export interface WorkoutDetectionOptions {
  minHrr?: number;
  minDurationMs?: number;
  maxDipMs?: number;
}

export function detectWorkouts(
  hr: ReadonlyArray<{ t: number; hr: number }>,
  motion: ReadonlyArray<{ ts: number; activity: number }>,
  params: StrainParams,
  profile: EnergyProfile,
  exclude: ReadonlyArray<{ start: number; end: number }> = [],
  options: WorkoutDetectionOptions = {},
): DetectedWorkout[] {
  const minHrr = options.minHrr ?? 0.4;
  const minDurationMs = options.minDurationMs ?? 8 * 60_000;
  const maxDipMs = options.maxDipMs ?? 2 * 60_000;
  if (hr.length === 0) return [];

  // 60 s trailing moving average via two pointers.
  const smoothed: number[] = new Array(hr.length);
  let lo = 0;
  let total = 0;
  for (let i = 0; i < hr.length; i++) {
    total += hr[i]!.hr;
    while (hr[i]!.t - hr[lo]!.t > 60_000) total -= hr[lo++]!.hr;
    smoothed[i] = total / (i - lo + 1);
  }

  const active = smoothed.map((v, i) => {
    const t = hr[i]!.t;
    if (exclude.some((p) => t >= p.start && t < p.end)) return false;
    return heartRateReserveFraction(v, params.restingHr, params.maxHr) >= minHrr;
  });

  const segments: Array<{ start: number; end: number }> = [];
  let segStart: number | null = null;
  let lastActive = 0;
  for (let i = 0; i < hr.length; i++) {
    const t = hr[i]!.t;
    if (active[i]) {
      if (segStart === null) segStart = t;
      else if (t - lastActive > maxDipMs) {
        segments.push({ start: segStart, end: lastActive });
        segStart = t;
      }
      lastActive = t;
    }
  }
  if (segStart !== null) segments.push({ start: segStart, end: lastActive });

  return segments
    .filter((s) => s.end - s.start >= minDurationMs)
    .map((s) => {
      const samples = hr.filter((x) => x.t >= s.start && x.t <= s.end);
      const load = computeLoad(samples, params);
      const motionValues = motion.filter((m) => m.ts >= s.start && m.ts <= s.end).map((m) => m.activity);
      const avgHrr = load.avgHr === null ? 0 : heartRateReserveFraction(load.avgHr, params.restingHr, params.maxHr);
      const intensity: 'moderate' | 'vigorous' = avgHrr >= 0.6 ? 'vigorous' : 'moderate';
      const activeThreshold = params.restingHr + 0.3 * (params.maxHr - params.restingHr);
      return {
        start: s.start,
        end: s.end,
        label: intensity === 'vigorous' ? 'Vigorous activity' : 'Moderate activity',
        intensity,
        strain: strainFromLoad(load.load),
        trimp: load.trimp,
        edwards: load.edwards,
        avgHr: load.avgHr,
        maxHr: load.maxHr,
        kcal: energyKcal(samples, s.end - s.start, profile, activeThreshold),
        zoneMs: load.zoneMs,
        meanMotion: motionValues.length ? motionValues.reduce((a, b) => a + b, 0) / motionValues.length : null,
      };
    });
}
