/**
 * Live stress for the dashboard ribbon: keeps the last few minutes of HR,
 * beats and motion and scores the trailing 60 s window on demand.
 */
import { BeatClock } from '../physiology/epochs';
import { computeHrv, filterRR, type RrBeat } from '../physiology/hrv';
import { scoreStress, type StressReference } from '../physiology/stressMonitor';

const KEEP_MS = 5 * 60_000;

export class LiveStressMonitor {
  private hr: Array<{ t: number; hr: number }> = [];
  private beats: RrBeat[] = [];
  private motion: Array<{ t: number; activity: number }> = [];
  private readonly clock = new BeatClock();

  constructor(private reference: StressReference) {}

  setReference(reference: StressReference): void {
    this.reference = reference;
  }

  addHeartRate(t: number, bpm: number | null, rr: number[], source = 'sig_hrm'): void {
    if (bpm !== null) this.hr.push({ t, hr: bpm });
    this.beats.push(...this.clock.push(t, rr, source));
    this.trim(t);
  }

  addMotion(t: number, activity: number): void {
    this.motion.push({ t, activity });
    this.trim(t);
  }

  private trim(now: number): void {
    const cutoff = now - KEEP_MS;
    if (this.hr.length && this.hr[0]!.t < cutoff) this.hr = this.hr.filter((s) => s.t >= cutoff);
    if (this.beats.length && this.beats[0]!.t < cutoff) this.beats = this.beats.filter((s) => s.t >= cutoff);
    if (this.motion.length && this.motion[0]!.t < cutoff) this.motion = this.motion.filter((s) => s.t >= cutoff);
  }

  score(now: number) {
    const from = now - 60_000;
    const hrWindow = this.hr.filter((s) => s.t > from && s.t <= now);
    const beatWindow = this.beats.filter((b) => b.t > from && b.t <= now);
    const motionWindow = this.motion.filter((m) => m.t > from && m.t <= now);
    const hrv = computeHrv(filterRR(beatWindow), { prefiltered: true, minPairs: 30 });
    const hr60 = hrWindow.length ? hrWindow.reduce((s, x) => s + x.hr, 0) / hrWindow.length : null;
    const motion60 = motionWindow.length ? motionWindow.reduce((s, x) => s + x.activity, 0) / motionWindow.length : null;
    const result = scoreStress({ hr60, lnRmssd60: hrv?.lnRmssd ?? null, motion60 }, this.reference);
    return { ...result, rmssd60: hrv?.rmssd ?? null };
  }
}
