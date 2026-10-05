/**
 * Builds the structured biometric context given to the AI coach. Only derived
 * daily metrics are included: no raw samples, no names, no device serials.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { OpenPulseDb } from '../storage/db';
import { dailySummaries, sleepSessions, workouts } from '../storage/schema';
import { effectiveMaxHr, getSettings } from '../storage/settings';
import { addDays, dateKey } from '../time';
import { latestBaselines, latestDataDate } from '../queries';

const r = (v: number | null | undefined, digits = 1) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const avg = (values: Array<number | null>) => {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
};
const hours = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : r(ms / 3_600_000, 2));

export interface CoachContext {
  generated_at: string;
  date: string;
  time_zone: string;
  provenance: string;
  profile: { age: number; sex: string; max_hr_bpm: number; baseline_sleep_need_h: number };
  today: Record<string, number | string | boolean | null>;
  baselines: Record<string, number | null>;
  averages: Record<string, number | null>;
  last_14_days: Array<Record<string, number | string | null>>;
  latest_sleep: Record<string, number | string | null> | null;
  recent_workouts: Array<Record<string, number | string | null>>;
  flags: string[];
}

export function buildCoachContext(db: OpenPulseDb, date = latestDataDate(db)): CoachContext {
  const settings = getSettings(db);
  const days = db
    .select()
    .from(dailySummaries)
    .where(and(eq(dailySummaries.source, 'openpulse'), gte(dailySummaries.date, addDays(date, -27)), lte(dailySummaries.date, date)))
    .orderBy(desc(dailySummaries.date))
    .all();
  const today = days.find((d) => d.date === date) ?? null;
  const last7 = days.filter((d) => d.date > addDays(date, -7));
  const baselines = latestBaselines(db, date);
  const sleep = db
    .select()
    .from(sleepSessions)
    .where(and(eq(sleepSessions.isNap, false), lte(sleepSessions.date, date)))
    .orderBy(desc(sleepSessions.date))
    .limit(1)
    .get();
  const recentWorkouts = db
    .select()
    .from(workouts)
    .where(and(gte(workouts.date, addDays(date, -6)), lte(workouts.date, date)))
    .orderBy(desc(workouts.startTs))
    .limit(10)
    .all();

  const acute = avg(last7.map((d) => d.dayStrain));
  const chronic = avg(days.map((d) => d.dayStrain));
  const flags: string[] = [];
  if (today?.calibrating) flags.push('Baselines are still calibrating (fewer than 4 nights); treat recovery as provisional.');
  const inputs = today?.recoveryInputs ? (JSON.parse(today.recoveryInputs) as { zHrv?: number; zRhr?: number | null; zResp?: number | null }) : null;
  if (inputs?.zHrv !== undefined && inputs.zHrv < -1.5) flags.push(`Overnight HRV is well below baseline (z = ${r(inputs.zHrv, 2)}).`);
  if (inputs?.zRhr != null && inputs.zRhr < -1.5) flags.push(`Resting heart rate is well above baseline (z = ${r(-inputs.zRhr, 2)}).`);
  if (inputs?.zResp != null && inputs.zResp > 1.5) flags.push(`Respiratory rate is elevated versus baseline (z = ${r(inputs.zResp, 2)}).`);
  if (today?.sleepDebtMs && today.sleepDebtMs > 60 * 60_000) flags.push(`Carrying about ${hours(today.sleepDebtMs)} h of sleep debt.`);
  if (acute !== null && chronic !== null && chronic > 0 && acute / chronic > 1.3) flags.push(`7-day strain is ${r(acute / chronic, 2)}x the 28-day average (rapid load increase).`);
  if (!today) flags.push('No OpenPulse summary exists for this date yet.');

  return {
    generated_at: new Date().toISOString(),
    date,
    time_zone: settings.timeZone,
    provenance:
      'All scores are OpenPulse estimates computed locally from the strap’s heart rate and R-R intervals (recovery = sigmoid of HRV/RHR z-scores against 30-day EWMA baselines, 67 % at baseline; strain = 4.1·ln(1+0.315·L), L = Banister TRIMP above 30 % HRR, 0–21). They are not WHOOP’s proprietary scores and not medical measurements.',
    profile: { age: settings.profile.age, sex: settings.profile.sex, max_hr_bpm: effectiveMaxHr(settings.profile), baseline_sleep_need_h: settings.profile.baselineSleepNeedHours },
    today: today
      ? {
          recovery_pct: r(today.recovery, 0),
          calibrating: today.calibrating,
          hrv_rmssd_ms: r(today.hrvRmssd, 0),
          resting_hr_bpm: r(today.restingHr, 0),
          respiratory_rate_rpm: r(today.respRate, 1),
          day_strain: r(today.dayStrain, 1),
          day_trimp: r(today.dayTrimp, 0),
          energy_kcal: r(today.kcal, 0),
          sleep_performance_pct: r(today.sleepPerformance, 0),
          sleep_asleep_h: hours(today.sleepActualMs),
          sleep_need_h: hours(today.sleepNeedMs),
          sleep_debt_h: hours(today.sleepDebtMs),
          stress_avg_0_3: r(today.stressAvg, 2),
          stress_high_minutes: r(today.stressHighMinutes, 0),
          is_today: date === dateKey(Date.now(), settings.timeZone),
        }
      : {},
    baselines: {
      hrv_rmssd_ms: baselines.lnRmssd ? r(Math.exp(baselines.lnRmssd.mean), 0) : null,
      resting_hr_bpm: r(baselines.restingHr?.mean, 1),
      respiratory_rate_rpm: r(baselines.respRate?.mean, 1),
      nights_in_baseline: baselines.lnRmssd?.n ?? 0,
    },
    averages: {
      recovery_7d: r(avg(last7.map((d) => d.recovery)), 0),
      recovery_28d: r(avg(days.map((d) => d.recovery)), 0),
      strain_7d: r(acute, 1),
      strain_28d: r(chronic, 1),
      acute_chronic_strain_ratio: acute !== null && chronic ? r(acute / chronic, 2) : null,
      sleep_asleep_7d_h: hours(avg(last7.map((d) => d.sleepActualMs))),
      hrv_7d_ms: r(avg(last7.map((d) => d.hrvRmssd)), 0),
    },
    last_14_days: days.slice(0, 14).map((d) => ({
      date: d.date,
      recovery_pct: r(d.recovery, 0),
      strain: r(d.dayStrain, 1),
      hrv_ms: r(d.hrvRmssd, 0),
      rhr_bpm: r(d.restingHr, 0),
      sleep_h: hours(d.sleepActualMs),
      sleep_perf_pct: r(d.sleepPerformance, 0),
      stress_avg: r(d.stressAvg, 2),
    })),
    latest_sleep: sleep
      ? {
          date: sleep.date,
          source: sleep.source,
          in_bed_h: hours(sleep.inBedMs),
          asleep_h: hours((sleep.lightMs ?? 0) + (sleep.deepMs ?? 0) + (sleep.remMs ?? 0)),
          deep_h: hours(sleep.deepMs),
          rem_h: hours(sleep.remMs),
          light_h: hours(sleep.lightMs),
          awake_h: hours(sleep.awakeMs),
          efficiency_pct: r(sleep.efficiency, 0),
          disturbances: sleep.disturbances,
          consistency_pct: r(sleep.consistency, 0),
        }
      : null,
    recent_workouts: recentWorkouts.map((w) => ({
      date: w.date,
      activity: w.sport,
      minutes: r((w.endTs - w.startTs) / 60_000, 0),
      strain: r(w.strain, 1),
      avg_hr: r(w.avgHr, 0),
      max_hr: r(w.maxHr, 0),
      source: w.source,
    })),
    flags,
  };
}
