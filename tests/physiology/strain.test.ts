import { describe, expect, it } from 'vitest';
import { referenceDayLoad } from '../../scripts/calibrate-strain';
import { keytelKcalPerMinute, mifflinBmrKcalPerDay } from '@/lib/physiology/energy';
import {
  LIGHT_ACTIVITY_HRR,
  banisterWeight,
  computeLoad,
  edwardsZone,
  heartRateReserveFraction,
  loadForStrain,
  strainFromLoad,
} from '@/lib/physiology/strain';

describe('strain building blocks', () => {
  it('computes %HRR with the Karvonen formula', () => {
    expect(heartRateReserveFraction(120, 50, 190)).toBeCloseTo(0.5, 12);
    expect(heartRateReserveFraction(40, 50, 190)).toBe(0);
  });

  it('applies Banister weights for men and women', () => {
    expect(banisterWeight(0.5, 'male')).toBeCloseTo(0.5 * 0.64 * Math.exp(0.96), 12);
    expect(banisterWeight(0.5, 'female')).toBeCloseTo(0.5 * 0.86 * Math.exp(0.835), 12);
  });

  it('assigns Edwards zones on %HRR', () => {
    expect([0.49, 0.5, 0.65, 0.75, 0.85, 0.95].map(edwardsZone)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('accumulates TRIMP, Edwards load and zone time; caps gaps', () => {
    const params = { restingHr: 50, maxHr: 190, sex: 'male' as const };
    const samples = Array.from({ length: 601 }, (_, i) => ({ t: i * 1000, hr: 155 })); // 10 min at 75 % HRR
    const load = computeLoad(samples, params);
    const minutes = 601 / 60;
    expect(load.edwards).toBeCloseTo(3 * minutes, 6);
    expect(load.trimp).toBeCloseTo(banisterWeight(0.75, 'male') * minutes, 6);
    expect(load.load).toBeCloseTo((banisterWeight(0.75, 'male') - banisterWeight(LIGHT_ACTIVITY_HRR, 'male')) * minutes, 6);
    expect(load.zoneMs[3]).toBe(601_000);
    const gappy = computeLoad([{ t: 0, hr: 155 }, { t: 3_600_000, hr: 155 }], params);
    expect(gappy.durationMs).toBe(11_000);
  });

  it('maps load to a capped, monotonic 0-21 scale with an exact inverse', () => {
    expect(strainFromLoad(0)).toBe(0);
    expect(strainFromLoad(1e9)).toBe(21);
    expect(strainFromLoad(50)).toBeLessThan(strainFromLoad(51));
    expect(strainFromLoad(loadForStrain(12.3))).toBeCloseTo(12.3, 9);
  });
});

describe('strain calibration anchors (simulated reference days)', () => {
  const strain = (kind: 'rest' | 'moderate' | 'endurance', seed: number) => strainFromLoad(referenceDayLoad(kind, seed));

  it.each([1, 2, 3])('rest day ~4 (seed %i)', (seed) => {
    expect(strain('rest', seed)).toBeGreaterThan(3.2);
    expect(strain('rest', seed)).toBeLessThan(4.8);
  });

  it.each([1, 2, 3])('45-min moderate workout day 11-13 (seed %i)', (seed) => {
    expect(strain('moderate', seed)).toBeGreaterThanOrEqual(11);
    expect(strain('moderate', seed)).toBeLessThanOrEqual(13);
  });

  it.each([1, 2, 3])('endurance day 18-20.5 (seed %i)', (seed) => {
    expect(strain('endurance', seed)).toBeGreaterThanOrEqual(18);
    expect(strain('endurance', seed)).toBeLessThanOrEqual(20.5);
  });
});

describe('energy', () => {
  it('implements Keytel (2005) and Mifflin-St Jeor', () => {
    const profile = { sex: 'male' as const, age: 30, weightKg: 75, heightCm: 180 };
    expect(keytelKcalPerMinute(150, profile)).toBeCloseTo((-55.0969 + 0.6309 * 150 + 0.1988 * 75 + 0.2017 * 30) / 4.184, 9);
    expect(mifflinBmrKcalPerDay(profile)).toBe(10 * 75 + 6.25 * 180 - 5 * 30 + 5);
    expect(mifflinBmrKcalPerDay({ ...profile, sex: 'female' })).toBe(10 * 75 + 6.25 * 180 - 5 * 30 - 161);
  });
});
