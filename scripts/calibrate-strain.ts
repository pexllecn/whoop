/**
 * Fits the Strain curve constants k and alpha (src/lib/physiology/strain.ts)
 * to simulated reference days:
 *   rest day (light activity only)            -> 4.0
 *   45-minute moderate workout (~65 % HRR)    -> 12.0
 *   2.5-3 h endurance session (~80 % HRR)     -> 19.25
 * Run: npx tsx scripts/calibrate-strain.ts
 */
import { DEFAULT_SIM_PROFILE, PhysiologySimulator, beatsToNotifications, planDay, type DayKind } from '../src/lib/simulation/physiologySimulator';
import { computeLoad } from '../src/lib/physiology/strain';
import { addDays, dayRange } from '../src/lib/time';

const TZ = 'UTC';
const TARGETS: Array<{ kind: DayKind; strain: number }> = [
  { kind: 'rest', strain: 4.0 },
  { kind: 'moderate', strain: 12.0 },
  { kind: 'endurance', strain: 19.25 },
];

export function referenceDayLoad(kind: DayKind, seed: number, date = '2026-06-10'): number {
  const prev = planDay(addDays(date, -1), seed, 'rest');
  const plan = planDay(date, seed, kind, prev);
  const next = planDay(addDays(date, 1), seed, 'rest', plan);
  const sim = new PhysiologySimulator([prev, plan, next], DEFAULT_SIM_PROFILE, TZ, seed);
  const { start, end } = dayRange(date, TZ);
  const beats = sim.beats(start, end);
  const hr = beatsToNotifications(beats, start, end).map((n) => ({ t: n.t, hr: n.bpm }));
  return computeLoad(hr, { restingHr: DEFAULT_SIM_PROFILE.restingHr, maxHr: DEFAULT_SIM_PROFILE.maxHr, sex: 'male' }).load;
}

/**
 * Objective: hit the rest anchor (4.0) as closely as possible while keeping
 * the moderate day inside 11-13 and the endurance day inside 18-20.5
 * (outside a range costs 10x), with a mild pull towards each range centre.
 */
function objective(strains: number[]): number {
  const [rest, moderate, endurance] = strains as [number, number, number];
  const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  return (
    (rest - 4) ** 2 +
    10 * outside(moderate, 11, 13) ** 2 +
    10 * outside(endurance, 18, 20.5) ** 2 +
    0.1 * (moderate - 12) ** 2 +
    0.1 * (endurance - 19.25) ** 2
  );
}

export function fitStrainCurve(loads: number[]) {
  let best = { k: 0, alpha: 0, err: Number.POSITIVE_INFINITY };
  for (let alpha = 0.001; alpha <= 5; alpha *= 1.004) {
    for (let k = 2; k <= 12; k += 0.005) {
      const strains = loads.map((L) => Math.min(21, k * Math.log(1 + alpha * L)));
      const err = objective(strains);
      if (err < best.err) best = { k, alpha, err };
    }
  }
  return best;
}

if (process.argv[1]?.endsWith('calibrate-strain.ts')) {
  const seeds = [1, 2, 3, 4, 5, 6];
  const rows = TARGETS.map((t) => {
    const loads = seeds.map((s) => referenceDayLoad(t.kind, s));
    return { ...t, loads, mean: loads.reduce((a, b) => a + b, 0) / loads.length };
  });
  const result = fitStrainCurve(rows.map((r) => r.mean));
  console.log('Mean loads:', rows.map((r) => `${r.kind}=${r.mean.toFixed(1)} [${r.loads.map((l) => l.toFixed(0)).join(', ')}]`).join('  '));
  console.log(`k = ${result.k.toFixed(3)}, alpha = ${result.alpha.toFixed(4)}, objective = ${result.err.toFixed(3)}`);
  for (const r of rows) {
    const strains = r.loads.map((L) => Math.min(21, result.k * Math.log(1 + result.alpha * L)));
    console.log(`${r.kind.padEnd(9)} target ${r.strain}  ->  ${strains.map((s) => s.toFixed(1)).join(', ')}`);
  }
}
