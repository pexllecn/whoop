/**
 * Synthetic physiology for development, demos and calibration tests.
 *
 * Produces beat-by-beat R-R intervals (with respiratory sinus arrhythmia, a
 * 0.1 Hz baroreflex component, white noise, ectopic beats and motion
 * artefacts), heart rate and accelerometer activity for a schedule of sleep,
 * sedentary time, light activity and workouts. Every output is labelled as
 * simulated wherever it is stored. Nothing here is used to score real data.
 */
import { Rng, hashSeed } from '../random';
import { DAY_MS, MINUTE_MS, addDays, dateKey, enumerateDays, zonedTime } from '../time';

export type SleepStage = 'awake' | 'light' | 'deep' | 'rem';

export type SimState =
  | { kind: 'sleep'; stage: SleepStage; nap: boolean }
  | { kind: 'sedentary' }
  | { kind: 'light_activity' }
  | { kind: 'workout'; intensity: number; sport: string; motion: number };

export interface SimProfile {
  /** Sleeping resting heart rate (bpm). */
  restingHr: number;
  maxHr: number;
  /** Typical overnight RMSSD (ms). */
  baselineRmssd: number;
  /** Resting respiratory rate (breaths/min). */
  respRate: number;
  age: number;
  sex: 'male' | 'female';
  weightKg: number;
  heightCm: number;
}

export const DEFAULT_SIM_PROFILE: SimProfile = {
  restingHr: 52,
  maxHr: 188,
  baselineRmssd: 62,
  respRate: 14.6,
  age: 34,
  sex: 'male',
  weightKg: 74,
  heightCm: 178,
};

export interface SimWorkout {
  /** Minutes from local midnight of the plan date. */
  startMinute: number;
  durationMinutes: number;
  /** Target fraction of heart-rate reserve. */
  intensity: number;
  sport: string;
  /** Mean accelerometer activity (g) while active. */
  motion: number;
}

export interface SimDayPlan {
  /** Local date of the waking day. */
  date: string;
  /** Sleep onset in minutes relative to local midnight of `date` (negative = previous evening). */
  sleepStartMinute: number;
  sleepDurationMinutes: number;
  /** Ground-truth stage per 30 s epoch of the main sleep. */
  hypnogram: SleepStage[];
  workouts: SimWorkout[];
  lightActivity: Array<{ startMinute: number; durationMinutes: number }>;
  nap: { startMinute: number; durationMinutes: number; hypnogram: SleepStage[] } | null;
  /** -1..1 autonomic state carried into the coming night (affects HRV and RHR). */
  recoveryModifier: number;
  illness: boolean;
}

export type DayKind = 'rest' | 'moderate' | 'hiit' | 'endurance' | 'auto';

export interface Beat {
  /** Epoch ms at which the beat ends (R peak). */
  t: number;
  rr: number;
}

const EPOCH_MS = 30_000;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** Ground-truth hypnogram with ~90 min cycles: deep-heavy early, REM-heavy late. */
export function buildHypnogram(durationMinutes: number, rng: Rng): SleepStage[] {
  const total = Math.max(1, Math.round((durationMinutes * 60_000) / EPOCH_MS));
  const stages: SleepStage[] = [];
  const latency = rng.int(4, 16);
  for (let i = 0; i < latency && stages.length < total; i++) stages.push('light');

  let cycle = 0;
  while (stages.length < total) {
    const cycleEpochs = Math.round(rng.range(160, 200));
    const deepShare = Math.max(0.03, 0.38 - 0.11 * cycle + rng.range(-0.04, 0.04));
    const remShare = Math.min(0.38, 0.1 + 0.08 * cycle + rng.range(-0.03, 0.03));
    const awakeShare = cycle === 0 ? 0 : rng.range(0.005, 0.03);
    const deep = Math.round(cycleEpochs * deepShare);
    const rem = Math.round(cycleEpochs * remShare);
    const awake = Math.round(cycleEpochs * awakeShare);
    const light = Math.max(0, cycleEpochs - deep - rem - awake);
    const segments: Array<[SleepStage, number]> = [
      ['light', Math.round(light * 0.55)],
      ['deep', deep],
      ['light', light - Math.round(light * 0.55)],
      ['rem', rem],
      ['awake', awake],
    ];
    for (const [stage, count] of segments) {
      for (let i = 0; i < count && stages.length < total; i++) stages.push(stage);
    }
    cycle++;
  }
  // Waking up: the last 1-3 minutes are awake.
  const tail = Math.min(total, rng.int(2, 6));
  for (let i = total - tail; i < total; i++) stages[i] = 'awake';
  return stages;
}

const SPORTS = {
  running: { sport: 'Running', motion: 0.45 },
  cycling: { sport: 'Cycling', motion: 0.12 },
  strength: { sport: 'Strength training', motion: 0.28 },
  hiit: { sport: 'HIIT', motion: 0.5 },
  rowing: { sport: 'Rowing', motion: 0.3 },
} as const;

function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Deterministic plan for one day; `kind: 'auto'` follows a weekly training pattern. */
export function planDay(date: string, seed: number, kind: DayKind = 'auto', previous?: SimDayPlan): SimDayPlan {
  const rng = new Rng(hashSeed(`${seed}:${date}`));
  let resolved: Exclude<DayKind, 'auto'> = kind === 'auto' ? 'rest' : kind;
  if (kind === 'auto') {
    const pattern: Array<Exclude<DayKind, 'auto'>> = ['rest', 'moderate', 'hiit', 'rest', 'moderate', 'rest', 'endurance'];
    resolved = pattern[weekdayOf(date)]!;
    if (rng.chance(0.15)) resolved = resolved === 'rest' ? 'moderate' : 'rest';
  }

  const workouts: SimWorkout[] = [];
  const workoutStart = rng.chance(0.5) ? rng.int(6 * 60 + 30, 8 * 60) : rng.int(17 * 60, 19 * 60);
  if (resolved === 'moderate') {
    const s = rng.pick([SPORTS.running, SPORTS.cycling, SPORTS.rowing]);
    workouts.push({ startMinute: workoutStart, durationMinutes: 45, intensity: rng.range(0.62, 0.7), ...s });
  } else if (resolved === 'hiit') {
    const s = rng.pick([SPORTS.hiit, SPORTS.strength]);
    workouts.push({ startMinute: workoutStart, durationMinutes: rng.int(35, 50), intensity: rng.range(0.7, 0.78), ...s });
  } else if (resolved === 'endurance') {
    const s = rng.pick([SPORTS.cycling, SPORTS.running]);
    workouts.push({ startMinute: 8 * 60 + rng.int(0, 60), durationMinutes: rng.int(150, 180), intensity: rng.range(0.78, 0.84), ...s });
  }

  const lightActivity = [
    { startMinute: 8 * 60 + rng.int(20, 50), durationMinutes: rng.int(12, 22) },
    { startMinute: 12 * 60 + rng.int(10, 40), durationMinutes: rng.int(15, 25) },
    { startMinute: 18 * 60 + rng.int(30, 70), durationMinutes: rng.int(10, 20) },
  ].filter((bout) => !workouts.some((w) => bout.startMinute < w.startMinute + w.durationMinutes + 20 && w.startMinute < bout.startMinute + bout.durationMinutes + 20));

  const prevLoad = previous ? previous.workouts.reduce((sum, w) => sum + w.durationMinutes * w.intensity, 0) : 0;
  const sleepDurationMinutes = Math.round(rng.normal(445, 32) + Math.min(30, prevLoad * 0.15));
  const sleepStartMinute = Math.round(rng.normal(-55, 28));
  const illness = rng.chance(0.03);
  const recoveryModifier = Math.max(
    -1,
    Math.min(1, rng.normal(0.1, 0.35) - Math.min(0.6, prevLoad / 220) + (sleepDurationMinutes - 445) / 240 - (illness ? 0.6 : 0)),
  );

  const nap = rng.chance(0.12)
    ? { startMinute: rng.int(13 * 60 + 30, 15 * 60), durationMinutes: rng.int(22, 45), hypnogram: [] as SleepStage[] }
    : null;
  if (nap) nap.hypnogram = buildHypnogram(nap.durationMinutes, rng).map((s) => (s === 'deep' && rng.chance(0.5) ? 'light' : s));

  return {
    date,
    sleepStartMinute,
    sleepDurationMinutes: Math.max(240, sleepDurationMinutes),
    hypnogram: buildHypnogram(Math.max(240, sleepDurationMinutes), rng),
    workouts,
    lightActivity,
    nap,
    recoveryModifier,
    illness,
  };
}

/** Consecutive plans, each aware of the previous day's load. */
export function planRange(fromDate: string, toDate: string, seed: number, kind: DayKind = 'auto'): SimDayPlan[] {
  const plans: SimDayPlan[] = [];
  for (const date of enumerateDays(fromDate, toDate)) {
    plans.push(planDay(date, seed, kind, plans[plans.length - 1]));
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Signal generation
// ---------------------------------------------------------------------------

interface ResolvedInterval {
  start: number;
  end: number;
  state: SimState;
}

interface StateParams {
  /** Target heart rate (bpm). */
  hr: number;
  /** Target RMSSD (ms). */
  rmssd: number;
  /** Respiration (breaths/min). */
  resp: number;
  /** Mean accelerometer activity (g). */
  motion: number;
  /** Extra beat-to-beat HR wander (bpm SD), high in REM. */
  wander: number;
}

/**
 * Turns day plans into a continuous signal. Generation is stateful (beat
 * clock, smoothed HR, oscillator phases) so consecutive `beats()` calls
 * produce one seamless stream, which is what the live simulator relies on.
 */
export class PhysiologySimulator {
  private readonly intervals: ResolvedInterval[] = [];
  private readonly planByDate = new Map<string, SimDayPlan>();
  private readonly planCache = new Map<number, SimDayPlan | undefined>();
  private readonly rng: Rng;
  private lastBeat: number | null = null;
  private smoothedHr: number;
  private respPhase = 0;
  private lfPhase: number;
  private pendingCompensatory = false;

  constructor(
    readonly plans: SimDayPlan[],
    readonly profile: SimProfile,
    readonly timeZone: string,
    seed: number,
  ) {
    this.rng = new Rng(hashSeed(`signal:${seed}`));
    this.smoothedHr = profile.restingHr + 15;
    this.lfPhase = this.rng.range(0, Math.PI * 2);
    for (const plan of plans) {
      this.planByDate.set(plan.date, plan);
      this.addPlan(plan);
    }
    this.intervals.sort((a, b) => a.start - b.start);
  }

  /** Build a simulator covering `days` days ending on `endDate`. */
  static forRange(endDate: string, days: number, timeZone: string, seed = 7, profile = DEFAULT_SIM_PROFILE): PhysiologySimulator {
    const startDate = addDays(endDate, -(days - 1));
    return new PhysiologySimulator(planRange(startDate, addDays(endDate, 1), seed), profile, timeZone, seed);
  }

  private addPlan(plan: SimDayPlan): void {
    const at = (minute: number) => zonedTime(plan.date, minute, this.timeZone);
    const sleepStart = at(plan.sleepStartMinute);
    plan.hypnogram.forEach((stage, i) => {
      this.intervals.push({
        start: sleepStart + i * EPOCH_MS,
        end: sleepStart + (i + 1) * EPOCH_MS,
        state: { kind: 'sleep', stage, nap: false },
      });
    });
    if (plan.nap) {
      const napStart = at(plan.nap.startMinute);
      plan.nap.hypnogram.forEach((stage, i) => {
        this.intervals.push({
          start: napStart + i * EPOCH_MS,
          end: napStart + (i + 1) * EPOCH_MS,
          state: { kind: 'sleep', stage, nap: true },
        });
      });
    }
    for (const w of plan.workouts) {
      this.intervals.push({
        start: at(w.startMinute),
        end: at(w.startMinute + w.durationMinutes),
        state: { kind: 'workout', intensity: w.intensity, sport: w.sport, motion: w.motion },
      });
    }
    for (const bout of plan.lightActivity) {
      this.intervals.push({ start: at(bout.startMinute), end: at(bout.startMinute + bout.durationMinutes), state: { kind: 'light_activity' } });
    }
  }

  /** Main sleep [start, end) for the night that ends on `date`. */
  sleepWindow(date: string): { start: number; end: number } | null {
    const plan = this.planByDate.get(date);
    if (!plan) return null;
    const start = zonedTime(plan.date, plan.sleepStartMinute, this.timeZone);
    return { start, end: start + plan.hypnogram.length * EPOCH_MS };
  }

  stateAt(ms: number): SimState {
    // Last interval starting at or before ms, then a short scan back because a
    // workout can begin before an interval that is still open.
    let lo = 0;
    let hi = this.intervals.length - 1;
    let index = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.intervals[mid]!.start <= ms) {
        index = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    for (let i = index; i >= 0 && i >= index - 8; i--) {
      const iv = this.intervals[i]!;
      if (ms < iv.end) return iv.state;
    }
    return { kind: 'sedentary' };
  }

  /**
   * Plan whose night or day covers `ms`. Evenings from 20:00 belong to the next
   * day's plan because that is the night they lead into.
   */
  private planFor(ms: number): SimDayPlan | undefined {
    const bucket = Math.floor(ms / 3_600_000);
    if (!this.planCache.has(bucket)) {
      this.planCache.set(bucket, this.planByDate.get(dateKey(bucket * 3_600_000 + 4 * 3_600_000, this.timeZone)));
    }
    return this.planCache.get(bucket);
  }

  private params(state: SimState, ms: number): StateParams {
    const p = this.profile;
    const plan = this.planFor(ms);
    const mod = plan?.recoveryModifier ?? 0;
    const ill = plan?.illness ?? false;
    const rest = p.restingHr - 2.5 * mod + (ill ? 6 : 0);
    const reserve = p.maxHr - rest;
    const hrvScale = (1 + 0.25 * mod) * (ill ? 0.7 : 1);
    const resp = p.respRate + (ill ? 1.5 : 0);
    switch (state.kind) {
      case 'sleep':
        switch (state.stage) {
          case 'deep':
            return { hr: rest - 2, rmssd: p.baselineRmssd * 1.15 * hrvScale, resp: resp * 0.95, motion: 0.002, wander: 0.4 };
          case 'light':
            return { hr: rest + 2, rmssd: p.baselineRmssd * 0.95 * hrvScale, resp, motion: 0.004, wander: 0.8 };
          case 'rem':
            return { hr: rest + 7, rmssd: p.baselineRmssd * 0.75 * hrvScale, resp: resp * 1.08, motion: 0.002, wander: 2.6 };
          case 'awake':
            return { hr: rest + 13, rmssd: p.baselineRmssd * 0.6 * hrvScale, resp: resp * 1.1, motion: 0.06, wander: 2 };
        }
        break;
      case 'sedentary':
        return { hr: rest + 17, rmssd: p.baselineRmssd * 0.55 * hrvScale, resp: resp * 1.12, motion: 0.018, wander: 2.5 };
      case 'light_activity':
        return { hr: rest + 0.36 * reserve, rmssd: p.baselineRmssd * 0.3, resp: resp * 1.5, motion: 0.15, wander: 3 };
      case 'workout':
        return {
          hr: rest + state.intensity * reserve,
          rmssd: Math.max(4, p.baselineRmssd * (0.35 - 0.3 * state.intensity)),
          resp: Math.min(45, resp * (1.4 + 1.6 * state.intensity)),
          motion: state.motion,
          wander: 2.5,
        };
    }
    return { hr: rest + 17, rmssd: p.baselineRmssd * 0.55, resp, motion: 0.02, wander: 2 };
  }

  /** Beats whose R peak falls in [from, to). Calls must be made with non-decreasing ranges. */
  beats(from: number, to: number): Beat[] {
    const out: Beat[] = [];
    if (this.lastBeat === null || this.lastBeat < from - 10_000) this.lastBeat = from;
    let t = this.lastBeat;
    while (true) {
      const state = this.stateAt(t);
      const params = this.params(state, t);
      const target = params.hr + this.rng.normal(0, params.wander) * 0.15;
      const tau = target > this.smoothedHr ? 35_000 : 55_000;
      const meanRr = 60_000 / Math.max(30, this.smoothedHr);
      this.smoothedHr += (target - this.smoothedHr) * Math.min(1, meanRr / tau) + this.rng.normal(0, params.wander) * 0.05;

      const seconds = t / 1000;
      const respHz = params.resp / 60;
      this.respPhase += 2 * Math.PI * respHz * (meanRr / 1000);
      this.lfPhase += 2 * Math.PI * 0.1 * (meanRr / 1000);
      const sinTerm = Math.SQRT2 * Math.sin(Math.PI * respHz * (meanRr / 1000));
      const rsaAmplitude = sinTerm > 0.05 ? (0.9 * params.rmssd) / sinTerm : 0;
      const lfAmplitude = 0.5 * params.rmssd;
      let rr =
        meanRr +
        rsaAmplitude * Math.sin(this.respPhase) +
        lfAmplitude * Math.sin(this.lfPhase + 0.3 * Math.sin(seconds / 600)) +
        this.rng.normal(0, (0.3 * params.rmssd) / Math.SQRT2);

      if (this.pendingCompensatory) {
        rr = meanRr * 1.35;
        this.pendingCompensatory = false;
      } else if (this.rng.chance(0.0015)) {
        rr = meanRr * 0.65; // premature (ectopic) beat
        this.pendingCompensatory = true;
      } else if (state.kind === 'workout' && this.rng.chance(0.004)) {
        rr = meanRr * this.rng.range(0.3, 0.5); // motion artefact: spurious detection
      }
      rr = Math.max(250, Math.min(2200, rr));

      const next = t + rr;
      if (next >= to) break;
      t = next;
      if (t >= from) out.push({ t, rr });
    }
    this.lastBeat = t;
    return out;
  }

  /** Mean accelerometer activity (g, deviation from 1 g) per step in [from, to). */
  motion(from: number, to: number, stepMs = 1000): Array<{ t: number; activity: number }> {
    const out: Array<{ t: number; activity: number }> = [];
    for (let t = from; t < to; t += stepMs) {
      const params = this.params(this.stateAt(t), t);
      const burst = this.rng.chance(0.004) ? this.rng.range(0.05, 0.3) : 0;
      out.push({ t, activity: Math.max(0, params.motion * (1 + this.rng.normal(0, 0.35)) + burst) });
    }
    return out;
  }

  /** Simulated skin temperature (deg C) for an instant; nightly values rise with illness. */
  skinTemperature(ms: number): number {
    const plan = this.planFor(ms);
    const state = this.stateAt(ms);
    const base = state.kind === 'sleep' ? 34.1 : 33.2;
    return base + (plan?.illness ? 0.7 : 0) + this.rng.normal(0, 0.08);
  }

  /** Ground-truth stage for the 30 s epoch containing `ms` (null when awake and out of bed). */
  trueStage(ms: number): SleepStage | null {
    const state = this.stateAt(ms);
    return state.kind === 'sleep' ? state.stage : null;
  }

  coverage(): { start: number; end: number } {
    const first = this.plans[0];
    const last = this.plans[this.plans.length - 1];
    if (!first || !last) return { start: 0, end: 0 };
    return { start: zonedTime(first.date, first.sleepStartMinute, this.timeZone), end: zonedTime(last.date, 0, this.timeZone) + DAY_MS };
  }
}

/** Collapse beats into 1 Hz "notifications" the way a heart-rate strap reports them. */
export function beatsToNotifications(beats: Beat[], from: number, to: number): Array<{ t: number; bpm: number; rr: number[] }> {
  const out: Array<{ t: number; bpm: number; rr: number[] }> = [];
  let index = 0;
  let lastBpm = 60;
  for (let second = from; second < to; second += 1000) {
    const end = second + 1000;
    const rr: number[] = [];
    while (index < beats.length && beats[index]!.t < end) {
      if (beats[index]!.t >= second) rr.push(beats[index]!.rr);
      index++;
    }
    if (rr.length) {
      const recent = rr.slice(-3);
      lastBpm = Math.round(60_000 / (recent.reduce((a, b) => a + b, 0) / recent.length));
    }
    out.push({ t: end, bpm: lastBpm, rr });
  }
  return out;
}

export const SIM_MINUTE_MS = MINUTE_MS;
