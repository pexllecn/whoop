/** Display formatting shared by server and client components (no Node APIs). */

export function fmt(value: number | null | undefined, digits = 0, fallback = '—'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtSigned(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const text = fmt(Math.abs(value), digits);
  if (Number(text.replace(/,/g, '')) === 0) return `±${text}`;
  return `${value > 0 ? '+' : '−'}${text}`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function fmtClock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

export function fmtDate(dateKey: string, style: 'long' | 'short' = 'long'): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'long' : 'short',
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
  }).format(d);
}

export function fmtDayShort(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(d);
}

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export type RecoveryBand = 'green' | 'yellow' | 'red';

export function bandOf(score: number): RecoveryBand {
  const r = Math.round(score);
  return r >= 67 ? 'green' : r >= 34 ? 'yellow' : 'red';
}

export const BAND_META: Record<RecoveryBand, { label: string; color: string; icon: string }> = {
  green: { label: 'Green · primed', color: 'var(--color-good)', icon: '▲' },
  yellow: { label: 'Yellow · steady', color: 'var(--color-warn)', icon: '●' },
  red: { label: 'Red · recover', color: 'var(--color-bad)', icon: '▼' },
};

export type StressLevel = 'low' | 'elevated' | 'high';

export function stressLevelOf(score: number): StressLevel {
  return score < 1 ? 'low' : score < 2 ? 'elevated' : 'high';
}

export const STRESS_META: Record<StressLevel, { label: string; color: string }> = {
  low: { label: 'Low', color: 'var(--color-good)' },
  elevated: { label: 'Elevated', color: 'var(--color-warn)' },
  high: { label: 'High', color: 'var(--color-bad)' },
};

export const STAGE_META = {
  awake: { label: 'Awake', color: 'var(--color-stage-awake)' },
  rem: { label: 'REM', color: 'var(--color-stage-rem)' },
  light: { label: 'Light', color: 'var(--color-stage-light)' },
  deep: { label: 'Deep (SWS)', color: 'var(--color-stage-deep)' },
} as const;

export const ZONE_COLORS = [
  'var(--color-zone-0)',
  'var(--color-zone-1)',
  'var(--color-zone-2)',
  'var(--color-zone-3)',
  'var(--color-zone-4)',
  'var(--color-zone-5)',
];

export const SOURCE_LABEL: Record<string, string> = {
  openpulse: 'OpenPulse (local)',
  whoop_csv: 'WHOOP export',
  apple_health: 'Apple Health',
  simulated: 'Simulated',
};
