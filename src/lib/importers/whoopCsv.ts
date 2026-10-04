/**
 * Importer for the CSV data export produced by the WHOOP app
 * (physiological_cycles.csv, sleeps.csv, workouts.csv, journal_entries.csv;
 * delivered as a ZIP). Imported values are WHOOP's own and are stored with
 * source 'whoop_csv', separate from OpenPulse's locally computed scores.
 *
 * Columns are matched by normalised header name with aliases, so minor export
 * format changes do not break the import; unrecognised columns are reported.
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { OpenPulseDb } from '../storage/db';
import { dailySummaries, importRuns, sleepSessions, workouts } from '../storage/schema';
import { MINUTE_MS, isValidTimeZone, zonedTime } from '../time';
import { columnReader, parseCsvTable, type CsvTable } from './csv';

export const WHOOP_COLUMNS = {
  cycleStart: ['Cycle start time'],
  cycleEnd: ['Cycle end time'],
  cycleTimezone: ['Cycle timezone'],
  recovery: ['Recovery score %', 'Recovery score'],
  restingHr: ['Resting heart rate (bpm)', 'Resting heart rate'],
  hrv: ['Heart rate variability (ms)', 'HRV (ms)'],
  skinTemp: ['Skin temp (celsius)', 'Skin temperature (celsius)'],
  spo2: ['Blood oxygen %', 'SpO2 %'],
  dayStrain: ['Day Strain', 'Strain'],
  energy: ['Energy burned (cal)', 'Calories burned (cal)', 'Energy burned (kcal)'],
  maxHr: ['Max HR (bpm)'],
  avgHr: ['Average HR (bpm)'],
  sleepOnset: ['Sleep onset'],
  wakeOnset: ['Wake onset'],
  sleepPerformance: ['Sleep performance %'],
  respRate: ['Respiratory rate (rpm)'],
  asleepMin: ['Asleep duration (min)'],
  inBedMin: ['In bed duration (min)'],
  lightMin: ['Light sleep duration (min)'],
  deepMin: ['Deep (SWS) duration (min)', 'Deep sleep duration (min)', 'SWS duration (min)'],
  remMin: ['REM duration (min)'],
  awakeMin: ['Awake duration (min)'],
  sleepNeedMin: ['Sleep need (min)'],
  sleepDebtMin: ['Sleep debt (min)'],
  sleepEfficiency: ['Sleep efficiency %'],
  sleepConsistency: ['Sleep consistency %'],
  nap: ['Nap'],
  workoutStart: ['Workout start time'],
  workoutEnd: ['Workout end time'],
  durationMin: ['Duration (min)'],
  activityName: ['Activity name', 'Sport'],
  activityStrain: ['Activity Strain', 'Workout strain'],
  zone1: ['HR Zone 1 %'],
  zone2: ['HR Zone 2 %'],
  zone3: ['HR Zone 3 %'],
  zone4: ['HR Zone 4 %'],
  zone5: ['HR Zone 5 %'],
  gps: ['GPS enabled'],
  distance: ['Distance (meters)'],
  altitudeGain: ['Altitude gain (meters)'],
  altitudeChange: ['Altitude change (meters)'],
} as const satisfies Record<string, readonly string[]>;

type ColumnKey = keyof typeof WHOOP_COLUMNS;
const cols = (key: ColumnKey) => [...WHOOP_COLUMNS[key]];

export type WhoopFileKind = 'cycles' | 'sleeps' | 'workouts' | 'journal' | 'unknown';

export interface WhoopDay {
  date: string;
  recovery: number | null;
  restingHr: number | null;
  hrvRmssd: number | null;
  skinTempC: number | null;
  spo2: number | null;
  dayStrain: number | null;
  kcal: number | null;
  sleepPerformance: number | null;
  respRate: number | null;
  sleepActualMs: number | null;
  sleepNeedMs: number | null;
  sleepDebtMs: number | null;
  sleepEfficiency: number | null;
  sleepConsistency: number | null;
}

export interface WhoopSleep {
  externalId: string;
  date: string;
  startTs: number;
  endTs: number;
  isNap: boolean;
  inBedMs: number | null;
  awakeMs: number | null;
  lightMs: number | null;
  deepMs: number | null;
  remMs: number | null;
  performance: number | null;
  efficiency: number | null;
  consistency: number | null;
  respRate: number | null;
  needMs: number | null;
  debtMs: number | null;
}

export interface WhoopWorkout {
  externalId: string;
  date: string;
  startTs: number;
  endTs: number;
  sport: string;
  strain: number | null;
  kcal: number | null;
  avgHr: number | null;
  maxHr: number | null;
  zoneMs: [number | null, number | null, number | null, number | null, number | null];
  distanceM: number | null;
}

export interface WhoopFileReport {
  name: string;
  kind: WhoopFileKind;
  rows: number;
  imported: number;
  skipped: number;
  unknownColumns: string[];
}

export interface ParsedWhoopExport {
  days: WhoopDay[];
  sleeps: WhoopSleep[];
  workouts: WhoopWorkout[];
  files: WhoopFileReport[];
  warnings: string[];
}

/** Parse "UTC-04:00", "+01:00", "UTC", "GMT+5" or an IANA zone into a resolver for local wall times. */
export function zoneResolver(zone: string | null, fallbackTimeZone: string): (local: string) => number | null {
  const parseLocal = (local: string) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(local.trim());
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}`, minutes: Number(m[4]) * 60 + Number(m[5]) + Number(m[6] ?? 0) / 60 };
  };
  const trimmed = zone?.trim() ?? '';
  const offsetMatch = /^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(trimmed);
  if (/^(UTC|GMT|Z)$/i.test(trimmed) || offsetMatch) {
    const offset = offsetMatch ? (offsetMatch[1] === '-' ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] ?? 0)) : 0;
    return (local) => {
      const p = parseLocal(local);
      if (!p) return null;
      const [y, mo, d] = p.date.split('-').map(Number) as [number, number, number];
      return Date.UTC(y, mo - 1, d) + (p.minutes - offset) * MINUTE_MS;
    };
  }
  const tz = trimmed && isValidTimeZone(trimmed) ? trimmed : fallbackTimeZone;
  return (local) => {
    const p = parseLocal(local);
    return p ? zonedTime(p.date, p.minutes, tz) : null;
  };
}

export function classifyWhoopFile(name: string, table: CsvTable): WhoopFileKind {
  const reader = columnReader(table);
  const base = name.toLowerCase().split('/').pop() ?? '';
  if (base.startsWith('physiological_cycles') || reader.has(cols('recovery')) || reader.has(cols('dayStrain'))) return 'cycles';
  if (base.startsWith('workouts') || reader.has(cols('activityName')) || reader.has(cols('workoutStart'))) return 'workouts';
  if (base.startsWith('sleeps') || (reader.has(cols('sleepOnset')) && reader.has(cols('nap')))) return 'sleeps';
  if (base.startsWith('journal')) return 'journal';
  return 'unknown';
}

const minutesToMs = (value: number | null) => (value === null ? null : Math.round(value * MINUTE_MS));
const localDate = (value: string | null) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

/** Calendar date of a local wall time ("YYYY-MM-DD HH:MM") shifted by `hours`. */
export function shiftLocalDate(local: string, hours: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(local.trim());
  if (!m) return localDate(local);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return new Date(wall + hours * 3_600_000).toISOString().slice(0, 10);
}

export function parseWhoopExport(files: Array<{ name: string; text: string }>, fallbackTimeZone: string): ParsedWhoopExport {
  const result: ParsedWhoopExport = { days: [], sleeps: [], workouts: [], files: [], warnings: [] };

  for (const file of files) {
    const table = parseCsvTable(file.text);
    const kind = classifyWhoopFile(file.name, table);
    const reader = columnReader(table);
    const report: WhoopFileReport = {
      name: file.name,
      kind,
      rows: table.rows.length,
      imported: 0,
      skipped: 0,
      unknownColumns: kind === 'journal' || kind === 'unknown' ? [] : reader.unmatched(Object.values(WHOOP_COLUMNS).map((a) => [...a])),
    };

    for (const row of table.rows) {
      const zone = reader.text(row, cols('cycleTimezone'));
      const toMs = zoneResolver(zone, fallbackTimeZone);

      if (kind === 'cycles') {
        const wake = reader.text(row, cols('wakeOnset'));
        const cycleStart = reader.text(row, cols('cycleStart'));
        // A cycle belongs to the day you wake up in; fall back to the local cycle start + 12 h.
        const date = localDate(wake) ?? (cycleStart ? shiftLocalDate(cycleStart, 12) : null);
        if (!date) {
          report.skipped++;
          continue;
        }
        result.days.push({
          date,
          recovery: reader.number(row, cols('recovery')),
          restingHr: reader.number(row, cols('restingHr')),
          hrvRmssd: reader.number(row, cols('hrv')),
          skinTempC: reader.number(row, cols('skinTemp')),
          spo2: reader.number(row, cols('spo2')),
          dayStrain: reader.number(row, cols('dayStrain')),
          kcal: reader.number(row, cols('energy')),
          sleepPerformance: reader.number(row, cols('sleepPerformance')),
          respRate: reader.number(row, cols('respRate')),
          sleepActualMs: minutesToMs(reader.number(row, cols('asleepMin'))),
          sleepNeedMs: minutesToMs(reader.number(row, cols('sleepNeedMin'))),
          sleepDebtMs: minutesToMs(reader.number(row, cols('sleepDebtMin'))),
          sleepEfficiency: reader.number(row, cols('sleepEfficiency')),
          sleepConsistency: reader.number(row, cols('sleepConsistency')),
        });
        report.imported++;
      } else if (kind === 'sleeps') {
        const onset = reader.text(row, cols('sleepOnset'));
        const wake = reader.text(row, cols('wakeOnset'));
        const startTs = onset ? toMs(onset) : null;
        const endTs = wake ? toMs(wake) : null;
        if (startTs === null || endTs === null || endTs <= startTs) {
          report.skipped++;
          continue;
        }
        const napText = reader.text(row, cols('nap'))?.toLowerCase();
        result.sleeps.push({
          externalId: `whoop:${startTs}`,
          date: localDate(wake)!,
          startTs,
          endTs,
          isNap: napText === 'true' || napText === 'yes' || napText === '1',
          inBedMs: minutesToMs(reader.number(row, cols('inBedMin'))),
          awakeMs: minutesToMs(reader.number(row, cols('awakeMin'))),
          lightMs: minutesToMs(reader.number(row, cols('lightMin'))),
          deepMs: minutesToMs(reader.number(row, cols('deepMin'))),
          remMs: minutesToMs(reader.number(row, cols('remMin'))),
          performance: reader.number(row, cols('sleepPerformance')),
          efficiency: reader.number(row, cols('sleepEfficiency')),
          consistency: reader.number(row, cols('sleepConsistency')),
          respRate: reader.number(row, cols('respRate')),
          needMs: minutesToMs(reader.number(row, cols('sleepNeedMin'))),
          debtMs: minutesToMs(reader.number(row, cols('sleepDebtMin'))),
        });
        report.imported++;
      } else if (kind === 'workouts') {
        const start = reader.text(row, cols('workoutStart'));
        const end = reader.text(row, cols('workoutEnd'));
        const startTs = start ? toMs(start) : null;
        let endTs = end ? toMs(end) : null;
        const durationMin = reader.number(row, cols('durationMin'));
        if (startTs !== null && endTs === null && durationMin !== null) endTs = startTs + durationMin * MINUTE_MS;
        if (startTs === null || endTs === null || endTs <= startTs) {
          report.skipped++;
          continue;
        }
        const sport = reader.text(row, cols('activityName')) ?? 'Activity';
        const durationMs = endTs - startTs;
        const zone = (key: ColumnKey) => {
          const pct = reader.number(row, cols(key));
          return pct === null ? null : Math.round((pct / 100) * durationMs);
        };
        result.workouts.push({
          externalId: `whoop:${startTs}:${sport}`,
          date: localDate(start)!,
          startTs,
          endTs,
          sport,
          strain: reader.number(row, cols('activityStrain')),
          kcal: reader.number(row, cols('energy')),
          avgHr: reader.number(row, cols('avgHr')),
          maxHr: reader.number(row, cols('maxHr')),
          zoneMs: [zone('zone1'), zone('zone2'), zone('zone3'), zone('zone4'), zone('zone5')],
          distanceM: reader.number(row, cols('distance')),
        });
        report.imported++;
      } else {
        report.skipped++;
      }
    }

    if (kind === 'unknown') result.warnings.push(`${file.name}: not a recognised WHOOP export file`);
    if (report.unknownColumns.length) result.warnings.push(`${file.name}: ignored columns ${report.unknownColumns.join(', ')}`);
    result.files.push(report);
  }
  return result;
}

/** Extract CSV files from a WHOOP export ZIP (or pass through a single CSV). */
export function readWhoopUpload(name: string, data: Uint8Array): Array<{ name: string; text: string }> {
  const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if (!isZip) return [{ name, text: new TextDecoder('utf-8').decode(data) }];
  const entries = unzipSync(data, { filter: (file) => file.name.toLowerCase().endsWith('.csv') && !file.name.startsWith('__MACOSX') });
  return Object.entries(entries).map(([entryName, bytes]) => ({ name: entryName, text: strFromU8(bytes) }));
}

export interface WhoopImportReport {
  source: 'whoop_csv';
  days: number;
  sleeps: number;
  workouts: number;
  files: WhoopFileReport[];
  warnings: string[];
  dateRange: { from: string; to: string } | null;
}

export function importWhoopExport(db: OpenPulseDb, files: Array<{ name: string; text: string }>, fallbackTimeZone: string): WhoopImportReport {
  const startedAt = Date.now();
  const parsed = parseWhoopExport(files, fallbackTimeZone);
  const now = Date.now();

  db.transaction((tx) => {
    for (const day of parsed.days) {
      const values = {
        date: day.date,
        source: 'whoop_csv',
        recovery: day.recovery,
        hrvRmssd: day.hrvRmssd,
        restingHr: day.restingHr,
        respRate: day.respRate,
        skinTempC: day.skinTempC,
        spo2: day.spo2,
        dayStrain: day.dayStrain,
        kcal: day.kcal,
        sleepPerformance: day.sleepPerformance,
        sleepNeedMs: day.sleepNeedMs,
        sleepActualMs: day.sleepActualMs,
        sleepDebtMs: day.sleepDebtMs,
        sleepConsistency: day.sleepConsistency,
        sleepEfficiency: day.sleepEfficiency,
        calibrating: false,
        updatedAt: now,
      };
      tx.insert(dailySummaries)
        .values(values)
        .onConflictDoUpdate({ target: [dailySummaries.date, dailySummaries.source], set: values })
        .run();
    }
    for (const s of parsed.sleeps) {
      const values = {
        source: 'whoop_csv',
        externalId: s.externalId,
        date: s.date,
        startTs: s.startTs,
        endTs: s.endTs,
        isNap: s.isNap,
        inBedMs: s.inBedMs,
        awakeMs: s.awakeMs,
        lightMs: s.lightMs,
        deepMs: s.deepMs,
        remMs: s.remMs,
        efficiency: s.efficiency,
        respRate: s.respRate,
        performance: s.performance,
        consistency: s.consistency,
        needMs: s.needMs,
        computedAt: now,
      };
      tx.insert(sleepSessions)
        .values(values)
        .onConflictDoUpdate({ target: [sleepSessions.source, sleepSessions.externalId], set: values })
        .run();
    }
    for (const w of parsed.workouts) {
      const values = {
        source: 'whoop_csv',
        externalId: w.externalId,
        date: w.date,
        startTs: w.startTs,
        endTs: w.endTs,
        sport: w.sport,
        strain: w.strain,
        avgHr: w.avgHr,
        maxHr: w.maxHr,
        kcal: w.kcal,
        zone1Ms: w.zoneMs[0],
        zone2Ms: w.zoneMs[1],
        zone3Ms: w.zoneMs[2],
        zone4Ms: w.zoneMs[3],
        zone5Ms: w.zoneMs[4],
        distanceM: w.distanceM,
        computedAt: now,
      };
      tx.insert(workouts)
        .values(values)
        .onConflictDoUpdate({ target: [workouts.source, workouts.externalId], set: values })
        .run();
    }
  });

  const dates = parsed.days.map((d) => d.date).concat(parsed.sleeps.map((s) => s.date)).sort();
  const report: WhoopImportReport = {
    source: 'whoop_csv',
    days: parsed.days.length,
    sleeps: parsed.sleeps.length,
    workouts: parsed.workouts.length,
    files: parsed.files,
    warnings: parsed.warnings,
    dateRange: dates.length ? { from: dates[0]!, to: dates[dates.length - 1]! } : null,
  };
  db.insert(importRuns)
    .values({
      source: 'whoop_csv',
      filename: files.map((f) => f.name).join(', ').slice(0, 500),
      startedAt,
      finishedAt: Date.now(),
      status: 'ok',
      counts: JSON.stringify({ days: report.days, sleeps: report.sleeps, workouts: report.workouts }),
    })
    .run();
  return report;
}
