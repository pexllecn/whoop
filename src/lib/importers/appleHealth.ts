/**
 * Streaming importer for Apple Health exports (export.zip or export.xml).
 * Exports routinely exceed 1 GB, so the XML is parsed with a SAX parser while
 * the ZIP is inflated chunk by chunk; nothing is held in memory except daily
 * aggregates, sleep segments and workouts.
 *
 * Imported:
 *   HKQuantityTypeIdentifierHeartRate                     -> hr_rr_samples (source apple_health)
 *   HKQuantityTypeIdentifierRestingHeartRate              -> daily resting HR
 *   HKQuantityTypeIdentifierHeartRateVariabilitySDNN      -> daily HRV SDNN (kept apart from RMSSD)
 *   HKQuantityTypeIdentifierRespiratoryRate               -> daily respiratory rate
 *   HKQuantityTypeIdentifierOxygenSaturation              -> daily SpO2 (%)
 *   HKQuantityTypeIdentifierAppleSleepingWristTemperature -> daily skin temperature
 *   HKCategoryTypeIdentifierSleepAnalysis                 -> sleep sessions with stages
 *   Workout (+ WorkoutStatistics)                         -> workouts
 */
import { createReadStream } from 'node:fs';
import { eq } from 'drizzle-orm';
import { Unzip, UnzipInflate } from 'fflate';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { OpenPulseDb } from '../storage/db';
import { dailySummaries, hrRrSamples, importRuns, sleepSessions, workouts } from '../storage/schema';
import { HOUR_MS, dateKey, zonedParts } from '../time';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-])(\d{2}):?(\d{2})$/;

/** Parse Apple's "2024-01-15 08:00:00 -0500" timestamps. */
export function parseAppleDate(value: string | undefined): number | null {
  if (!value) return null;
  const m = DATE_PATTERN.exec(value.trim());
  if (!m) {
    const fallback = Date.parse(value);
    return Number.isFinite(fallback) ? fallback : null;
  }
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9]));
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000;
}

export type AppleSleepStage = 'in_bed' | 'asleep' | 'light' | 'deep' | 'rem' | 'awake';

const SLEEP_VALUES: Record<string, AppleSleepStage> = {
  HKCategoryValueSleepAnalysisInBed: 'in_bed',
  HKCategoryValueSleepAnalysisAsleep: 'asleep',
  HKCategoryValueSleepAnalysisAsleepUnspecified: 'asleep',
  HKCategoryValueSleepAnalysisAsleepCore: 'light',
  HKCategoryValueSleepAnalysisAsleepDeep: 'deep',
  HKCategoryValueSleepAnalysisAsleepREM: 'rem',
  HKCategoryValueSleepAnalysisAwake: 'awake',
};

export interface SleepSegment {
  start: number;
  end: number;
  stage: AppleSleepStage;
}

export interface AppleSleepSession {
  externalId: string;
  date: string;
  startTs: number;
  endTs: number;
  isNap: boolean;
  inBedMs: number;
  awakeMs: number;
  lightMs: number;
  deepMs: number;
  remMs: number;
  noDataMs: number;
  efficiency: number | null;
  segments: SleepSegment[];
}

export interface AppleWorkout {
  externalId: string;
  date: string;
  startTs: number;
  endTs: number;
  sport: string;
  kcal: number | null;
  distanceM: number | null;
  avgHr: number | null;
  maxHr: number | null;
}

export interface AppleDay {
  date: string;
  restingHr: number | null;
  hrvSdnn: number | null;
  respRate: number | null;
  spo2: number | null;
  skinTempC: number | null;
}

export interface ParsedAppleHealth {
  days: AppleDay[];
  sleeps: AppleSleepSession[];
  workouts: AppleWorkout[];
  heartRateSamples: number;
  recordCounts: Record<string, number>;
}

/** "HKWorkoutActivityTypeTraditionalStrengthTraining" -> "Traditional Strength Training" */
export function sportName(activityType: string | undefined): string {
  if (!activityType) return 'Workout';
  return activityType
    .replace(/^HKWorkoutActivityType/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim() || 'Workout';
}

function toMeters(value: number, unit: string | undefined): number {
  switch ((unit ?? 'm').toLowerCase()) {
    case 'km':
      return value * 1000;
    case 'mi':
      return value * 1609.344;
    case 'ft':
      return value * 0.3048;
    case 'yd':
      return value * 0.9144;
    default:
      return value;
  }
}

function toKcal(value: number, unit: string | undefined): number {
  return (unit ?? 'kcal').toLowerCase() === 'kj' ? value / 4.184 : value;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Group sleep segments into sessions; staged (Watch) data wins over overlapping unstaged entries. */
export function buildSleepSessions(segments: SleepSegment[], timeZone: string): AppleSleepSession[] {
  if (segments.length === 0) return [];
  const staged = segments.filter((s) => s.stage === 'light' || s.stage === 'deep' || s.stage === 'rem' || s.stage === 'awake');
  const overlapsStaged = (s: SleepSegment) => staged.some((t) => t.start < s.end && s.start < t.end);
  const usable = segments
    .filter((s) => (s.stage === 'in_bed' || s.stage === 'asleep' ? !overlapsStaged(s) : true))
    .sort((a, b) => a.start - b.start);

  const groups: SleepSegment[][] = [];
  let current: SleepSegment[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;
  for (const segment of usable) {
    if (current.length && segment.start - currentEnd > HOUR_MS) {
      groups.push(current);
      current = [];
      currentEnd = Number.NEGATIVE_INFINITY;
    }
    current.push(segment);
    currentEnd = Math.max(currentEnd, segment.end);
  }
  if (current.length) groups.push(current);

  return groups
    .map((group) => {
      const startTs = Math.min(...group.map((s) => s.start));
      const endTs = Math.max(...group.map((s) => s.end));
      const sum = (stages: AppleSleepStage[]) =>
        group.filter((s) => stages.includes(s.stage)).reduce((total, s) => total + (s.end - s.start), 0);
      const lightMs = sum(['light', 'asleep']);
      const deepMs = sum(['deep']);
      const remMs = sum(['rem']);
      const awakeMs = sum(['awake']);
      const inBedMs = endTs - startTs;
      const asleep = lightMs + deepMs + remMs;
      const startHour = zonedParts(startTs, timeZone).hour;
      return {
        externalId: `apple:${startTs}`,
        date: dateKey(endTs, timeZone),
        startTs,
        endTs,
        isNap: inBedMs < 3 * HOUR_MS && startHour >= 9 && startHour < 19,
        inBedMs,
        awakeMs,
        lightMs,
        deepMs,
        remMs,
        noDataMs: Math.max(0, inBedMs - asleep - awakeMs),
        efficiency: inBedMs > 0 && asleep > 0 ? Math.min(100, (asleep / inBedMs) * 100) : null,
        segments: group,
      };
    })
    .filter((s) => s.inBedMs >= 15 * 60_000);
}

export interface AppleHealthSink {
  heartRate(batch: Array<{ ts: number; bpm: number }>): void;
}

/** Incremental SAX parser; feed text with write(), then call finish(). */
export class AppleHealthParser {
  private readonly parser = new SaxesParser();
  private readonly daily = new Map<string, { rhr: number[]; sdnn: number[]; resp: number[]; spo2: number[]; temp: number[] }>();
  private readonly segments: SleepSegment[] = [];
  private readonly workoutList: AppleWorkout[] = [];
  private readonly recordCounts: Record<string, number> = {};
  private hrBatch: Array<{ ts: number; bpm: number }> = [];
  private heartRateSamples = 0;
  private openWorkout: (Omit<AppleWorkout, 'avgHr' | 'maxHr'> & { avgHr: number | null; maxHr: number | null }) | null = null;
  private failure: Error | null = null;

  constructor(
    private readonly timeZone: string,
    private readonly sink: AppleHealthSink,
  ) {
    this.parser.on('opentag', (tag) => this.onOpen(tag as SaxesTagPlain));
    this.parser.on('closetag', (tag) => this.onClose(tag as SaxesTagPlain));
    this.parser.on('error', (error) => {
      this.failure ??= error;
    });
  }

  private day(ts: number) {
    const key = dateKey(ts, this.timeZone);
    let entry = this.daily.get(key);
    if (!entry) {
      entry = { rhr: [], sdnn: [], resp: [], spo2: [], temp: [] };
      this.daily.set(key, entry);
    }
    return entry;
  }

  private onOpen(tag: SaxesTagPlain): void {
    const a = tag.attributes;
    if (tag.name === 'Record') {
      const type = a.type ?? 'unknown';
      this.recordCounts[type] = (this.recordCounts[type] ?? 0) + 1;
      const start = parseAppleDate(a.startDate);
      if (start === null) return;
      if (type === 'HKCategoryTypeIdentifierSleepAnalysis') {
        const stage = SLEEP_VALUES[a.value ?? ''];
        const end = parseAppleDate(a.endDate);
        if (stage && end !== null && end > start) this.segments.push({ start, end, stage });
        return;
      }
      const value = Number(a.value);
      if (!Number.isFinite(value)) return;
      switch (type) {
        case 'HKQuantityTypeIdentifierHeartRate':
          if (value > 20 && value < 260) {
            this.hrBatch.push({ ts: start, bpm: value });
            this.heartRateSamples++;
            if (this.hrBatch.length >= 5000) this.flush();
          }
          break;
        case 'HKQuantityTypeIdentifierRestingHeartRate':
          this.day(start).rhr.push(value);
          break;
        case 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN':
          this.day(start).sdnn.push(value);
          break;
        case 'HKQuantityTypeIdentifierRespiratoryRate':
          this.day(start).resp.push(value);
          break;
        case 'HKQuantityTypeIdentifierOxygenSaturation':
          this.day(start).spo2.push(value <= 1 ? value * 100 : value);
          break;
        case 'HKQuantityTypeIdentifierAppleSleepingWristTemperature':
          this.day(start).temp.push((a.unit ?? 'degC').toLowerCase() === 'degf' ? ((value - 32) * 5) / 9 : value);
          break;
      }
    } else if (tag.name === 'Workout') {
      const startTs = parseAppleDate(a.startDate);
      const endTs = parseAppleDate(a.endDate);
      if (startTs === null || endTs === null || endTs <= startTs) return;
      const sport = sportName(a.workoutActivityType);
      const energy = Number(a.totalEnergyBurned);
      const distance = Number(a.totalDistance);
      this.openWorkout = {
        externalId: `apple:${startTs}:${a.workoutActivityType ?? 'workout'}`,
        date: dateKey(startTs, this.timeZone),
        startTs,
        endTs,
        sport,
        kcal: Number.isFinite(energy) && energy > 0 ? toKcal(energy, a.totalEnergyBurnedUnit) : null,
        distanceM: Number.isFinite(distance) && distance > 0 ? toMeters(distance, a.totalDistanceUnit) : null,
        avgHr: null,
        maxHr: null,
      };
    } else if (tag.name === 'WorkoutStatistics' && this.openWorkout) {
      const type = a.type ?? '';
      if (type === 'HKQuantityTypeIdentifierActiveEnergyBurned' && this.openWorkout.kcal === null && a.sum) {
        this.openWorkout.kcal = toKcal(Number(a.sum), a.unit);
      } else if (type.startsWith('HKQuantityTypeIdentifierDistance') && this.openWorkout.distanceM === null && a.sum) {
        this.openWorkout.distanceM = toMeters(Number(a.sum), a.unit);
      } else if (type === 'HKQuantityTypeIdentifierHeartRate') {
        if (a.average) this.openWorkout.avgHr = Number(a.average);
        if (a.maximum) this.openWorkout.maxHr = Number(a.maximum);
      }
    }
  }

  private onClose(tag: SaxesTagPlain): void {
    if (tag.name === 'Workout' && this.openWorkout) {
      this.workoutList.push(this.openWorkout);
      this.openWorkout = null;
    }
  }

  private flush(): void {
    if (this.hrBatch.length) {
      this.sink.heartRate(this.hrBatch);
      this.hrBatch = [];
    }
  }

  write(text: string): void {
    if (this.failure) throw this.failure;
    this.parser.write(text);
    if (this.failure) throw this.failure;
  }

  finish(): ParsedAppleHealth {
    this.parser.close();
    if (this.failure) throw this.failure;
    this.flush();
    const days: AppleDay[] = [...this.daily.entries()]
      .map(([date, v]) => ({
        date,
        restingHr: mean(v.rhr),
        hrvSdnn: mean(v.sdnn),
        respRate: mean(v.resp),
        spo2: mean(v.spo2),
        skinTempC: mean(v.temp),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      days,
      sleeps: buildSleepSessions(this.segments, this.timeZone),
      workouts: this.workoutList,
      heartRateSamples: this.heartRateSamples,
      recordCounts: this.recordCounts,
    };
  }
}

export interface AppleHealthImportReport {
  source: 'apple_health';
  heartRateSamples: number;
  days: number;
  sleeps: number;
  workouts: number;
  recordCounts: Record<string, number>;
  dateRange: { from: string; to: string } | null;
}

/**
 * Import from a byte stream (file or HTTP upload). The previous Apple Health
 * import is replaced: exports always contain the full history.
 */
export async function importAppleHealthStream(
  db: OpenPulseDb,
  chunks: AsyncIterable<Uint8Array>,
  options: { timeZone: string; filename: string; zip?: boolean },
): Promise<AppleHealthImportReport> {
  const startedAt = Date.now();
  db.delete(hrRrSamples).where(eq(hrRrSamples.source, 'apple_health')).run();

  const insertHr = (batch: Array<{ ts: number; bpm: number }>) => {
    db.transaction((tx) => {
      for (const s of batch) tx.insert(hrRrSamples).values({ ts: s.ts, bpm: s.bpm, rrMs: '[]', rrCount: 0, source: 'apple_health' }).run();
    });
  };
  const parser = new AppleHealthParser(options.timeZone, { heartRate: insertHr });
  const decoder = new TextDecoder('utf-8');
  let firstChunk = true;
  let zipMode = options.zip;
  let unzip: Unzip | null = null;
  let unzipError: Error | null = null;
  let foundXml = false;

  for await (const chunk of chunks) {
    if (firstChunk) {
      zipMode ??= chunk[0] === 0x50 && chunk[1] === 0x4b;
      firstChunk = false;
      if (zipMode) {
        unzip = new Unzip((file) => {
          if (!/(^|\/)export\.xml$/i.test(file.name)) return;
          foundXml = true;
          file.ondata = (error, data, final) => {
            if (error) {
              unzipError ??= error;
              return;
            }
            try {
              parser.write(decoder.decode(data, { stream: !final }));
            } catch (parseError) {
              unzipError ??= parseError as Error;
            }
          };
          file.start();
        });
        unzip.register(UnzipInflate);
      }
    }
    if (unzip) {
      unzip.push(chunk, false);
      if (unzipError) throw unzipError;
    } else {
      parser.write(decoder.decode(chunk, { stream: true }));
    }
  }
  if (unzip) {
    unzip.push(new Uint8Array(0), true);
    if (unzipError) throw unzipError;
    if (!foundXml) throw new Error('No export.xml found in the ZIP');
  } else {
    parser.write(decoder.decode());
  }

  const parsed = parser.finish();
  const now = Date.now();
  db.transaction((tx) => {
    for (const day of parsed.days) {
      const values = { date: day.date, source: 'apple_health', restingHr: day.restingHr, hrvSdnn: day.hrvSdnn, respRate: day.respRate, spo2: day.spo2, skinTempC: day.skinTempC, calibrating: false, updatedAt: now };
      tx.insert(dailySummaries).values(values).onConflictDoUpdate({ target: [dailySummaries.date, dailySummaries.source], set: values }).run();
    }
    for (const s of parsed.sleeps) {
      const values = {
        source: 'apple_health',
        externalId: s.externalId,
        date: s.date,
        startTs: s.startTs,
        endTs: s.endTs,
        isNap: s.isNap,
        inBedMs: s.inBedMs,
        awakeMs: s.awakeMs,
        lightMs: s.lightMs,
        deepMs: s.deepMs,
        remMs: s.remMs,
        noDataMs: s.noDataMs,
        efficiency: s.efficiency,
        stagesJson: JSON.stringify(s.segments),
        computedAt: now,
      };
      tx.insert(sleepSessions).values(values).onConflictDoUpdate({ target: [sleepSessions.source, sleepSessions.externalId], set: values }).run();
    }
    for (const w of parsed.workouts) {
      const values = { source: 'apple_health', externalId: w.externalId, date: w.date, startTs: w.startTs, endTs: w.endTs, sport: w.sport, kcal: w.kcal, distanceM: w.distanceM, avgHr: w.avgHr, maxHr: w.maxHr, computedAt: now };
      tx.insert(workouts).values(values).onConflictDoUpdate({ target: [workouts.source, workouts.externalId], set: values }).run();
    }
  });

  const dates = parsed.days.map((d) => d.date).concat(parsed.sleeps.map((s) => s.date)).sort();
  const report: AppleHealthImportReport = {
    source: 'apple_health',
    heartRateSamples: parsed.heartRateSamples,
    days: parsed.days.length,
    sleeps: parsed.sleeps.length,
    workouts: parsed.workouts.length,
    recordCounts: parsed.recordCounts,
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
  };
  db.insert(importRuns)
    .values({ source: 'apple_health', filename: options.filename, startedAt, finishedAt: Date.now(), status: 'ok', counts: JSON.stringify({ heartRateSamples: report.heartRateSamples, days: report.days, sleeps: report.sleeps, workouts: report.workouts }) })
    .run();
  return report;
}

export async function importAppleHealthFile(db: OpenPulseDb, filePath: string, timeZone: string): Promise<AppleHealthImportReport> {
  const stream = createReadStream(filePath, { highWaterMark: 1 << 20 }) as AsyncIterable<Uint8Array>;
  return importAppleHealthStream(db, stream, { timeZone, filename: filePath, zip: /\.zip$/i.test(filePath) ? true : undefined });
}
