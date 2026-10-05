/**
 * Turns stored samples into analysis-ready series: one heart-rate source per
 * minute, a beat (R-R) timeline, and 30-second epochs.
 */
import { filterRR, type FilteredBeat, type RrBeat, computeHrv, sliceBeats } from './hrv';
import { mean, sd } from './stats';

export const EPOCH_MS = 30_000;

export interface HrSampleInput {
  ts: number;
  bpm: number | null;
  rr: number[];
  source: string;
}

export interface MotionInput {
  ts: number;
  activity: number;
}

/** Lower number wins when several sources report the same minute. */
export const SOURCE_PRIORITY: Record<string, number> = {
  sig_hrm: 1,
  simulated: 2,
  proprietary_realtime: 3,
  proprietary_historical: 4,
  apple_health: 5,
};

/**
 * The strap can report the same heartbeat through 0x2A37 and through
 * proprietary records; keep only the highest-priority source in each minute.
 */
export function arbitrateSources<T extends { ts: number; source: string }>(rows: readonly T[]): T[] {
  const best = new Map<number, number>();
  for (const row of rows) {
    const minute = Math.floor(row.ts / 60_000);
    const priority = SOURCE_PRIORITY[row.source] ?? 9;
    if (priority < (best.get(minute) ?? Number.POSITIVE_INFINITY)) best.set(minute, priority);
  }
  return rows.filter((row) => (SOURCE_PRIORITY[row.source] ?? 9) === best.get(Math.floor(row.ts / 60_000)));
}

/**
 * Beat timeline from heart-rate reports.
 *
 * The Heart Rate Service sends every R-R interval exactly once, carrying
 * values not yet transmitted into the next notification, so the R-R values of
 * consecutive notifications form one continuous beat series. Beat times are
 * therefore chained cumulatively (t_i = t_(i-1) + rr_i). The chain is
 * re-anchored to the report time, with the last interval ending at `ts`, when
 * the stream breaks: the first report, a source change, or a chained clock
 * that drifts more than 2.5 s from the report time (dropped notifications or
 * a wear gap).
 */
export class BeatClock {
  private clock: number | null = null;
  private source: string | null = null;

  push(ts: number, rr: readonly number[], source: string): RrBeat[] {
    if (rr.length === 0) return [];
    const total = rr.reduce((a, b) => a + b, 0);
    const continuous = this.clock !== null && this.source === source && Math.abs(this.clock + total - ts) <= 2500;
    let t = continuous ? this.clock! : ts - total;
    const beats: RrBeat[] = [];
    for (const interval of rr) {
      t += interval;
      beats.push({ t, rr: interval });
    }
    this.clock = t;
    this.source = source;
    return beats;
  }

  reset(): void {
    this.clock = null;
    this.source = null;
  }
}

export function reconstructBeats(rows: readonly HrSampleInput[], options: { includeHistoricalRr?: boolean } = {}): RrBeat[] {
  const clock = new BeatClock();
  const beats: RrBeat[] = [];
  for (const row of rows) {
    if (row.source === 'proprietary_historical' && options.includeHistoricalRr === false) continue;
    beats.push(...clock.push(row.ts, row.rr, row.source));
  }
  beats.sort((a, b) => a.t - b.t);
  // Drop exact duplicates (same beat reported twice).
  return beats.filter((b, i) => i === 0 || b.t - beats[i - 1]!.t > 50);
}

export function heartRateSeries(rows: readonly HrSampleInput[]): Array<{ t: number; hr: number }> {
  return rows
    .filter((r): r is HrSampleInput & { bpm: number } => r.bpm !== null && r.bpm >= 25 && r.bpm <= 240)
    .map((r) => ({ t: r.ts, hr: r.bpm }))
    .sort((a, b) => a.t - b.t);
}

export interface Epoch {
  start: number;
  meanHr: number | null;
  minHr: number | null;
  maxHr: number | null;
  hrSd: number | null;
  rrCount: number;
  validRrCount: number;
  rmssd: number | null;
  motion: number | null;
  worn: boolean;
}

export interface PreparedSeries {
  hr: Array<{ t: number; hr: number }>;
  beats: FilteredBeat[];
  motion: MotionInput[];
}

export function prepareSeries(rows: readonly HrSampleInput[], motion: readonly MotionInput[], options: { includeHistoricalRr?: boolean } = {}): PreparedSeries {
  const chosen = arbitrateSources(rows);
  return {
    hr: heartRateSeries(chosen),
    beats: filterRR(reconstructBeats(chosen, options)),
    motion: [...motion].sort((a, b) => a.ts - b.ts),
  };
}

/** Build contiguous 30 s epochs over [from, to). All inputs sorted by time. */
export function buildEpochs(from: number, to: number, series: PreparedSeries): Epoch[] {
  const epochs: Epoch[] = [];
  let hi = 0;
  let mi = 0;
  const start0 = Math.floor(from / EPOCH_MS) * EPOCH_MS;
  for (let start = start0; start < to; start += EPOCH_MS) {
    const end = start + EPOCH_MS;
    const hrValues: number[] = [];
    while (hi < series.hr.length && series.hr[hi]!.t < start) hi++;
    for (let j = hi; j < series.hr.length && series.hr[j]!.t < end; j++) hrValues.push(series.hr[j]!.hr);
    const motionValues: number[] = [];
    while (mi < series.motion.length && series.motion[mi]!.ts < start) mi++;
    for (let j = mi; j < series.motion.length && series.motion[j]!.ts < end; j++) motionValues.push(series.motion[j]!.activity);
    const beats = sliceBeats(series.beats, start, end);
    const valid = beats.filter((b) => b.valid);
    let meanHr = mean(hrValues);
    if (meanHr === null && valid.length >= 10) meanHr = 60_000 / mean(valid.map((b) => b.rr))!;
    const hrv = computeHrv(beats, { prefiltered: true, minPairs: 10 });
    epochs.push({
      start,
      meanHr,
      minHr: hrValues.length ? Math.min(...hrValues) : null,
      maxHr: hrValues.length ? Math.max(...hrValues) : null,
      hrSd: sd(hrValues),
      rrCount: beats.length,
      validRrCount: valid.length,
      rmssd: hrv?.rmssd ?? null,
      motion: mean(motionValues),
      worn: meanHr !== null && meanHr >= 30 && meanHr <= 220 && (hrValues.length >= 5 || valid.length >= 10),
    });
  }
  return epochs;
}
