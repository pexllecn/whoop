import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { loadHrSamples, recomputeRange } from '@/lib/pipeline/dailyProcessor';
import { seedSimulatedHistory } from '@/lib/simulation/seed';
import { biometricEpochs, dailySummaries, hrRrSamples, sleepSessions, userBaseline, workouts } from '@/lib/storage/schema';
import { DEFAULT_SETTINGS } from '@/lib/storage/settings';
import { memoryDb } from '../helpers/db';

const TZ = 'Europe/Berlin';
const SETTINGS = { ...DEFAULT_SETTINGS, timeZone: TZ, profile: { ...DEFAULT_SETTINGS.profile, age: 34, maxHrOverride: 188 } };
const NOW = Date.UTC(2026, 9, 4, 22, 30); // late on 2026-10-04 local

function seededDb(days = 6) {
  const db = memoryDb();
  seedSimulatedHistory(db, { endDate: '2026-10-04', days, timeZone: TZ, until: NOW, seed: 21 });
  return db;
}

const count = (db: ReturnType<typeof memoryDb>, table: typeof dailySummaries | typeof sleepSessions | typeof workouts | typeof biometricEpochs | typeof userBaseline) =>
  db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;

describe('daily processor on simulated history', () => {
  const db = seededDb();
  const results = recomputeRange({ db, settings: SETTINGS, now: NOW }, '2026-09-29', '2026-10-04');

  it('scores every day', () => {
    expect(results.map((r) => r.hasData)).toEqual([true, true, true, true, true, true]);
    expect(count(db, dailySummaries)).toBe(6);
  });

  it('finds one main sleep per night', () => {
    const mains = db.select().from(sleepSessions).where(eq(sleepSessions.isNap, false)).all();
    expect(mains.map((s) => s.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    for (const s of mains) {
      expect((s.lightMs! + s.deepMs! + s.remMs!) / 3_600_000).toBeGreaterThan(6);
      expect(s.overnightRmssd).toBeGreaterThan(30);
      expect(s.restingHr).toBeGreaterThan(40);
    }
  });

  it('starts calibrating, then produces recovery scores within 0-100', () => {
    const days = db.select().from(dailySummaries).orderBy(dailySummaries.date).all();
    expect(days[0]!.recovery).toBeNull(); // no baseline yet on day one
    expect(days[1]!.calibrating).toBe(true);
    for (const d of days.slice(1)) {
      expect(d.recovery).not.toBeNull();
      expect(d.recovery!).toBeGreaterThanOrEqual(0);
      expect(d.recovery!).toBeLessThanOrEqual(100);
      expect(JSON.parse(d.recoveryInputs!)).toHaveProperty('zHrv');
    }
    expect(days[5]!.calibrating).toBe(false);
  });

  it('computes strain on the 0-21 scale and detects workouts on training days', () => {
    const days = db.select().from(dailySummaries).orderBy(dailySummaries.date).all();
    for (const d of days) {
      expect(d.dayStrain!).toBeGreaterThan(2);
      expect(d.dayStrain!).toBeLessThanOrEqual(21);
    }
    const detected = db.select().from(workouts).where(eq(workouts.source, 'openpulse')).all();
    expect(detected.length).toBeGreaterThanOrEqual(2);
    expect(detected.every((w) => w.strain! > 5)).toBe(true);
  });

  it('writes epochs with stages and baselines', () => {
    const staged = db.select({ n: sql<number>`count(*)` }).from(biometricEpochs).where(sql`${biometricEpochs.stage} is not null`).get()!.n;
    expect(staged).toBeGreaterThan(5 * 6 * 120);
    const ln = db.select().from(userBaseline).where(eq(userBaseline.metric, 'ln_rmssd')).orderBy(userBaseline.date).all();
    expect(ln).toHaveLength(6);
    expect(ln[5]!.n).toBe(6);
  });

  it('is idempotent', () => {
    const before = [count(db, dailySummaries), count(db, sleepSessions), count(db, workouts), count(db, biometricEpochs)];
    const again = recomputeRange({ db, settings: SETTINGS, now: NOW }, '2026-09-29', '2026-10-04');
    expect([count(db, dailySummaries), count(db, sleepSessions), count(db, workouts), count(db, biometricEpochs)]).toEqual(before);
    expect(again.map((r) => r.recovery?.score)).toEqual(results.map((r) => r.recovery?.score));
  });

  it('never scores from sparse Apple Health heart rate', () => {
    db.insert(hrRrSamples).values({ ts: NOW - 3600_000, bpm: 99, rrMs: '[]', rrCount: 0, source: 'apple_health' }).run();
    expect(loadHrSamples(db, NOW - 7200_000, NOW).some((r) => r.source === 'apple_health')).toBe(false);
  });
});

describe('baseline bootstrap from imported WHOOP history', () => {
  it('feeds imported HRV/RHR into baselines on days without strap data', () => {
    const db = memoryDb();
    for (const [date, hrv, rhr] of [['2026-09-01', 60, 52], ['2026-09-02', 64, 51], ['2026-09-03', 58, 53]] as const) {
      db.insert(dailySummaries).values({ date, source: 'whoop_csv', hrvRmssd: hrv, restingHr: rhr, calibrating: false, updatedAt: 0 }).run();
    }
    recomputeRange({ db, settings: SETTINGS, now: NOW }, '2026-09-01', '2026-09-03');
    const row = db.select().from(userBaseline).where(and(eq(userBaseline.metric, 'ln_rmssd'), eq(userBaseline.date, '2026-09-03'))).get()!;
    expect(row.n).toBe(3);
    expect(row.source).toBe('whoop_csv');
    expect(row.mean).toBeCloseTo((Math.log(60) + Math.log(64) + Math.log(58)) / 3, 9);
    expect(count(db, dailySummaries)).toBe(3); // no openpulse summaries without strap data
  });
});
