import { describe, expect, it } from 'vitest';
import { filterRR, type RrBeat } from '@/lib/physiology/hrv';
import { estimateRespiration, lombScargle, respiratoryRateOverPeriod } from '@/lib/physiology/respiration';
import { Rng } from '@/lib/random';

function rsaBeats(breathsPerMinute: number, seconds: number, seed = 1): RrBeat[] {
  const rng = new Rng(seed);
  const out: RrBeat[] = [];
  let t = 0;
  while (t < seconds * 1000) {
    const rr = 950 + 45 * Math.sin((2 * Math.PI * breathsPerMinute * t) / 60_000) + rng.normal(0, 6);
    t += rr;
    out.push({ t, rr });
  }
  return out;
}

describe('lombScargle', () => {
  it('peaks at the frequency of an unevenly sampled sinusoid', () => {
    const rng = new Rng(3);
    const t = Array.from({ length: 200 }, () => rng.range(0, 100)).sort((a, b) => a - b);
    const y = t.map((s) => Math.sin(2 * Math.PI * 0.3 * s));
    const freqs = Array.from({ length: 81 }, (_, i) => 0.1 + i * 0.005);
    const { power } = lombScargle(t, y, freqs);
    const best = freqs[power.indexOf(Math.max(...power))]!;
    expect(best).toBeCloseTo(0.3, 2);
  });
});

describe('respiratory rate from RSA', () => {
  it.each([9, 12, 15, 18, 24])('recovers %i breaths/min', (bpm) => {
    const estimate = estimateRespiration(filterRR(rsaBeats(bpm, 120)));
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate!.breathsPerMinute - bpm)).toBeLessThanOrEqual(0.6);
  });

  it('reports nothing when there is no respiratory rhythm', () => {
    const rng = new Rng(9);
    let t = 0;
    const noise = Array.from({ length: 150 }, () => {
      const rr = 900 + rng.normal(0, 25);
      t += rr;
      return { t, rr };
    });
    expect(estimateRespiration(filterRR(noise))).toBeNull();
  });

  it('takes the median over a period', () => {
    const beats = filterRR(rsaBeats(14, 600));
    const rate = respiratoryRateOverPeriod(beats, 0, beats[beats.length - 1]!.t);
    expect(rate).toBeCloseTo(14, 0);
  });
});
