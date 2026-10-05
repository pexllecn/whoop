import { describe, expect, it } from 'vitest';
import { BASELINE_ALPHA, CALIBRATION_NIGHTS, METRIC_SD, stateFromStored, toBaseline, updateBaseline, type BaselineState } from '@/lib/physiology/baseline';
import { RECOVERY_SIGMOID_A, computeRecovery, recoveryBand, sigmoidRecovery } from '@/lib/physiology/recovery';

const fold = (values: number[]) => values.reduce<BaselineState | null>((s, v) => updateBaseline(s, v), null)!;

describe('EWMA baseline', () => {
  it('uses alpha = 2/(30+1)', () => {
    expect(BASELINE_ALPHA).toBeCloseTo(2 / 31, 12);
  });

  it('is a plain mean during warm-up', () => {
    const state = fold([60, 64, 62]);
    expect(state.mean).toBeCloseTo(62, 9);
    expect(state.n).toBe(3);
  });

  it('converges to the EWMA recursion after warm-up', () => {
    let state = fold(Array.from({ length: 40 }, () => 50));
    const before = state.mean;
    state = updateBaseline(state, 60);
    expect(state.mean).toBeCloseTo(before + BASELINE_ALPHA * 10, 9);
  });

  it('shrinks the SD towards the prior while n is small and applies floors', () => {
    const early = toBaseline('resting_hr', fold([50, 50]))!;
    expect(early.sd).toBeCloseTo(Math.sqrt((3 * METRIC_SD.resting_hr.prior ** 2) / 5), 9);
    const flat = toBaseline('ln_rmssd', fold(Array.from({ length: 60 }, () => 4)))!;
    expect(flat.sd).toBe(METRIC_SD.ln_rmssd.floor);
  });

  it('round-trips through stored rows', () => {
    const state = fold([4.1, 4.3, 3.9, 4.2, 4.0, 4.4]);
    const stored = toBaseline('ln_rmssd', state)!;
    const restored = stateFromStored('ln_rmssd', stored);
    expect(restored.mean).toBeCloseTo(state.mean, 12);
    expect(restored.variance).toBeCloseTo(state.variance, 9);
  });
});

describe('recovery', () => {
  const baselines = {
    lnRmssd: { mean: Math.log(60), sd: 0.15, n: 30 },
    restingHr: { mean: 52, sd: 2.5, n: 30 },
    respRate: { mean: 14.5, sd: 0.5, n: 30 },
    skinTemp: { mean: 33.8, sd: 0.3, n: 30 },
  };
  const atBaseline = { lnRmssd: Math.log(60), restingHr: 52, sleepPerformance: 85, respRate: 14.5, skinTempC: 33.8 };

  it('maps a night exactly at baseline to 67 % (bottom of green)', () => {
    const result = computeRecovery(atBaseline, baselines)!;
    expect(result.composite).toBeCloseTo(0, 12);
    expect(result.score).toBeCloseTo(67, 9);
    expect(result.band).toBe('green');
    expect(RECOVERY_SIGMOID_A).toBeCloseTo(Math.log(67 / 33), 12);
  });

  it('places composite -1.5 at 33 % and +1.5 near 89 %', () => {
    expect(sigmoidRecovery(-1.5)).toBeCloseTo(33, 0);
    expect(sigmoidRecovery(1.5)).toBeCloseTo(89, 0);
  });

  it('computes Z_HRV and the inverted Z_RHR', () => {
    const result = computeRecovery({ ...atBaseline, lnRmssd: Math.log(60) + 0.15, restingHr: 49.5 }, baselines)!;
    expect(result.zHrv).toBeCloseTo(1, 9);
    expect(result.zRhr).toBeCloseTo(1, 9);
    expect(result.core).toBeCloseTo(1, 9);
  });

  it('penalises poor sleep, raised respiration and raised skin temperature', () => {
    const base = computeRecovery(atBaseline, baselines)!.score;
    expect(computeRecovery({ ...atBaseline, sleepPerformance: 55 }, baselines)!.score).toBeLessThan(base);
    expect(computeRecovery({ ...atBaseline, respRate: 16.5 }, baselines)!.respPenalty).toBeCloseTo(0.75, 9);
    expect(computeRecovery({ ...atBaseline, skinTempC: 34.6 }, baselines)!.tempPenalty).toBeCloseTo(0.6, 9);
  });

  it('works without RHR, and needs HRV', () => {
    expect(computeRecovery({ ...atBaseline, restingHr: null }, baselines)!.core).toBe(0);
    expect(computeRecovery({ ...atBaseline, lnRmssd: null }, baselines)).toBeNull();
    expect(computeRecovery(atBaseline, { ...baselines, lnRmssd: null })).toBeNull();
  });

  it('flags calibration until enough nights exist', () => {
    expect(computeRecovery(atBaseline, { ...baselines, lnRmssd: { ...baselines.lnRmssd, n: CALIBRATION_NIGHTS - 1 } })!.calibrating).toBe(true);
    expect(computeRecovery(atBaseline, baselines)!.calibrating).toBe(false);
  });

  it('uses the spec colour bands on the rounded score', () => {
    expect([recoveryBand(100), recoveryBand(66.6), recoveryBand(66.4), recoveryBand(34), recoveryBand(33.4), recoveryBand(0)]).toEqual([
      'green',
      'green',
      'yellow',
      'yellow',
      'red',
      'red',
    ]);
  });
});
