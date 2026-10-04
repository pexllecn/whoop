/**
 * Time-zone aware calendar helpers built on Intl (no external libraries).
 * All instants are epoch milliseconds (UTC); calendar days are 'YYYY-MM-DD'
 * strings in an IANA time zone.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at instant `ms`, in minutes (e.g. +60 for CET). */
export function timeZoneOffsetMinutes(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function dateKey(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid date key "${key}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addDays(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromKey: string, toKey: string): number {
  const a = parseDateKey(fromKey);
  const b = parseDateKey(toKey);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

/** Epoch ms of a local wall-clock time on a given date in `timeZone`. */
export function zonedTime(key: string, minutesFromMidnight: number, timeZone: string): number {
  const { year, month, day } = parseDateKey(key);
  const wall = Date.UTC(year, month - 1, day) + minutesFromMidnight * MINUTE_MS;
  // Two passes settle the offset across DST transitions.
  let guess = wall - timeZoneOffsetMinutes(wall, timeZone) * MINUTE_MS;
  guess = wall - timeZoneOffsetMinutes(guess, timeZone) * MINUTE_MS;
  return guess;
}

/** Epoch ms of local midnight that starts `key`. */
export function startOfDay(key: string, timeZone: string): number {
  return zonedTime(key, 0, timeZone);
}

export function dayRange(key: string, timeZone: string): { start: number; end: number } {
  return { start: startOfDay(key, timeZone), end: startOfDay(addDays(key, 1), timeZone) };
}

export function enumerateDays(fromKey: string, toKey: string): string[] {
  const out: string[] = [];
  for (let key = fromKey; key <= toKey; key = addDays(key, 1)) out.push(key);
  return out;
}

/** Minutes since local midnight for an instant. */
export function minuteOfDay(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  return p.hour * 60 + p.minute + p.second / 60;
}

export function formatClock(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}
