/**
 * Respiratory rate from respiratory sinus arrhythmia (RSA).
 *
 * Breathing modulates the R-R interval (faster heart rate on inhalation), so
 * the dominant frequency of the R-R series in the 0.1-0.5 Hz band is the
 * breathing frequency (Schäfer & Kratky, 2008). R-R intervals are unevenly
 * sampled in time, so the spectrum is computed with the Lomb-Scargle
 * periodogram (Lomb, 1976; Scargle, 1982) instead of an FFT.
 */
import type { FilteredBeat } from './hrv';
import { sliceBeats } from './hrv';
import { median } from './stats';

export interface Periodogram {
  frequencies: number[];
  power: number[];
}

/** Classic normalised Lomb-Scargle periodogram for samples (t seconds, y). */
export function lombScargle(t: readonly number[], y: readonly number[], frequencies: readonly number[]): Periodogram {
  const n = t.length;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  const centred = y.map((v) => v - meanY);
  const variance = centred.reduce((a, b) => a + b * b, 0) / Math.max(1, n - 1);
  const power = frequencies.map((f) => {
    const w = 2 * Math.PI * f;
    let s2 = 0;
    let c2 = 0;
    for (let i = 0; i < n; i++) {
      s2 += Math.sin(2 * w * t[i]!);
      c2 += Math.cos(2 * w * t[i]!);
    }
    const tau = Math.atan2(s2, c2) / (2 * w);
    let yc = 0;
    let ys = 0;
    let cc = 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const arg = w * (t[i]! - tau);
      const c = Math.cos(arg);
      const s = Math.sin(arg);
      yc += centred[i]! * c;
      ys += centred[i]! * s;
      cc += c * c;
      ss += s * s;
    }
    if (variance === 0) return 0;
    return ((cc > 0 ? (yc * yc) / cc : 0) + (ss > 0 ? (ys * ys) / ss : 0)) / (2 * variance);
  });
  return { frequencies: [...frequencies], power };
}

export interface RespirationEstimate {
  breathsPerMinute: number;
  /** Peak power as a share of total band power (0-1); low values mean no clear rhythm. */
  peakShare: number;
}

const BAND_LOW_HZ = 0.1;
const BAND_HIGH_HZ = 0.5;
const STEP_HZ = 0.005;

/** Estimate breathing rate from one window of accepted beats. */
export function estimateRespiration(beats: readonly FilteredBeat[], options: { minBeats?: number; minPeakShare?: number } = {}): RespirationEstimate | null {
  const valid = beats.filter((b) => b.valid);
  if (valid.length < (options.minBeats ?? 40)) return null;
  const t0 = valid[0]!.t;
  const t = valid.map((b) => (b.t - t0) / 1000);
  const y = valid.map((b) => b.rr);
  // Remove the linear trend so slow HR drift does not leak into the band.
  const n = t.length;
  const mt = t.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (t[i]! - mt) * (y[i]! - my);
    den += (t[i]! - mt) ** 2;
  }
  const slope = den > 0 ? num / den : 0;
  const detrended = y.map((v, i) => v - my - slope * (t[i]! - mt));

  const frequencies: number[] = [];
  for (let f = BAND_LOW_HZ; f <= BAND_HIGH_HZ + 1e-9; f += STEP_HZ) frequencies.push(Number(f.toFixed(4)));
  const { power } = lombScargle(t, detrended, frequencies);
  const total = power.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let best = 0;
  for (let i = 1; i < power.length; i++) if (power[i]! > power[best]!) best = i;
  // Share of power within +/-0.02 Hz of the peak.
  let peak = 0;
  for (let i = 0; i < power.length; i++) if (Math.abs(frequencies[i]! - frequencies[best]!) <= 0.02 + 1e-9) peak += power[i]!;
  const peakShare = peak / total;
  if (peakShare < (options.minPeakShare ?? 0.25)) return null;
  return { breathsPerMinute: frequencies[best]! * 60, peakShare };
}

/** Median of 2-minute window estimates (1-minute step) across a period, typically a night's sleep. */
export function respiratoryRateOverPeriod(beats: readonly FilteredBeat[], start: number, end: number, windowMs = 120_000, stepMs = 60_000): number | null {
  const estimates: number[] = [];
  for (let s = start; s + windowMs <= end; s += stepMs) {
    const estimate = estimateRespiration(sliceBeats(beats, s, s + windowMs));
    if (estimate) estimates.push(estimate.breathsPerMinute);
  }
  return estimates.length >= 3 ? median(estimates) : null;
}
