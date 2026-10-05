/**
 * Seeds simulated history (heart rate + R-R at 1 Hz, motion every 5 s) for
 * demos and tests. Rows are stored with source 'simulated' so they can never
 * be mistaken for strap data, and `clearSimulatedData` removes them.
 */
import { eq, inArray } from 'drizzle-orm';
import type { OpenPulseDb } from '../storage/db';
import { biometricEpochs, dailySummaries, hrRrSamples, motionSamples, sleepSessions, userBaseline, workouts } from '../storage/schema';
import { DAY_MS, HOUR_MS, addDays, dateKey, startOfDay } from '../time';
import { DEFAULT_SIM_PROFILE, PhysiologySimulator, beatsToNotifications, planRange, type SimProfile } from './physiologySimulator';

export interface SeedOptions {
  /** Last day to simulate (defaults to today in `timeZone`). */
  endDate?: string;
  days: number;
  timeZone: string;
  seed?: number;
  profile?: SimProfile;
  /** Stop generating at this instant (defaults to now). */
  until?: number;
  onDay?: (date: string) => void;
}

export interface SeedReport {
  from: number;
  to: number;
  heartRateRows: number;
  motionRows: number;
  simulator: PhysiologySimulator;
}

export function seedSimulatedHistory(db: OpenPulseDb, options: SeedOptions): SeedReport {
  const until = options.until ?? Date.now();
  const endDate = options.endDate ?? dateKey(until, options.timeZone);
  const startDate = addDays(endDate, -(options.days - 1));
  const seed = options.seed ?? 7;
  const plans = planRange(addDays(startDate, -1), addDays(endDate, 1), seed);
  const simulator = new PhysiologySimulator(plans, options.profile ?? DEFAULT_SIM_PROFILE, options.timeZone, seed);

  const from = startOfDay(startDate, options.timeZone) - 12 * HOUR_MS;
  const to = Math.min(until, startOfDay(addDays(endDate, 1), options.timeZone));
  const insertHr = db.$client.prepare(
    "INSERT INTO hr_rr_samples (ts, bpm, rr_ms, rr_count, source) VALUES (?, ?, ?, ?, 'simulated')",
  );
  const insertMotion = db.$client.prepare(
    "INSERT INTO motion_samples (ts, activity_g, sample_count, source) VALUES (?, ?, 1, 'simulated')",
  );

  let heartRateRows = 0;
  let motionRows = 0;
  for (let chunkStart = from; chunkStart < to; chunkStart += 6 * HOUR_MS) {
    const chunkEnd = Math.min(to, chunkStart + 6 * HOUR_MS);
    const beats = simulator.beats(chunkStart, chunkEnd);
    const notifications = beatsToNotifications(beats, chunkStart, chunkEnd);
    const motion = simulator.motion(chunkStart, chunkEnd, 5000);
    db.$client.transaction(() => {
      for (const n of notifications) {
        insertHr.run(n.t, n.bpm, JSON.stringify(n.rr.map((r) => Math.round(r * 1000) / 1000)), n.rr.length);
      }
      for (const m of motion) insertMotion.run(m.t, Math.round(m.activity * 10000) / 10000);
    })();
    heartRateRows += notifications.length;
    motionRows += motion.length;
    if ((chunkEnd - from) % DAY_MS === 0) options.onDay?.(dateKey(chunkEnd - 1, options.timeZone));
  }
  return { from, to, heartRateRows, motionRows, simulator };
}

/** Remove simulated samples and everything derived from the days they cover. */
export function clearSimulatedData(db: OpenPulseDb): void {
  db.transaction((tx) => {
    tx.delete(hrRrSamples).where(eq(hrRrSamples.source, 'simulated')).run();
    tx.delete(motionSamples).where(eq(motionSamples.source, 'simulated')).run();
    tx.delete(biometricEpochs).run();
    tx.delete(sleepSessions).where(eq(sleepSessions.source, 'openpulse')).run();
    tx.delete(workouts).where(eq(workouts.source, 'openpulse')).run();
    tx.delete(dailySummaries).where(inArray(dailySummaries.source, ['openpulse'])).run();
    tx.delete(userBaseline).run();
  });
}
