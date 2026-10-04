/** Read models for the dashboard (server side only). */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { OpenPulseDb } from './storage/db';
import { stalePacketCount, rawPacketStatusCounts } from './storage/replay';
import {
  biometricEpochs,
  dailySummaries,
  devices,
  hrRrSamples,
  importRuns,
  rawPackets,
  sleepSessions,
  userBaseline,
  workouts,
  type DailySummaryRow,
  type SleepSessionRow,
  type WorkoutRow,
} from './storage/schema';
import { getSettings, publicSettings, type AppSettings } from './storage/settings';
import { addDays, dateKey, dayRange } from './time';

export interface DayView {
  date: string;
  summary: DailySummaryRow | null;
  imported: DailySummaryRow | null;
}

export interface Baselines {
  lnRmssd: { mean: number; sd: number; n: number } | null;
  restingHr: { mean: number; sd: number; n: number } | null;
  respRate: { mean: number; sd: number; n: number } | null;
}

export function today(db: OpenPulseDb): string {
  return dateKey(Date.now(), getSettings(db).timeZone);
}

export function summariesBetween(db: OpenPulseDb, from: string, to: string, source = 'openpulse'): DailySummaryRow[] {
  return db
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.source, source), gte(dailySummaries.date, from), lte(dailySummaries.date, to)))
    .orderBy(asc(dailySummaries.date))
    .all();
}

export function latestBaselines(db: OpenPulseDb, onOrBefore: string): Baselines {
  const get = (metric: string) =>
    db
      .select({ mean: userBaseline.mean, sd: userBaseline.sd, n: userBaseline.n })
      .from(userBaseline)
      .where(and(eq(userBaseline.metric, metric), lte(userBaseline.date, onOrBefore)))
      .orderBy(desc(userBaseline.date))
      .limit(1)
      .get() ?? null;
  return { lnRmssd: get('ln_rmssd'), restingHr: get('resting_hr'), respRate: get('resp_rate') };
}

/** Main sleep for a date: OpenPulse first, then imported sources. */
export function mainSleep(db: OpenPulseDb, date: string): SleepSessionRow | null {
  const rows = db
    .select()
    .from(sleepSessions)
    .where(and(eq(sleepSessions.date, date), eq(sleepSessions.isNap, false)))
    .all();
  const order = ['openpulse', 'whoop_csv', 'apple_health'];
  return rows.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source))[0] ?? null;
}

export function napsOn(db: OpenPulseDb, date: string): SleepSessionRow[] {
  return db
    .select()
    .from(sleepSessions)
    .where(and(eq(sleepSessions.date, date), eq(sleepSessions.isNap, true)))
    .orderBy(asc(sleepSessions.startTs))
    .all();
}

export function workoutsBetween(db: OpenPulseDb, from: string, to: string): WorkoutRow[] {
  return db
    .select()
    .from(workouts)
    .where(and(gte(workouts.date, from), lte(workouts.date, to)))
    .orderBy(desc(workouts.startTs))
    .all();
}

export interface StageEpoch {
  t: number;
  stage: 'awake' | 'light' | 'deep' | 'rem' | null;
  hr: number | null;
}

export function sessionEpochs(db: OpenPulseDb, session: SleepSessionRow): StageEpoch[] {
  return db
    .select({ t: biometricEpochs.epochStart, stage: biometricEpochs.stage, hr: biometricEpochs.meanHr })
    .from(biometricEpochs)
    .where(and(gte(biometricEpochs.epochStart, session.startTs), lte(biometricEpochs.epochStart, session.endTs)))
    .orderBy(asc(biometricEpochs.epochStart))
    .all()
    .map((e) => ({ t: e.t, stage: (e.stage as StageEpoch['stage']) ?? null, hr: e.hr }));
}

export interface StressMinute {
  t: number;
  score: number;
}

export function stressForDay(db: OpenPulseDb, date: string, timeZone: string): StressMinute[] {
  const { start, end } = dayRange(date, timeZone);
  return db
    .select({ t: biometricEpochs.epochStart, score: biometricEpochs.stress })
    .from(biometricEpochs)
    .where(and(gte(biometricEpochs.epochStart, start), lte(biometricEpochs.epochStart, end), sql`${biometricEpochs.stress} is not null`))
    .orderBy(asc(biometricEpochs.epochStart))
    .all()
    // Each minute's score is written to both of its epochs; keep one per minute.
    .filter((r) => r.t % 60_000 === 0)
    .map((r) => ({ t: r.t, score: r.score! }));
}

export interface HourlyHr {
  t: number;
  mean: number;
  min: number;
  max: number;
}

/** Heart rate in 10-minute buckets over a day (from epochs). */
export function heartRateForDay(db: OpenPulseDb, date: string, timeZone: string): HourlyHr[] {
  const { start, end } = dayRange(date, timeZone);
  return db
    .select({
      bucket: sql<number>`(${biometricEpochs.epochStart} / 600000) * 600000`,
      mean: sql<number>`avg(${biometricEpochs.meanHr})`,
      min: sql<number>`min(${biometricEpochs.minHr})`,
      max: sql<number>`max(${biometricEpochs.maxHr})`,
    })
    .from(biometricEpochs)
    .where(and(gte(biometricEpochs.epochStart, start), lte(biometricEpochs.epochStart, end), eq(biometricEpochs.worn, true)))
    .groupBy(sql`1`)
    .orderBy(sql`1`)
    .all()
    .filter((r) => r.mean !== null)
    .map((r) => ({ t: r.bucket, mean: r.mean, min: r.min ?? r.mean, max: r.max ?? r.mean }));
}

export function dayView(db: OpenPulseDb, date: string): DayView {
  const rows = db.select().from(dailySummaries).where(eq(dailySummaries.date, date)).all();
  return {
    date,
    summary: rows.find((r) => r.source === 'openpulse') ?? null,
    imported: rows.find((r) => r.source === 'whoop_csv') ?? rows.find((r) => r.source === 'apple_health') ?? null,
  };
}

/** The most recent date that has an OpenPulse summary (falls back to today). */
export function latestDataDate(db: OpenPulseDb): string {
  const row = db
    .select({ date: dailySummaries.date })
    .from(dailySummaries)
    .where(eq(dailySummaries.source, 'openpulse'))
    .orderBy(desc(dailySummaries.date))
    .limit(1)
    .get();
  return row?.date ?? today(db);
}

export interface BaselinePoint {
  date: string;
  lnMean: number | null;
  lnSd: number | null;
  rhrMean: number | null;
  rhrSd: number | null;
}

export function baselineHistory(db: OpenPulseDb, from: string, to: string): BaselinePoint[] {
  const rows = db
    .select()
    .from(userBaseline)
    .where(and(gte(userBaseline.date, from), lte(userBaseline.date, to), inArray(userBaseline.metric, ['ln_rmssd', 'resting_hr'])))
    .orderBy(asc(userBaseline.date))
    .all();
  const byDate = new Map<string, BaselinePoint>();
  for (const r of rows) {
    const point = byDate.get(r.date) ?? { date: r.date, lnMean: null, lnSd: null, rhrMean: null, rhrSd: null };
    if (r.metric === 'ln_rmssd') {
      point.lnMean = r.mean;
      point.lnSd = r.sd;
    } else {
      point.rhrMean = r.mean;
      point.rhrSd = r.sd;
    }
    byDate.set(r.date, point);
  }
  return [...byDate.values()];
}

/** True when the day's heart-rate samples came from the simulator. */
export function isSimulatedDay(db: OpenPulseDb, date: string, timeZone: string): boolean {
  const { start, end } = dayRange(date, timeZone);
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(hrRrSamples)
    .where(and(eq(hrRrSamples.source, 'simulated'), gte(hrRrSamples.ts, start - 12 * 3_600_000), lte(hrRrSamples.ts, end)))
    .get();
  return (row?.n ?? 0) > 0;
}

export function overview(db: OpenPulseDb, date: string) {
  const settings = getSettings(db);
  const from = addDays(date, -27);
  const range = dayRange(date, settings.timeZone);
  return {
    range,
    stressEnd: Math.min(range.end, Date.now()),
    simulated: isSimulatedDay(db, date, settings.timeZone),
    baselineHistory: baselineHistory(db, from, date),
    date,
    settings: publicSettings(settings),
    day: dayView(db, date),
    trend: summariesBetween(db, from, date),
    importedTrend: summariesBetween(db, from, date, 'whoop_csv'),
    baselines: latestBaselines(db, date),
    sleep: mainSleep(db, date),
    naps: napsOn(db, date),
    workouts: workoutsBetween(db, date, date),
    stress: stressForDay(db, date, settings.timeZone),
    heartRate: heartRateForDay(db, date, settings.timeZone),
    device: db.select().from(devices).orderBy(desc(devices.lastSeenAt)).limit(1).get() ?? null,
  };
}

export function sleepView(db: OpenPulseDb, date: string) {
  const settings = getSettings(db);
  const session = mainSleep(db, date);
  const recent = db
    .select()
    .from(sleepSessions)
    .where(and(eq(sleepSessions.isNap, false), gte(sleepSessions.date, addDays(date, -13)), lte(sleepSessions.date, date), inArray(sleepSessions.source, ['openpulse', 'whoop_csv', 'apple_health'])))
    .orderBy(asc(sleepSessions.date))
    .all();
  const byDate = new Map<string, SleepSessionRow>();
  const order = ['openpulse', 'whoop_csv', 'apple_health'];
  for (const s of recent) {
    const existing = byDate.get(s.date);
    if (!existing || order.indexOf(s.source) < order.indexOf(existing.source)) byDate.set(s.date, s);
  }
  return {
    date,
    timeZone: settings.timeZone,
    session,
    epochs: session && session.source === 'openpulse' ? sessionEpochs(db, session) : [],
    naps: napsOn(db, date),
    recent: [...byDate.values()],
    summary: dayView(db, date).summary,
  };
}

export function deviceView(db: OpenPulseDb) {
  const settings: AppSettings = getSettings(db);
  return {
    settings: publicSettings(settings),
    devices: db.select().from(devices).orderBy(desc(devices.lastSeenAt)).all(),
    statuses: rawPacketStatusCounts(db),
    stale: stalePacketCount(db),
    total: db.select({ n: sql<number>`count(*)` }).from(rawPackets).get()?.n ?? 0,
    recent: db.select().from(rawPackets).orderBy(desc(rawPackets.id)).limit(60).all(),
    imports: db.select().from(importRuns).orderBy(desc(importRuns.id)).limit(10).all(),
  };
}
