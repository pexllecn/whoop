/**
 * Sleep detection and 30-second staging from autonomic signals.
 *
 * Detection: an epoch is "sleep-like" when the wrist is still (actigraphy) and
 * heart rate has dropped well below the waking level:
 *   HR < min(RHR + 0.65 * (waking median HR - RHR), RHR + 14)
 * When motion data is sparse the stillness test is replaced by an HR-stability
 * test (SD of epoch HR over +/-5 epochs < 4 bpm). Sleep-like epochs are smoothed
 * (11-epoch majority), gaps up to 10 minutes are bridged, two periods of 30+
 * minutes separated by up to 45 minutes are merged (an awakening), and periods
 * shorter than 20 minutes are discarded.
 *
 * Staging (per epoch, features normalised within the night):
 *   Awake: motion > 0.03 g, or HR z > 2.8 (HR z > 2.0 when there is no motion data)
 *   Deep : lowest HR, stable HR, high parasympathetic tone (high ln RMSSD),
 *          favoured early in the night
 *   REM  : fluctuating HR (high local HR variability) with low motion
 *          (atonia), lower ln RMSSD, favoured late, suppressed in the first
 *          10 % of the night (REM latency)
 *   Light: everything else
 *   scores: deep = -zHR - 0.7 zVar + 0.8 zLnRMSSD + 0.5 (1 - 2t)
 *           rem  =  zVar + 0.5 zHR - 0.6 zLnRMSSD + 0.5 (2t - 1)
 *   stage = deep if deep > 1.4 (and >= rem), else REM if rem > 0.8, else light; then a 5-epoch mode filter
 *   and minimum bouts (deep >= 1.5 min, REM >= 2 min).
 * This is a transparent heuristic validated on simulated nights only; it is
 * not a polysomnography-grade classifier.
 */
import type { Epoch } from './epochs';
import { EPOCH_MS } from './epochs';
import { computeHrv, sliceBeats, type FilteredBeat, type StageSpan } from './hrv';
import { mean, median, quantile, sd } from './stats';

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';

export const STILL_G = 0.015;
export const AWAKE_MOTION_G = 0.03;
const SMOOTH_RADIUS = 5;
const MAX_GAP_EPOCHS = 20;
const MIN_PERIOD_EPOCHS = 40;
/** Two long periods separated by at most 45 minutes are one night with an awakening. */
const MERGE_GAP_EPOCHS = 90;
const MERGE_MIN_EPOCHS = 60;
const DEEP_THRESHOLD = 1.4;
const REM_THRESHOLD = 0.8;

export interface SleepPeriod {
  start: number;
  end: number;
  method: 'motion_hr' | 'hr_only';
}

/**
 * HR ceiling for sleep-like epochs. The waking reference is the median HR of
 * epochs with light, non-exercise movement (0.015-0.08 g), so a long workout
 * cannot drag the threshold up; the result is capped at RHR + 14 bpm.
 */
export function sleepHrThreshold(epochs: readonly Epoch[], restingHr: number | null): number | null {
  const hrs = epochs.filter((e) => e.worn && e.meanHr !== null).map((e) => e.meanHr!);
  if (hrs.length < MIN_PERIOD_EPOCHS) return null;
  // Follow tonight's floor upward (fever, alcohol, heat) but never below the baseline.
  const floor = quantile(hrs, 0.05)!;
  const rest = restingHr === null ? floor : Math.max(restingHr, floor);
  const lightMovement = epochs
    .filter((e) => e.worn && e.meanHr !== null && e.meanHr < rest + 35 && e.motion !== null && e.motion >= STILL_G && e.motion < 0.08)
    .map((e) => e.meanHr!);
  const waking = lightMovement.length >= 60 ? median(lightMovement)! : quantile(hrs.filter((h) => h < rest + 35), 0.6) ?? rest + 15;
  if (waking <= rest) return rest + 4;
  return Math.min(rest + 0.65 * (waking - rest), rest + 14);
}

export function detectSleepPeriods(epochs: readonly Epoch[], options: { restingHr: number | null }): SleepPeriod[] {
  const threshold = sleepHrThreshold(epochs, options.restingHr);
  if (threshold === null) return [];
  const motionCoverage = epochs.filter((e) => e.worn && e.motion !== null).length / Math.max(1, epochs.filter((e) => e.worn).length);
  const useMotion = motionCoverage >= 0.5;

  const candidate = epochs.map((e, i) => {
    if (!e.worn || e.meanHr === null) return false;
    const hrLow = e.meanHr < threshold;
    if (useMotion) return hrLow && e.motion !== null && e.motion < STILL_G;
    const local: number[] = [];
    for (let j = Math.max(0, i - 5); j <= Math.min(epochs.length - 1, i + 5); j++) {
      if (epochs[j]!.meanHr !== null) local.push(epochs[j]!.meanHr!);
    }
    return hrLow && (sd(local) ?? 0) < 4;
  });

  // Majority smoothing.
  const smoothed = candidate.map((_, i) => {
    let yes = 0;
    let n = 0;
    for (let j = Math.max(0, i - SMOOTH_RADIUS); j <= Math.min(candidate.length - 1, i + SMOOTH_RADIUS); j++) {
      n++;
      if (candidate[j]) yes++;
    }
    return yes * 2 > n;
  });

  // Runs, bridged across short gaps.
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < smoothed.length) {
    if (!smoothed[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < smoothed.length && smoothed[j]) j++;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= MAX_GAP_EPOCHS) last[1] = j;
    else runs.push([i, j]);
    i = j;
  }

  const merged: Array<[number, number]> = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] <= MERGE_GAP_EPOCHS && last[1] - last[0] >= MERGE_MIN_EPOCHS && run[1] - run[0] >= MERGE_MIN_EPOCHS) last[1] = run[1];
    else merged.push([...run]);
  }

  return merged
    .filter(([a, b]) => b - a >= MIN_PERIOD_EPOCHS)
    .map(([a, b]) => ({ start: epochs[a]!.start, end: epochs[b - 1]!.start + EPOCH_MS, method: useMotion ? 'motion_hr' : 'hr_only' }));
}

export interface SleepSummary {
  inBedMs: number;
  awakeMs: number;
  lightMs: number;
  deepMs: number;
  remMs: number;
  noDataMs: number;
  asleepMs: number;
  efficiency: number | null;
  disturbances: number;
  remCycles: number;
  latencyMs: number;
}

export interface SleepStaging {
  stages: Array<SleepStage | null>;
  spans: StageSpan[];
  summary: SleepSummary;
}

function zScores(values: Array<number | null>, sdFloor: number): Array<number | null> {
  const present = values.filter((v): v is number => v !== null);
  const m = mean(present);
  const s = Math.max(sdFloor, sd(present) ?? 0);
  return values.map((v) => (v === null || m === null ? null : (v - m) / s));
}

function modeFilter(stages: Array<SleepStage | null>, radius: number): Array<SleepStage | null> {
  return stages.map((stage, i) => {
    if (stage === null || stage === 'awake') return stage;
    const counts = new Map<SleepStage, number>();
    for (let j = Math.max(0, i - radius); j <= Math.min(stages.length - 1, i + radius); j++) {
      const s = stages[j];
      if (s && s !== 'awake') counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    let best: SleepStage = stage;
    let bestCount = 0;
    for (const [s, c] of counts) {
      if (c > bestCount || (c === bestCount && s === stage)) {
        best = s;
        bestCount = c;
      }
    }
    return best;
  });
}

function enforceMinimumBouts(stages: Array<SleepStage | null>, minimum: Partial<Record<SleepStage, number>>): Array<SleepStage | null> {
  const out = [...stages];
  let i = 0;
  while (i < out.length) {
    const stage = out[i];
    let j = i;
    while (j < out.length && out[j] === stage) j++;
    const min = stage ? minimum[stage] : undefined;
    if (stage && min && j - i < min) for (let k = i; k < j; k++) out[k] = 'light';
    i = j;
  }
  return out;
}

/** Stage the epochs of one sleep period (contiguous, sorted). */
export function stageSleep(epochs: readonly Epoch[], beats: readonly FilteredBeat[]): SleepStaging {
  const n = epochs.length;
  const hr = epochs.map((e) => (e.worn ? e.meanHr : null));
  const localVar = hr.map((_, i) => {
    const window: number[] = [];
    for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (hr[j] !== null) window.push(hr[j]!);
    return window.length >= 3 ? sd(window) : null;
  });
  const lnRmssd = epochs.map((e) => {
    const metrics = computeHrv(sliceBeats(beats, e.start - 120_000, e.start + 150_000), { prefiltered: true, minPairs: 40 });
    return metrics ? metrics.lnRmssd : null;
  });
  const zHr = zScores(hr, 1.5);
  const zVar = zScores(localVar, 0.3);
  const zLn = zScores(lnRmssd, 0.08);

  const raw: Array<SleepStage | null> = epochs.map((e, i) => {
    if (!e.worn || hr[i] === null) return null;
    const t = n > 1 ? i / (n - 1) : 0;
    const h = zHr[i] ?? 0;
    // Movement marks wakefulness; HR alone only when it is far above the night (REM also raises HR).
    if (e.motion !== null ? e.motion > AWAKE_MOTION_G || h > 2.8 : h > 2.0) return 'awake';
    const v = zVar[i] ?? 0;
    const l = zLn[i] ?? 0;
    const deep = -h - 0.7 * v + 0.8 * l + 0.5 * (1 - 2 * t);
    const rem = v + 0.5 * h - 0.6 * l + 0.5 * (2 * t - 1) - (t < 0.1 ? 3 : 0);
    if (deep > DEEP_THRESHOLD && deep >= rem) return 'deep';
    if (rem > REM_THRESHOLD) return 'rem';
    return 'light';
  });
  const stages = enforceMinimumBouts(modeFilter(raw, 2), { deep: 3, rem: 4 });

  const spans: StageSpan[] = [];
  stages.forEach((stage, i) => {
    if (!stage) return;
    const start = epochs[i]!.start;
    const last = spans[spans.length - 1];
    if (last && last.stage === stage && last.end === start) last.end = start + EPOCH_MS;
    else spans.push({ start, end: start + EPOCH_MS, stage });
  });

  const count = (s: SleepStage) => stages.filter((x) => x === s).length * EPOCH_MS;
  const awakeMs = count('awake');
  const lightMs = count('light');
  const deepMs = count('deep');
  const remMs = count('rem');
  const noDataMs = stages.filter((x) => x === null).length * EPOCH_MS;
  const inBedMs = n * EPOCH_MS;
  const asleepMs = lightMs + deepMs + remMs;

  // Disturbances: awake bouts of >= 1 minute after sleep onset, excluding the final wake-up.
  let disturbances = 0;
  const firstSleep = stages.findIndex((s) => s === 'light' || s === 'deep' || s === 'rem');
  let lastSleep = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (stages[k] === 'light' || stages[k] === 'deep' || stages[k] === 'rem') {
      lastSleep = k;
      break;
    }
  }
  for (let k = Math.max(0, firstSleep); k <= lastSleep; ) {
    if (stages[k] === 'awake') {
      let j = k;
      while (j <= lastSleep && stages[j] === 'awake') j++;
      if (j - k >= 2) disturbances++;
      k = j;
    } else k++;
  }
  const remCycles = spans.filter((s) => s.stage === 'rem' && s.end - s.start >= 3 * 60_000).length;

  return {
    stages,
    spans,
    summary: {
      inBedMs,
      awakeMs,
      lightMs,
      deepMs,
      remMs,
      noDataMs,
      asleepMs,
      efficiency: inBedMs > 0 ? (asleepMs / inBedMs) * 100 : null,
      disturbances,
      remCycles,
      latencyMs: firstSleep >= 0 ? firstSleep * EPOCH_MS : inBedMs,
    },
  };
}

/** Resting HR: lowest 5-minute rolling mean of epoch HR during sleep. */
export function restingHrFromSleep(epochs: readonly Epoch[]): number | null {
  const hr = epochs.map((e) => (e.worn ? e.meanHr : null));
  let best: number | null = null;
  for (let i = 0; i + 10 <= hr.length; i++) {
    const window = hr.slice(i, i + 10).filter((v): v is number => v !== null);
    if (window.length < 8) continue;
    const m = window.reduce((a, b) => a + b, 0) / window.length;
    if (best === null || m < best) best = m;
  }
  return best;
}
