import { describe, expect, it } from 'vitest';
import { computeHrv, filterRR, overnightHrv, rmssdFromDifferences, successiveDifferences, type RrBeat } from '@/lib/physiology/hrv';

/** Contiguous beats from a list of R-R intervals. */
function beats(rr: number[], start = 0): RrBeat[] {
  let t = start;
  return rr.map((v) => ({ t: (t += v), rr: v }));
}

describe('filterRR', () => {
  it('rejects intervals outside 300..2000 ms', () => {
    const result = filterRR(beats([800, 250, 810, 2100, 805]));
    expect(result.map((b) => b.reason)).toEqual([null, 'out_of_range', null, 'out_of_range', null]);
  });

  it('rejects intervals deviating more than 20 % from the local 5-beat median', () => {
    // 520 is a premature beat, 1080 its compensatory pause.
    const result = filterRR(beats([800, 810, 790, 520, 1080, 805, 795, 800]));
    expect(result.filter((b) => !b.valid).map((b) => b.rr)).toEqual([520, 1080]);
    expect(result.every((b) => b.valid || b.reason === 'median_deviation')).toBe(true);
  });

  it('keeps physiological beat-to-beat variation', () => {
    const result = filterRR(beats([800, 850, 780, 840, 790, 860]));
    expect(result.every((b) => b.valid)).toBe(true);
  });
});

describe('time-domain HRV', () => {
  it('computes RMSSD = sqrt(1/(N-1) * sum of squared successive differences)', () => {
    // Differences: +50, -70, +60, -50 -> squares 2500, 4900, 3600, 2500 -> mean 3375
    const metrics = computeHrv(beats([800, 850, 780, 840, 790]), { minPairs: 4 });
    expect(metrics?.pairs).toBe(4);
    expect(metrics?.rmssd).toBeCloseTo(Math.sqrt(3375), 9);
    expect(metrics?.lnRmssd).toBeCloseTo(Math.log(Math.sqrt(3375)), 9);
    expect(metrics?.pnn50).toBe(50); // |70| and |60| exceed 50 ms
    expect(metrics?.sdnn).toBeCloseTo(Math.sqrt(((800 - 812) ** 2 + 38 ** 2 + 32 ** 2 + 28 ** 2 + 22 ** 2) / 4), 9);
    expect(metrics?.meanHr).toBeCloseTo(60_000 / 812, 9);
  });

  it('never forms a difference across a rejected beat or a gap', () => {
    const series = [...beats([800, 810, 820]), ...beats([830, 840], 60_000)];
    const diffs = successiveDifferences(filterRR(series));
    expect(diffs).toEqual([10, 10, 10]);
    expect(rmssdFromDifferences(diffs)).toBe(10);
  });

  it('returns null below the minimum number of pairs', () => {
    expect(computeHrv(beats([800, 810, 820]), { minPairs: 10 })).toBeNull();
    expect(computeHrv([], {})).toBeNull();
  });
});

describe('overnightHrv', () => {
  // Two halves of a night: 30 min "deep" (high variability) and 30 min "light" (low variability).
  const deepRr = Array.from({ length: 1800 }, (_, i) => 1000 + (i % 2 ? 40 : -40));
  const lightRr = Array.from({ length: 1800 }, (_, i) => 1000 + (i % 2 ? 10 : -10));
  const night = filterRR(beats([...deepRr, ...lightRr]));
  const start = 0;
  const mid = deepRr.reduce((a, b) => a + b, 0);
  const end = night[night.length - 1]!.t;

  it('weights slow-wave windows when enough exist', () => {
    const result = overnightHrv(night, start, end, [
      { start, end: mid, stage: 'deep' },
      { start: mid, end, stage: 'light' },
    ]);
    expect(result?.method).toBe('sws_weighted');
    // Windows straddling the boundary blend in a little light-sleep variability.
    expect(result!.rmssd).toBeGreaterThan(75);
    expect(result!.rmssd).toBeLessThanOrEqual(80.5);
  });

  it('falls back to the whole night without slow-wave sleep', () => {
    const result = overnightHrv(night, start, end, [{ start, end, stage: 'light' }]);
    expect(result?.method).toBe('full_night');
    expect(result!.rmssd).toBeGreaterThan(20);
    expect(result!.rmssd).toBeLessThan(80);
  });
});
