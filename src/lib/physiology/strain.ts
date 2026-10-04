/**
 * OpenPulse Strain (0-21, logarithmic), an estimate of cardiovascular load.
 * It is calibrated to reference days, not to WHOOP's proprietary Strain.
 *
 *   %HRR  = (HR - RHR) / (HRmax - RHR)                       (Karvonen, 1957)
 *   TRIMP = sum dt_min * %HRR * 0.64 e^(1.92 %HRR)   (men)
 *               dt_min * %HRR * 0.86 e^(1.67 %HRR)   (women) (Banister, 1991)
 *   Edwards load = sum minutes in zone x zone weight          (Edwards, 1993)
 *     zone 1: 50-60 % HRR (x1) ... zone 5: 90-100 % HRR (x5)
 *   L      = sum dt_min * max(0, w(%HRR) - w(0.30)) for %HRR >= 0.30, where w is
 *            the Banister weighting above: TRIMP in excess of the lower bound of
 *            "light" intensity, 30 % HRR (ACSM; Garber et al., 2011). Sedentary
 *            minutes contribute nothing and easy walking very little, which is
 *            what lets one log curve span rest days, workouts and endurance days.
 *   Strain = min(21, k * ln(1 + alpha * L))
 *
 * k and alpha were fitted (least squares in strain units) to three simulated
 * reference days produced by src/lib/simulation (scripts/calibrate-strain.ts):
 * a rest day with ~50 min of light activity (~4.0), a day with a 45-minute
 * moderate workout at ~65 % HRR (11-13) and a day with a 2.5-3 h endurance
 * session at ~80 % HRR (18-20.5). tests/physiology/strain.test.ts re-checks them.
 */

export const LIGHT_ACTIVITY_HRR = 0.3;
export const STRAIN_MAX = 21;
export const STRAIN_K = 4.1;
export const STRAIN_ALPHA = 0.315;

export const EDWARDS_ZONES = [
  { zone: 1, minHrr: 0.5, weight: 1 },
  { zone: 2, minHrr: 0.6, weight: 2 },
  { zone: 3, minHrr: 0.7, weight: 3 },
  { zone: 4, minHrr: 0.8, weight: 4 },
  { zone: 5, minHrr: 0.9, weight: 5 },
] as const;

export interface StrainParams {
  restingHr: number;
  maxHr: number;
  sex: 'male' | 'female';
}

export function heartRateReserveFraction(hr: number, restingHr: number, maxHr: number): number {
  const reserve = maxHr - restingHr;
  if (reserve <= 0) return 0;
  return Math.max(0, (hr - restingHr) / reserve);
}

/** Banister's per-minute TRIMP weighting for a %HRR value. */
export function banisterWeight(hrr: number, sex: 'male' | 'female'): number {
  if (hrr <= 0) return 0;
  return sex === 'male' ? hrr * 0.64 * Math.exp(1.92 * hrr) : hrr * 0.86 * Math.exp(1.67 * hrr);
}

/** Edwards zone (0 = below 50 % HRR). */
export function edwardsZone(hrr: number): 0 | 1 | 2 | 3 | 4 | 5 {
  let zone: 0 | 1 | 2 | 3 | 4 | 5 = 0;
  for (const z of EDWARDS_ZONES) if (hrr >= z.minHrr) zone = z.zone;
  return zone;
}

export interface LoadResult {
  /** Banister TRIMP over all samples. */
  trimp: number;
  /** TRIMP in excess of the light-activity floor: the load L used for strain. */
  load: number;
  edwards: number;
  /** Time per Edwards zone 0..5 (ms). */
  zoneMs: [number, number, number, number, number, number];
  durationMs: number;
  avgHr: number | null;
  maxHr: number | null;
}

/**
 * Accumulate load over HR samples sorted by time. Each sample stands for the
 * time until the next one, capped at `maxGapMs` so gaps in wear add nothing.
 */
export function computeLoad(samples: ReadonlyArray<{ t: number; hr: number }>, params: StrainParams, maxGapMs = 10_000): LoadResult {
  const zoneMs: LoadResult['zoneMs'] = [0, 0, 0, 0, 0, 0];
  let trimp = 0;
  let load = 0;
  let edwards = 0;
  let durationMs = 0;
  let hrSum = 0;
  let maxHr: number | null = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const next = samples[i + 1];
    const dt = Math.min(next ? Math.max(0, next.t - s.t) : 1000, maxGapMs);
    const minutes = dt / 60_000;
    const hrr = heartRateReserveFraction(s.hr, params.restingHr, params.maxHr);
    const weight = banisterWeight(hrr, params.sex);
    trimp += weight * minutes;
    if (hrr >= LIGHT_ACTIVITY_HRR) load += (weight - banisterWeight(LIGHT_ACTIVITY_HRR, params.sex)) * minutes;
    const zone = edwardsZone(hrr);
    zoneMs[zone] += dt;
    edwards += zone * minutes;
    durationMs += dt;
    hrSum += s.hr * dt;
    maxHr = maxHr === null ? s.hr : Math.max(maxHr, s.hr);
  }
  return { trimp, load, edwards, zoneMs, durationMs, avgHr: durationMs > 0 ? hrSum / durationMs : null, maxHr };
}

export function strainFromLoad(load: number, k = STRAIN_K, alpha = STRAIN_ALPHA): number {
  if (!(load > 0)) return 0;
  return Math.min(STRAIN_MAX, k * Math.log(1 + alpha * load));
}

/** Inverse of strainFromLoad (for "load needed to reach strain X" hints). */
export function loadForStrain(strain: number, k = STRAIN_K, alpha = STRAIN_ALPHA): number {
  return (Math.exp(Math.min(strain, STRAIN_MAX) / k) - 1) / alpha;
}
