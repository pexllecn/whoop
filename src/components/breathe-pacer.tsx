'use client';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState } from 'react';
import { LineChart } from './charts/line-chart';
import { liveStore, useLive } from './live/live-store';
import { useLiveConnection } from './live/live-view';
import { Card } from './ui';
import { fmt } from '@/lib/format';

interface Pattern {
  id: string;
  label: string;
  description: string;
  inhale: number;
  holdIn: number;
  exhale: number;
  holdOut: number;
}

const PATTERNS: Pattern[] = [
  { id: 'resonance', label: 'Resonance 5.5/min', description: 'Slow, even breathing near the baroreflex resonance (~0.1 Hz) maximises HRV.', inhale: 5.5, holdIn: 0, exhale: 5.5, holdOut: 0 },
  { id: 'coherent', label: 'Coherent 6/min', description: '5 s in, 5 s out.', inhale: 5, holdIn: 0, exhale: 5, holdOut: 0 },
  { id: 'box', label: 'Box 4-4-4-4', description: 'Equal inhale, hold, exhale and hold.', inhale: 4, holdIn: 4, exhale: 4, holdOut: 4 },
  { id: 'relax', label: 'Long exhale 4-6', description: 'A longer exhale shifts balance towards the parasympathetic system.', inhale: 4, holdIn: 0, exhale: 6, holdOut: 0 },
];

type Phase = 'inhale' | 'holdIn' | 'exhale' | 'holdOut';
const PHASE_LABEL: Record<Phase, string> = { inhale: 'Breathe in', holdIn: 'Hold', exhale: 'Breathe out', holdOut: 'Hold' };

function phaseAt(pattern: Pattern, elapsed: number): { phase: Phase; remaining: number; progress: number } {
  const order: Array<[Phase, number]> = [
    ['inhale', pattern.inhale],
    ['holdIn', pattern.holdIn],
    ['exhale', pattern.exhale],
    ['holdOut', pattern.holdOut],
  ];
  const cycle = order.reduce((s, [, d]) => s + d, 0);
  let t = elapsed % cycle;
  for (const [phase, duration] of order) {
    if (duration <= 0) continue;
    if (t < duration) return { phase, remaining: duration - t, progress: t / duration };
    t -= duration;
  }
  return { phase: 'inhale', remaining: pattern.inhale, progress: 0 };
}

function tone(context: AudioContext, frequency: number) {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.08, context.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.6);
  osc.connect(gain).connect(context.destination);
  osc.start();
  osc.stop(context.currentTime + 0.65);
}

export function BreathePacer({ port, timeZone }: { port: number; timeZone: string }) {
  useLiveConnection(port);
  const live = useLive();
  const reduce = useReducedMotion();
  const [patternId, setPatternId] = useState(PATTERNS[0]!.id);
  const [minutes, setMinutes] = useState(5);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cues, setCues] = useState({ vibrate: false, sound: false, strap: false });
  const lastPhase = useRef<Phase | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const pattern = PATTERNS.find((p) => p.id === patternId)!;
  const strapHaptic = live.status?.commands.find((c) => c.name === 'haptic') ?? null;

  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if ((t - startedAt) / 1000 >= minutes * 60) {
        setRunning(false);
        setFinished(true);
      }
    }, 100);
    return () => clearInterval(timer);
  }, [running, startedAt, minutes]);

  const elapsed = running && startedAt ? (now - startedAt) / 1000 : 0;
  const current = phaseAt(pattern, elapsed);
  const done = !running && finished;

  useEffect(() => {
    if (!running) {
      lastPhase.current = null;
      return;
    }
    if (lastPhase.current === current.phase) return;
    lastPhase.current = current.phase;
    if (cues.vibrate && typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(current.phase === 'inhale' ? 120 : current.phase === 'exhale' ? [60, 60, 60] : 30);
    if (cues.sound && audio.current) tone(audio.current, current.phase === 'inhale' ? 528 : current.phase === 'exhale' ? 396 : 440);
    if (cues.strap && strapHaptic && (current.phase === 'inhale' || current.phase === 'exhale')) void liveStore.sendCommand('haptic');
  }, [current.phase, running, cues, strapHaptic]);

  const start = () => {
    if (cues.sound && !audio.current) audio.current = new AudioContext();
    setStartedAt(Date.now());
    setNow(Date.now());
    setFinished(false);
    setRunning(true);
  };

  const scale = current.phase === 'inhale' ? 0.55 + 0.45 * current.progress : current.phase === 'holdIn' ? 1 : current.phase === 'exhale' ? 1 - 0.45 * current.progress : 0.55;
  const sessionHr = useMemo(() => (startedAt ? live.hr.filter((p) => p.t >= startedAt) : []), [live.hr, startedAt]);
  const latestRmssd = [...live.stress].reverse().find((s) => s.rmssd60 !== null)?.rmssd60 ?? null;
  const clock = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone, minute: '2-digit', second: '2-digit' }).format(t);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card>
        <div className="flex min-h-[420px] flex-col items-center justify-center">
          <div className="relative flex h-72 w-72 items-center justify-center">
            {reduce ? (
              <div className="h-3 w-56 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <div className="h-3 rounded-full bg-accent" style={{ width: `${scale * 100}%` }} />
              </div>
            ) : (
              <>
                <div className="absolute inset-0 rounded-full border border-hair" aria-hidden="true" />
                <motion.div
                  aria-hidden="true"
                  className="absolute rounded-full"
                  style={{ width: 288, height: 288, background: 'radial-gradient(circle, rgb(57 135 229 / 0.55), rgb(57 135 229 / 0.12))' }}
                  animate={{ scale: running ? scale : 0.55 }}
                  transition={{ duration: 0.12, ease: 'linear' }}
                />
              </>
            )}
            <div className="relative text-center" aria-live="polite">
              <AnimatePresence mode="wait">
                <motion.div key={running ? current.phase : 'idle'} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-xl font-semibold">
                  {running ? PHASE_LABEL[current.phase] : done ? 'Done' : 'Ready'}
                </motion.div>
              </AnimatePresence>
              {running && <div className="mt-1 text-sm text-ink-2 tabular">{Math.ceil(current.remaining)} s</div>}
            </div>
          </div>
          <div className="mt-6 flex items-center gap-3">
            {running ? (
              <button type="button" onClick={() => setRunning(false)} className="rounded-lg border border-hair px-4 py-2 text-sm hover:bg-raised">
                Stop
              </button>
            ) : (
              <button type="button" onClick={start} className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white hover:brightness-110">
                Start {minutes}-minute session
              </button>
            )}
            {running && <span className="text-sm text-muted tabular">{Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')} / {minutes}:00</span>}
          </div>
        </div>
      </Card>

      <div className="grid content-start gap-4">
        <Card title="Pattern">
          <fieldset className="space-y-2" disabled={running}>
            <legend className="sr-only">Breathing pattern</legend>
            {PATTERNS.map((p) => (
              <label key={p.id} className={`block cursor-pointer rounded-lg border px-3 py-2 text-sm ${p.id === patternId ? 'border-accent' : 'border-hair hover:bg-raised'}`}>
                <input type="radio" name="pattern" value={p.id} checked={p.id === patternId} onChange={() => setPatternId(p.id)} className="sr-only" />
                <div className="font-medium">{p.label}</div>
                <div className="text-xs text-muted">{p.description}</div>
              </label>
            ))}
          </fieldset>
          <label className="mt-3 flex items-center justify-between text-sm">
            <span className="text-ink-2">Duration</span>
            <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} disabled={running} className="rounded-md border border-hair bg-raised px-2 py-1">
              {[2, 5, 10, 15].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </Card>
        <Card title="Cues">
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cues.vibrate} onChange={(e) => setCues({ ...cues, vibrate: e.target.checked })} /> Vibrate this device (where supported)
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cues.sound} onChange={(e) => setCues({ ...cues, sound: e.target.checked })} /> Soft tone on each phase
            </label>
            <label className={`flex items-center gap-2 ${strapHaptic ? '' : 'opacity-50'}`}>
              <input type="checkbox" disabled={!strapHaptic} checked={cues.strap && Boolean(strapHaptic)} onChange={(e) => setCues({ ...cues, strap: e.target.checked })} /> Strap haptic
            </label>
            {!strapHaptic && (
              <p className="text-xs text-muted">
                Strap haptics need a <code>haptic</code> command in <code>data/protocol-map.json</code>. The opcode is not documented, so OpenPulse never guesses it.
              </p>
            )}
          </div>
        </Card>
        <Card title="Biofeedback">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted">Heart rate</div>
              <div className="text-2xl font-semibold">{live.hr.length ? live.hr[live.hr.length - 1]!.bpm : '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted">RMSSD (60 s)</div>
              <div className="text-2xl font-semibold">{fmt(latestRmssd, 0)}</div>
            </div>
          </div>
          {sessionHr.length > 5 ? (
            <div className="mt-3">
              <LineChart
                series={[{ id: 'hr', label: 'Heart rate', color: 'var(--color-hr)', points: sessionHr.map((p) => ({ x: p.t, y: p.bpm })) }]}
                height={140}
                formatY={(v) => `${Math.round(v)}`}
                formatXTick={clock}
                formatXTooltip={(t) => `${clock(t)} · bpm`}
                ariaLabel="Heart rate during the session"
              />
              <p className="mt-1 text-xs text-muted">With slow breathing, heart rate should rise on each inhale and fall on each exhale.</p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">{live.link === 'disconnected' ? 'Connect the strap to see heart rate respond to your breathing.' : 'Heart rate during the session appears here.'}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
