/**
 * Daily processor: turns stored samples into epochs, sleep sessions, detected
 * workouts, daily summaries and baselines. Days are processed in order so the
 * 30-day baselines chain correctly: the score for day D always uses the
 * baseline as it stood at the end of D - 1.
 *
 * A day's analysis window starts at 12:00 the previous day so the night that
 * ends on D is fully visible; recovery belongs to the day you wake up on.
 */
import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { BASELINE_ALPHA, type BaselineMetric, type BaselineState, stateFromStored, toBaseline, updateBaseline } from '../physiology/baseline';
import { buildEpochs, EPOCH_MS, prepareSeries, type Epoch, type HrSampleInput, type MotionInput } from '../physiology/epochs';
import { energyKcal } from '../physiology/energy';
import { overnightHrv, type StageSpan } from '../physiology/hrv';
import { computeRecovery, type RecoveryResult } from '../physiology/recovery';
import { respiratoryRateOverPeriod } from '../physiology/respiration';
import { detectSleepPeriods, restingHrFromSleep, stageSleep, type SleepPeriod, type SleepStaging } from '../physiology/sleepClassifier';
import { computeSleepNeed, sleepConsistency, sleepPerformance } from '../physiology/sleepNeed';
import { median, quantile } from '../physiology/stats';
import { stressTimeline, type StressPoint } from '../physiology/stressMonitor';
import { computeLoad, strainFromLoad } from '../physiology/strain';
import { detectWorkouts } from '../physiology/workoutDetector';
import type { OpenPulseDb } from '../storage/db';
import { biometricEpochs, dailySummaries, hrRrSamples, motionSamples, sleepSessions, userBaseline, workouts } from '../storage/schema';
import { effectiveMaxHr, type AppSettings } from '../storage/settings';
import { HOUR_MS, addDays, dateKey, enumerateDays, startOfDay } from '../time';

const METRICS: BaselineMetric[] = ['ln_rmssd', 'resting_hr', 'resp_rate', 'skin_temp', 'day_rest_hr', 'day_ln_rmssd'];

export interface ProcessorContext {
  db: OpenPulseDb;
  settings: AppSettings;
  now?: number;
}

export interface DayResult {
  date: string;
  hasData: boolean;
  wornMinutes: number;
  recovery: RecoveryResult | null;
  dayStrain: number | null;
  sleep: { start: number; end: number; asleepMs: number; performance: number } | null;
  naps: number;
  workouts: number;
  stressAvg: number | null;
}

type BaselineStates = Map<BaselineMetric, BaselineState>;

/**
 * Samples used for scoring. Apple Health heart rate is excluded: it is sampled
 * every few minutes, far too sparse for epochs, sleep staging or strain.
 */
export function loadHrSamples(db: OpenPulseDb, from: number, to: number): HrSampleInput[] {
  return db
    .select({ ts: hrRrSamples.ts, bpm: hrRrSamples.bpm, rrMs: hrRrSamples.rrMs, source: hrRrSamples.source })
    .from(hrRrSamples)
    .where(and(gte(hrRrSamples.ts, from), lt(hrRrSamples.ts, to), ne(hrRrSamples.source, 'apple_health')))
    .orderBy(hrRrSamples.ts)
    .all()
    .map((r) => ({ ts: r.ts, bpm: r.bpm, rr: r.rrMs === '[]' ? [] : (JSON.parse(r.rrMs) as number[]), source: r.source }));
}

export function loadMotion(db: OpenPulseDb, from: number, to: number): MotionInput[] {
  return db
    .select({ ts: motionSamples.ts, activity: motionSamples.activityG })
    .from(motionSamples)
    .where(and(gte(motionSamples.ts, from), lt(motionSamples.ts, to)))
    .orderBy(motionSamples.ts)
    .all();
}

/** Latest stored baseline state per metric strictly before `date`. */
export function loadBaselineStates(db: OpenPulseDb, date: string): BaselineStates {
  const states: BaselineStates = new Map();
  for (const metric of METRICS) {
    const row = db
      .select()
      .from(userBaseline)
      .where(and(eq(userBaseline.metric, metric), lt(userBaseline.date, date)))
      .orderBy(desc(userBaseline.date))
      .limit(1)
      .get();
    if (row) states.set(metric, stateFromStored(metric, row));
  }
  return states;
}

function baselineOf(states: BaselineStates, metric: BaselineMetric) {
  return toBaseline(metric, states.get(metric) ?? null);
}

function epochsIn(epochs: readonly Epoch[], start: number, end: number): Epoch[] {
  return epochs.filter((e) => e.start >= start && e.start < end);
}

interface StagedPeriod {
  period: SleepPeriod;
  staging: SleepStaging;
  isNap: boolean;
}

export function processDay(ctx: ProcessorContext, date: string, states: BaselineStates): DayResult {
  const { db, settings } = ctx;
  const now = ctx.now ?? Date.now();
  const tz = settings.timeZone;
  const profile = settings.profile;
  const maxHr = effectiveMaxHr(profile);
  const dayStart = startOfDay(date, tz);
  const dayEnd = startOfDay(addDays(date, 1), tz);
  const windowStart = dayStart - 12 * HOUR_MS;
  const windowEnd = Math.min(dayEnd, now);
  const empty: DayResult = { date, hasData: false, wornMinutes: 0, recovery: null, dayStrain: null, sleep: null, naps: 0, workouts: 0, stressAvg: null };
  if (windowEnd <= dayStart) return empty;

  const series = prepareSeries(loadHrSamples(db, windowStart, windowEnd), loadMotion(db, windowStart, windowEnd), {
    includeHistoricalRr: settings.daemon.useHistoricalRr,
  });
  const epochs = buildEpochs(windowStart, windowEnd, series);
  const dayEpochs = epochsIn(epochs, dayStart, windowEnd);
  const wornMinutes = (dayEpochs.filter((e) => e.worn).length * EPOCH_MS) / 60_000;

  const lnBaseline = baselineOf(states, 'ln_rmssd');
  const rhrBaseline = baselineOf(states, 'resting_hr');

  // ---------------------------------------------------------------- sleep
  const periods = detectSleepPeriods(epochs, { restingHr: rhrBaseline?.mean ?? null });
  const mainCandidates = periods.filter((p) => p.end > dayStart && p.end <= dayStart + 15 * HOUR_MS && p.end - p.start >= 2 * HOUR_MS);
  const main = mainCandidates.sort((a, b) => b.end - b.start - (a.end - a.start))[0] ?? null;
  // Naps: daytime (08:00-21:00) sleep of at most 3 h that is complete, i.e. not
  // the start of tonight's sleep cut off at the end of the window.
  const naps = periods.filter(
    (p) =>
      p !== main &&
      p.start >= dayStart + 8 * HOUR_MS &&
      p.end <= dayStart + 21 * HOUR_MS &&
      p.end < windowEnd - 5 * 60_000 &&
      p.end - p.start <= 3 * HOUR_MS &&
      (!main || p.start >= main.end),
  );
  const staged: StagedPeriod[] = [main, ...naps]
    .filter((p): p is SleepPeriod => p !== null)
    .map((period) => ({ period, staging: stageSleep(epochsIn(epochs, period.start, period.end), series.beats), isNap: period !== main }));
  const mainStaged = staged.find((s) => !s.isNap) ?? null;

  let hrv: ReturnType<typeof overnightHrv> = null;
  let restingHr: number | null = null;
  let respRate: number | null = null;
  let need: ReturnType<typeof computeSleepNeed> | null = null;
  let performance: number | null = null;
  let consistency: number | null = null;

  if (main && mainStaged) {
    hrv = overnightHrv(series.beats, main.start, main.end, mainStaged.staging.spans);
    restingHr = restingHrFromSleep(epochsIn(epochs, main.start, main.end));
    respRate = respiratoryRateOverPeriod(series.beats, main.start, main.end);
    const previous = db
      .select()
      .from(sleepSessions)
      .where(and(eq(sleepSessions.source, 'openpulse'), eq(sleepSessions.isNap, false), lt(sleepSessions.date, date)))
      .orderBy(desc(sleepSessions.date))
      .limit(4)
      .all();
    const prior = db
      .select({ dayStrain: dailySummaries.dayStrain })
      .from(dailySummaries)
      .where(and(eq(dailySummaries.date, addDays(date, -1)), eq(dailySummaries.source, 'openpulse')))
      .get();
    need = computeSleepNeed({
      baselineHours: profile.baselineSleepNeedHours,
      priorDayStrain: prior?.dayStrain ?? null,
      previousNights: previous.slice(0, 3).map((s) => ({
        needMs: s.needMs,
        actualMs: (s.lightMs ?? 0) + (s.deepMs ?? 0) + (s.remMs ?? 0),
      })),
    });
    performance = sleepPerformance(mainStaged.staging.summary.asleepMs, need.needMs);
    consistency = sleepConsistency({ start: main.start, end: main.end }, previous.map((s) => ({ start: s.startTs, end: s.endTs })), tz);
  }

  // ------------------------------------------------------------- recovery
  const recovery = computeRecovery(
    { lnRmssd: hrv?.lnRmssd ?? null, restingHr, sleepPerformance: performance, respRate, skinTempC: null },
    { lnRmssd: lnBaseline, restingHr: rhrBaseline, respRate: baselineOf(states, 'resp_rate'), skinTemp: baselineOf(states, 'skin_temp') },
  );

  // --------------------------------------------------------------- strain
  const restForStrain = rhrBaseline?.mean ?? restingHr ?? quantile(series.hr.map((s) => s.hr), 0.05) ?? 60;
  const strainParams = { restingHr: restForStrain, maxHr, sex: profile.sex };
  const dayHr = series.hr.filter((s) => s.t >= dayStart && s.t < windowEnd);
  const load = dayHr.length ? computeLoad(dayHr, strainParams) : null;
  const dayStrain = load ? strainFromLoad(load.load) : null;
  const activeThreshold = restForStrain + 0.3 * (maxHr - restForStrain);
  const energyProfile = { sex: profile.sex, age: profile.age, weightKg: profile.weightKg, heightCm: profile.heightCm };
  const kcal = dayHr.length ? energyKcal(dayHr, windowEnd - dayStart, energyProfile, activeThreshold) : null;
  const sleepWindows = periods.map((p) => ({ start: p.start, end: p.end }));
  const detected = detectWorkouts(dayHr, series.motion, strainParams, energyProfile, sleepWindows);

  // --------------------------------------------------------------- stress
  const dayLnState = baselineOf(states, 'day_ln_rmssd');
  const stressPoints: StressPoint[] = dayHr.length
    ? stressTimeline(
        series,
        dayStart,
        windowEnd,
        {
          restingHr: restForStrain,
          maxHr,
          dayRestHr: baselineOf(states, 'day_rest_hr')?.mean ?? restForStrain + 15,
          dayLnRmssd: dayLnState?.mean ?? (lnBaseline ? lnBaseline.mean - 0.6 : Math.log(30)),
          dayLnRmssdSd: dayLnState?.sd ?? 0.3,
        },
        sleepWindows,
      )
    : [];
  const scored = stressPoints.filter((p) => p.score !== null);
  const stressAvg = scored.length ? scored.reduce((s, p) => s + p.score!, 0) / scored.length : null;
  const stressMax = scored.length ? Math.max(...scored.map((p) => p.score!)) : null;
  const stressHighMinutes = scored.filter((p) => p.score! >= 2).length;

  // ------------------------------------------------------------ baselines
  let observationSource = 'openpulse';
  let lnObservation = hrv?.lnRmssd ?? null;
  let rhrObservation = restingHr;
  if (lnObservation === null) {
    const imported = db
      .select({ hrv: dailySummaries.hrvRmssd, rhr: dailySummaries.restingHr })
      .from(dailySummaries)
      .where(and(eq(dailySummaries.date, date), eq(dailySummaries.source, 'whoop_csv')))
      .get();
    if (imported?.hrv && imported.hrv > 0) {
      lnObservation = Math.log(imported.hrv);
      rhrObservation = imported.rhr ?? rhrObservation;
      observationSource = 'whoop_csv';
    }
  }
  const observations: Partial<Record<BaselineMetric, number | null>> = {
    ln_rmssd: lnObservation,
    resting_hr: rhrObservation,
    resp_rate: respRate,
    day_rest_hr: median(scored.map((p) => p.hr60!).filter((v) => v !== null)),
    day_ln_rmssd: median(scored.map((p) => p.lnRmssd60).filter((v): v is number => v !== null)),
  };
  for (const metric of METRICS) {
    const value = observations[metric];
    if (value !== null && value !== undefined && Number.isFinite(value)) states.set(metric, updateBaseline(states.get(metric) ?? null, value, BASELINE_ALPHA));
  }

  // --------------------------------------------------------------- writes
  const hasData = wornMinutes > 0 || main !== null;
  const computedAt = Date.now();
  db.transaction((tx) => {
    // Epochs: full replace for the day itself; for the previous evening only refresh sleep labels.
    tx.delete(biometricEpochs).where(and(gte(biometricEpochs.epochStart, dayStart), lt(biometricEpochs.epochStart, dayEnd))).run();
    tx.delete(sleepSessions).where(and(eq(sleepSessions.source, 'openpulse'), eq(sleepSessions.date, date))).run();
    tx.delete(workouts).where(and(eq(workouts.source, 'openpulse'), eq(workouts.date, date))).run();

    const stageByEpoch = new Map<number, { stage: string; sessionId: number }>();
    for (const s of staged) {
      const summary = s.staging.summary;
      const isMain = !s.isNap;
      const sessionValues = {
        source: 'openpulse',
        externalId: `openpulse:${s.period.start}`,
        date,
        startTs: s.period.start,
        endTs: s.period.end,
        isNap: s.isNap,
        inBedMs: summary.inBedMs,
        awakeMs: summary.awakeMs,
        lightMs: summary.lightMs,
        deepMs: summary.deepMs,
        remMs: summary.remMs,
        noDataMs: summary.noDataMs,
        efficiency: summary.efficiency,
        disturbances: summary.disturbances,
        respRate: isMain ? respRate : null,
        overnightRmssd: isMain ? (hrv?.rmssd ?? null) : null,
        restingHr: isMain ? restingHr : null,
        performance: isMain ? performance : null,
        consistency: isMain ? consistency : null,
        needMs: isMain ? (need?.needMs ?? null) : null,
        needBaselineMs: isMain ? (need?.baselineMs ?? null) : null,
        needStrainMs: isMain ? (need?.strainMs ?? null) : null,
        needDebtMs: isMain ? (need?.debtMs ?? null) : null,
        computedAt,
      };
      const inserted = tx
        .insert(sleepSessions)
        .values(sessionValues)
        .onConflictDoUpdate({ target: [sleepSessions.source, sleepSessions.externalId], set: sessionValues })
        .returning({ id: sleepSessions.id })
        .get();
      const periodEpochs = epochsIn(epochs, s.period.start, s.period.end);
      periodEpochs.forEach((e, i) => {
        const stage = s.staging.stages[i];
        if (stage) stageByEpoch.set(e.start, { stage, sessionId: inserted.id });
      });
    }

    const stressByEpoch = new Map<number, number>();
    for (const p of stressPoints) {
      if (p.score === null) continue;
      stressByEpoch.set(p.t - 60_000, p.score);
      stressByEpoch.set(p.t - EPOCH_MS, p.score);
    }

    for (const e of epochs) {
      const label = stageByEpoch.get(e.start);
      if (e.start < dayStart) {
        if (label) {
          tx.update(biometricEpochs).set({ stage: label.stage, sleepSessionId: label.sessionId }).where(eq(biometricEpochs.epochStart, e.start)).run();
        }
        continue;
      }
      tx.insert(biometricEpochs)
        .values({
          epochStart: e.start,
          meanHr: e.meanHr,
          minHr: e.minHr,
          maxHr: e.maxHr,
          hrSd: e.hrSd,
          rrCount: e.rrCount,
          validRrCount: e.validRrCount,
          rmssd: e.rmssd,
          motion: e.motion,
          worn: e.worn,
          stage: label?.stage ?? null,
          sleepSessionId: label?.sessionId ?? null,
          stress: stressByEpoch.get(e.start) ?? null,
        })
        .onConflictDoNothing()
        .run();
    }

    for (const w of detected) {
      const workoutValues = {
        source: 'openpulse',
        externalId: `openpulse:${w.start}`,
        date,
        startTs: w.start,
        endTs: w.end,
        sport: w.label,
        strain: w.strain,
        avgHr: w.avgHr,
        maxHr: w.maxHr,
        kcal: w.kcal,
        trimp: w.trimp,
        edwardsLoad: w.edwards,
        zone0Ms: w.zoneMs[0],
        zone1Ms: w.zoneMs[1],
        zone2Ms: w.zoneMs[2],
        zone3Ms: w.zoneMs[3],
        zone4Ms: w.zoneMs[4],
        zone5Ms: w.zoneMs[5],
        computedAt,
        };
      tx.insert(workouts)
        .values(workoutValues)
        .onConflictDoUpdate({ target: [workouts.source, workouts.externalId], set: workoutValues })
        .run();
    }

    if (hasData) {
      const values = {
        date,
        source: 'openpulse',
        recovery: recovery ? Math.round(recovery.score * 10) / 10 : null,
        recoveryInputs: recovery
          ? JSON.stringify({
              ...recovery,
              hrvMethod: hrv?.method ?? null,
              inputs: { lnRmssd: hrv?.lnRmssd ?? null, restingHr, sleepPerformance: performance, respRate },
              baselines: { lnRmssd: lnBaseline, restingHr: rhrBaseline, respRate: baselineOf(states, 'resp_rate') },
            })
          : null,
        hrvRmssd: hrv?.rmssd ?? null,
        restingHr,
        respRate,
        skinTempC: null,
        skinTempDevC: recovery?.skinTempDevC ?? null,
        dayStrain,
        dayTrimp: load?.trimp ?? null,
        dayEdwards: load?.edwards ?? null,
        kcal,
        sleepPerformance: performance,
        sleepNeedMs: need?.needMs ?? null,
        sleepActualMs: mainStaged?.staging.summary.asleepMs ?? null,
        sleepDebtMs: need?.debtMs ?? null,
        sleepConsistency: consistency,
        sleepEfficiency: mainStaged?.staging.summary.efficiency ?? null,
        stressAvg,
        stressMax,
        stressHighMinutes,
        wornMinutes,
        calibrating: recovery ? recovery.calibrating : true,
        updatedAt: computedAt,
      };
      tx.insert(dailySummaries).values(values).onConflictDoUpdate({ target: [dailySummaries.date, dailySummaries.source], set: values }).run();
    } else {
      tx.delete(dailySummaries).where(and(eq(dailySummaries.date, date), eq(dailySummaries.source, 'openpulse'))).run();
    }

    tx.delete(userBaseline).where(eq(userBaseline.date, date)).run();
    for (const metric of METRICS) {
      const baseline = toBaseline(metric, states.get(metric) ?? null);
      if (!baseline) continue;
      tx.insert(userBaseline)
        .values({ date, metric, mean: baseline.mean, sd: baseline.sd, n: baseline.n, source: metric === 'ln_rmssd' || metric === 'resting_hr' ? observationSource : 'openpulse' })
        .run();
    }
  });

  return {
    date,
    hasData,
    wornMinutes,
    recovery,
    dayStrain,
    sleep: main && mainStaged ? { start: main.start, end: main.end, asleepMs: mainStaged.staging.summary.asleepMs, performance: performance ?? 0 } : null,
    naps: naps.length,
    workouts: detected.length,
    stressAvg,
  };
}

/** Recompute an inclusive date range in order, chaining baselines. */
export function recomputeRange(ctx: ProcessorContext, fromDate: string, toDate: string, onDay?: (result: DayResult) => void): DayResult[] {
  const states = loadBaselineStates(ctx.db, fromDate);
  const results: DayResult[] = [];
  for (const date of enumerateDays(fromDate, toDate)) {
    const result = processDay(ctx, date, states);
    results.push(result);
    onDay?.(result);
  }
  return results;
}

/** Recompute from the day containing `fromMs` up to today (later baselines depend on earlier days). */
export function recomputeFrom(ctx: ProcessorContext, fromMs: number, onDay?: (result: DayResult) => void): DayResult[] {
  const tz = ctx.settings.timeZone;
  const now = ctx.now ?? Date.now();
  // The night that ends on the next day starts the evening before, so include that day too.
  return recomputeRange(ctx, dateKey(fromMs, tz), dateKey(now, tz), onDay);
}

/** Earliest and latest sample timestamps, for full recomputes. */
export function sampleSpan(db: OpenPulseDb): { from: number; to: number } | null {
  const row = db.select({ lo: sql<number | null>`min(${hrRrSamples.ts})`, hi: sql<number | null>`max(${hrRrSamples.ts})` }).from(hrRrSamples).get();
  return row && row.lo !== null && row.hi !== null ? { from: row.lo, to: row.hi } : null;
}

export type { StageSpan };
