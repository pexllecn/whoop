import { describe, expect, it } from 'vitest';
import { buildEpochs, prepareSeries, reconstructBeats, BeatClock } from '@/lib/physiology/epochs';
import { detectSleepPeriods, restingHrFromSleep, stageSleep } from '@/lib/physiology/sleepClassifier';
import { computeSleepNeed, sleepConsistency, sleepPerformance } from '@/lib/physiology/sleepNeed';
import { scoreStress, stressLevel } from '@/lib/physiology/stressMonitor';
import { detectWorkouts } from '@/lib/physiology/workoutDetector';
import { DEFAULT_SIM_PROFILE, PhysiologySimulator, beatsToNotifications, planRange } from '@/lib/simulation/physiologySimulator';
import { HOUR_MS, MINUTE_MS, startOfDay } from '@/lib/time';

const TZ = 'UTC';

function simulatedWindow(seed: number, date: string) {
  const plans = planRange('2026-05-01', '2026-05-08', seed);
  const sim = new PhysiologySimulator(plans, DEFAULT_SIM_PROFILE, TZ, seed);
  const from = startOfDay(date, TZ) - 12 * HOUR_MS;
  const to = startOfDay(date, TZ) + 12 * HOUR_MS;
  const rows = beatsToNotifications(sim.beats(from, to), from, to).map((n) => ({ ts: n.t, bpm: n.bpm, rr: n.rr, source: 'simulated' }));
  const motion = sim.motion(from, to, 5000).map((m) => ({ ts: m.t, activity: m.activity }));
  const series = prepareSeries(rows, motion);
  return { sim, from, to, series, epochs: buildEpochs(from, to, series) };
}

describe('beat reconstruction', () => {
  it('chains R-R values across notifications into one continuous series', () => {
    const clock = new BeatClock();
    const a = clock.push(10_000, [900, 950], 'sig_hrm');
    const b = clock.push(11_000, [1000], 'sig_hrm');
    expect(b[0]!.t - a[1]!.t).toBe(1000);
    expect(a[1]!.t).toBe(10_000);
  });

  it('re-anchors after a gap or a source change', () => {
    const beats = reconstructBeats([
      { ts: 10_000, bpm: 60, rr: [1000], source: 'sig_hrm' },
      { ts: 60_000, bpm: 60, rr: [1000], source: 'sig_hrm' },
    ]);
    expect(beats.map((b) => b.t)).toEqual([10_000, 60_000]);
  });
});

describe('sleep detection and staging on simulated nights', () => {
  it.each([
    [1, '2026-05-03'],
    [2, '2026-05-04'],
    [3, '2026-05-05'],
  ])('finds the main sleep and stages it (seed %i, %s)', (seed, date) => {
    const { sim, epochs, series } = simulatedWindow(seed, date);
    const truth = sim.sleepWindow(date)!;
    const periods = detectSleepPeriods(epochs, { restingHr: DEFAULT_SIM_PROFILE.restingHr });
    const main = [...periods].sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
    expect(Math.abs(main.start - truth.start)).toBeLessThan(25 * MINUTE_MS);
    expect(Math.abs(main.end - truth.end)).toBeLessThan(25 * MINUTE_MS);

    const inPeriod = epochs.filter((e) => e.start >= main.start && e.start < main.end);
    const staging = stageSleep(inPeriod, series.beats);
    let agree = 0;
    let total = 0;
    inPeriod.forEach((e, i) => {
      const t = sim.trueStage(e.start + 15_000);
      if (!t) return;
      total++;
      if (t === staging.stages[i]) agree++;
    });
    expect(agree / total).toBeGreaterThan(0.8);
    expect(staging.summary.deepMs).toBeGreaterThan(30 * MINUTE_MS);
    expect(staging.summary.remMs).toBeGreaterThan(45 * MINUTE_MS);
    expect(staging.summary.efficiency).toBeGreaterThan(85);
    expect(restingHrFromSleep(inPeriod)).toBeLessThan(DEFAULT_SIM_PROFILE.restingHr + 4);
  });

  it('detects nothing from a day without sleep', () => {
    const epochs = Array.from({ length: 600 }, (_, i) => ({
      start: i * 30_000, meanHr: 75 + (i % 7), minHr: 70, maxHr: 85, hrSd: 3, rrCount: 30, validRrCount: 30, rmssd: 30, motion: 0.05, worn: true,
    }));
    expect(detectSleepPeriods(epochs, { restingHr: 52 })).toEqual([]);
  });
});

describe('sleep need, performance and consistency', () => {
  it('adds the strain supplement and decayed debt to the baseline', () => {
    const need = computeSleepNeed({
      baselineHours: 7.75,
      priorDayStrain: 16,
      previousNights: [
        { needMs: 8 * HOUR_MS, actualMs: 6 * HOUR_MS },
        { needMs: 8 * HOUR_MS, actualMs: 7 * HOUR_MS },
        { needMs: 8 * HOUR_MS, actualMs: 9 * HOUR_MS },
      ],
    });
    expect(need.baselineMs).toBe(7.75 * HOUR_MS);
    expect(need.strainMs).toBe(28 * MINUTE_MS);
    expect(need.debtMs).toBe(0.5 * 2 * HOUR_MS + 0.25 * HOUR_MS);
    expect(need.needMs).toBe(need.baselineMs + need.strainMs + need.debtMs);
  });

  it('caps the strain supplement and performance', () => {
    expect(computeSleepNeed({ baselineHours: 8, priorDayStrain: 21, previousNights: [] }).strainMs).toBe(45.5 * MINUTE_MS);
    expect(sleepPerformance(9 * HOUR_MS, 8 * HOUR_MS)).toBe(100);
    expect(sleepPerformance(6 * HOUR_MS, 8 * HOUR_MS)).toBe(75);
  });

  it('scores identical windows 100 and shifted windows lower', () => {
    const night = (d: number, startHour: number) => ({ start: Date.UTC(2026, 4, d, startHour), end: Date.UTC(2026, 4, d, startHour + 8) });
    expect(sleepConsistency(night(5, 23), [night(4, 23), night(3, 23)], TZ)).toBeCloseTo(100, 6);
    expect(sleepConsistency(night(5, 23), [night(4, 21)], TZ)).toBeCloseTo(60, 6);
    expect(sleepConsistency(night(5, 23), [], TZ)).toBeNull();
  });
});

describe('stress monitor', () => {
  const reference = { restingHr: 50, maxHr: 190, dayRestHr: 65, dayLnRmssd: Math.log(40), dayLnRmssdSd: 0.3 };

  it('is ~0 at the resting reference and rises with HR and HRV suppression', () => {
    expect(scoreStress({ hr60: 65, lnRmssd60: Math.log(40), motion60: 0.01 }, reference).score).toBe(0);
    const high = scoreStress({ hr60: 65 + 0.15 * 140, lnRmssd60: Math.log(40) - 0.45, motion60: 0.01 }, reference);
    expect(high.score).toBeCloseTo(3, 6);
    expect(stressLevel(high.score!)).toBe('high');
  });

  it('ignores movement and likely exercise', () => {
    expect(scoreStress({ hr60: 120, lnRmssd60: 2.5, motion60: 0.2 }, reference)).toMatchObject({ score: null, reason: 'moving' });
    expect(scoreStress({ hr60: 120, lnRmssd60: 2.5, motion60: null }, reference)).toMatchObject({ score: null, reason: 'exercise' });
  });

  it('doubles the HR component when no R-R data is available', () => {
    const result = scoreStress({ hr60: 65 + 0.075 * 140, lnRmssd60: null, motion60: 0 }, reference);
    expect(result.score).toBeCloseTo(1.5, 6);
  });
});

describe('workout detection', () => {
  const params = { restingHr: 50, maxHr: 190, sex: 'male' as const };
  const profile = { sex: 'male' as const, age: 35, weightKg: 75, heightCm: 178 };

  it('finds a sustained effort, tolerates short dips and labels intensity', () => {
    const hr: Array<{ t: number; hr: number }> = [];
    for (let s = 0; s < 3600; s++) {
      const inWorkout = s >= 600 && s < 2400;
      const dip = s >= 1500 && s < 1560;
      hr.push({ t: s * 1000, hr: inWorkout && !dip ? 150 : 70 });
    }
    const found = detectWorkouts(hr, [], params, profile);
    expect(found).toHaveLength(1);
    expect(found[0]!.intensity).toBe('vigorous');
    expect((found[0]!.end - found[0]!.start) / 60_000).toBeGreaterThan(28);
    expect(found[0]!.strain).toBeGreaterThan(5);
    expect(found[0]!.kcal).toBeGreaterThan(200);
  });

  it('ignores short efforts', () => {
    const hr = Array.from({ length: 1200 }, (_, s) => ({ t: s * 1000, hr: s > 300 && s < 600 ? 150 : 70 }));
    expect(detectWorkouts(hr, [], params, profile)).toEqual([]);
  });
});
