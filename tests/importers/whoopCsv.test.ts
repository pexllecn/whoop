import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { sql } from 'drizzle-orm';
import { importWhoopExport, parseWhoopExport, readWhoopUpload, shiftLocalDate, zoneResolver } from '@/lib/importers/whoopCsv';
import { parseCsv } from '@/lib/importers/csv';
import { dailySummaries, sleepSessions, workouts } from '@/lib/storage/schema';
import { memoryDb } from '../helpers/db';

const CYCLES = `Cycle start time,Cycle end time,Cycle timezone,Recovery score %,Resting heart rate (bpm),Heart rate variability (ms),Skin temp (celsius),Blood oxygen %,Day Strain,Energy burned (cal),Max HR (bpm),Average HR (bpm),Sleep onset,Wake onset,Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %,Mystery column
2026-09-30 23:05:10,2026-10-01 22:48:01,UTC-04:00,68,51,64,33.6,96.4,12.7,2410,171,72,2026-09-30 23:05:10,2026-10-01 06:58:44,91,14.8,431,473,221,98,112,42,474,22,91,84,x
2026-10-01 22:48:01,,UTC-04:00,,,,,,4.1,980,,,,,,,,,,,,,,,,,
`;

const SLEEPS = `Cycle start time,Cycle end time,Cycle timezone,Sleep onset,Wake onset,Sleep performance %,Respiratory rate (rpm),Asleep duration (min),In bed duration (min),Light sleep duration (min),Deep (SWS) duration (min),REM duration (min),Awake duration (min),Sleep need (min),Sleep debt (min),Sleep efficiency %,Sleep consistency %,Nap
2026-09-30 23:05:10,2026-10-01 22:48:01,UTC-04:00,2026-09-30 23:05:10,2026-10-01 06:58:44,91,14.8,431,473,221,98,112,42,474,22,91,84,false
2026-09-30 23:05:10,2026-10-01 22:48:01,UTC-04:00,2026-10-01 14:10:00,2026-10-01 14:41:00,,,28,31,20,0,8,3,,,90,,true
`;

const WORKOUTS = `Cycle start time,Cycle end time,Cycle timezone,Workout start time,Workout end time,Duration (min),Activity name,Activity Strain,Energy burned (cal),Max HR (bpm),Average HR (bpm),HR Zone 1 %,HR Zone 2 %,HR Zone 3 %,HR Zone 4 %,HR Zone 5 %,GPS enabled,Distance (meters),Altitude gain (meters),Altitude change (meters)
2026-09-30 23:05:10,2026-10-01 22:48:01,UTC-04:00,2026-10-01 17:30:00,2026-10-01 18:20:00,50,Running,11.4,612,171,148,10,30,40,20,0,true,8400,55,3
`;

const FILES = [
  { name: 'physiological_cycles.csv', text: CYCLES },
  { name: 'sleeps.csv', text: SLEEPS },
  { name: 'workouts.csv', text: WORKOUTS },
  { name: 'journal_entries.csv', text: 'Cycle start time,Question text,Answered yes\n2026-09-30 23:05:10,Alcohol?,false\n' },
];

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseCsv('a\n"open')).toThrow();
  });
});

describe('zone handling', () => {
  it('converts local times with UTC offsets to instants', () => {
    expect(zoneResolver('UTC-04:00', 'UTC')('2026-10-01 06:58:44')).toBe(Date.UTC(2026, 9, 1, 10, 58, 44));
    expect(zoneResolver('UTC+05:30', 'UTC')('2026-10-01 06:00:00')).toBe(Date.UTC(2026, 9, 1, 0, 30, 0));
    expect(zoneResolver('UTC', 'Europe/Berlin')('2026-10-01 06:00:00')).toBe(Date.UTC(2026, 9, 1, 6, 0, 0));
    expect(zoneResolver(null, 'Europe/Berlin')('2026-10-01 06:00:00')).toBe(Date.UTC(2026, 9, 1, 4, 0, 0));
  });

  it('shifts local dates without time-zone drift', () => {
    expect(shiftLocalDate('2026-09-30 23:05:10', 12)).toBe('2026-10-01');
    expect(shiftLocalDate('2026-10-01 01:30:00', 12)).toBe('2026-10-01');
  });
});

describe('parseWhoopExport', () => {
  const parsed = parseWhoopExport(FILES, 'UTC');

  it('classifies every file', () => {
    expect(parsed.files.map((f) => f.kind)).toEqual(['cycles', 'sleeps', 'workouts', 'journal']);
  });

  it('maps cycles to the wake-up day with WHOOP values untouched', () => {
    expect(parsed.days[0]).toEqual({
      date: '2026-10-01',
      recovery: 68,
      restingHr: 51,
      hrvRmssd: 64,
      skinTempC: 33.6,
      spo2: 96.4,
      dayStrain: 12.7,
      kcal: 2410,
      sleepPerformance: 91,
      respRate: 14.8,
      sleepActualMs: 431 * 60_000,
      sleepNeedMs: 474 * 60_000,
      sleepDebtMs: 22 * 60_000,
      sleepEfficiency: 91,
      sleepConsistency: 84,
    });
    // Second cycle has no wake onset yet: dated by cycle start + 12 h, empty scores stay null.
    expect(parsed.days[1]).toMatchObject({ date: '2026-10-02', recovery: null, dayStrain: 4.1 });
  });

  it('parses sleeps including naps', () => {
    expect(parsed.sleeps).toHaveLength(2);
    expect(parsed.sleeps[0]).toMatchObject({ isNap: false, startTs: Date.UTC(2026, 9, 1, 3, 5, 10), deepMs: 98 * 60_000 });
    expect(parsed.sleeps[1]).toMatchObject({ isNap: true, date: '2026-10-01' });
  });

  it('converts zone percentages into durations', () => {
    expect(parsed.workouts[0]).toMatchObject({ sport: 'Running', strain: 11.4, distanceM: 8400 });
    expect(parsed.workouts[0]!.zoneMs).toEqual([300_000, 900_000, 1_200_000, 600_000, 0]);
  });

  it('reports columns it does not understand', () => {
    expect(parsed.files[0]!.unknownColumns).toEqual(['Mystery column']);
  });
});

describe('importWhoopExport', () => {
  it('writes rows with source whoop_csv and is idempotent', () => {
    const db = memoryDb();
    const report = importWhoopExport(db, FILES, 'UTC');
    expect(report).toMatchObject({ days: 2, sleeps: 2, workouts: 1, dateRange: { from: '2026-10-01', to: '2026-10-02' } });
    importWhoopExport(db, FILES, 'UTC');
    const n = (t: typeof dailySummaries | typeof sleepSessions | typeof workouts) => db.select({ n: sql<number>`count(*)` }).from(t).get()!.n;
    expect([n(dailySummaries), n(sleepSessions), n(workouts)]).toEqual([2, 2, 1]);
    expect(db.select().from(dailySummaries).all()[0]).toMatchObject({ source: 'whoop_csv', recovery: 68 });
  });

  it('reads CSVs straight out of the export ZIP', () => {
    const zip = zipSync({ 'my_whoop_data/physiological_cycles.csv': strToU8(CYCLES), 'my_whoop_data/readme.txt': strToU8('hi') });
    const files = readWhoopUpload('export.zip', zip);
    expect(files.map((f) => f.name)).toEqual(['my_whoop_data/physiological_cycles.csv']);
    expect(parseWhoopExport(files, 'UTC').days).toHaveLength(2);
  });
});
