import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { sql } from 'drizzle-orm';
import { AppleHealthParser, buildSleepSessions, importAppleHealthStream, parseAppleDate, sportName } from '@/lib/importers/appleHealth';
import { dailySummaries, hrRrSamples, sleepSessions, workouts } from '@/lib/storage/schema';
import { memoryDb } from '../helpers/db';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Workout)*)>
]>
<HealthData locale="en_GB">
 <ExportDate value="2026-10-03 09:00:00 +0100"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexMale"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-10-02 08:00:00 +0100" endDate="2026-10-02 08:00:00 +0100" value="61"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-10-02 08:05:00 +0100" endDate="2026-10-02 08:05:00 +0100" value="64"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2026-10-02 07:00:00 +0100" endDate="2026-10-02 23:00:00 +0100" value="52"/>
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" startDate="2026-10-02 03:00:00 +0100" endDate="2026-10-02 03:01:00 +0100" value="48">
  <HeartRateVariabilityMetadataList>
   <InstantaneousBeatsPerMinute bpm="58" time="3:00:01.12 AM"/>
  </HeartRateVariabilityMetadataList>
 </Record>
 <Record type="HKQuantityTypeIdentifierHeartRateVariabilitySDNN" sourceName="Watch" unit="ms" startDate="2026-10-02 05:00:00 +0100" endDate="2026-10-02 05:01:00 +0100" value="52"/>
 <Record type="HKQuantityTypeIdentifierOxygenSaturation" sourceName="Watch" unit="%" startDate="2026-10-02 04:00:00 +0100" endDate="2026-10-02 04:00:00 +0100" value="0.97"/>
 <Record type="HKQuantityTypeIdentifierRespiratoryRate" sourceName="Watch" unit="count/min" startDate="2026-10-02 04:00:00 +0100" endDate="2026-10-02 04:00:00 +0100" value="14.5"/>
 <Record type="HKQuantityTypeIdentifierAppleSleepingWristTemperature" sourceName="Watch" unit="degC" startDate="2026-10-02 00:00:00 +0100" endDate="2026-10-02 06:00:00 +0100" value="35.1"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="iPhone" startDate="2026-10-01 22:50:00 +0100" endDate="2026-10-02 06:40:00 +0100" value="HKCategoryValueSleepAnalysisInBed"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-10-01 23:00:00 +0100" endDate="2026-10-02 01:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-10-02 01:00:00 +0100" endDate="2026-10-02 02:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-10-02 02:00:00 +0100" endDate="2026-10-02 02:10:00 +0100" value="HKCategoryValueSleepAnalysisAwake"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2026-10-02 02:10:00 +0100" endDate="2026-10-02 06:30:00 +0100" value="HKCategoryValueSleepAnalysisAsleepREM"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" startDate="2026-10-02 18:00:00 +0100" endDate="2026-10-02 18:45:00 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" startDate="2026-10-02 18:00:00 +0100" endDate="2026-10-02 18:45:00 +0100" sum="310" unit="kcal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" startDate="2026-10-02 18:00:00 +0100" endDate="2026-10-02 18:45:00 +0100" average="128" minimum="80" maximum="161" unit="count/min"/>
 </Workout>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="30" durationUnit="min" totalDistance="5.2" totalDistanceUnit="km" totalEnergyBurned="350" totalEnergyBurnedUnit="kcal" startDate="2026-10-03 07:00:00 +0100" endDate="2026-10-03 07:30:00 +0100"/>
</HealthData>
`;

async function* chunked(data: Uint8Array, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.slice(i, i + size);
}

describe('Apple Health helpers', () => {
  it('parses Apple timestamps with offsets', () => {
    expect(parseAppleDate('2026-10-02 08:00:00 +0100')).toBe(Date.UTC(2026, 9, 2, 7, 0, 0));
    expect(parseAppleDate('2026-10-02 08:00:00 -0530')).toBe(Date.UTC(2026, 9, 2, 13, 30, 0));
    expect(parseAppleDate('garbage')).toBeNull();
  });

  it('turns activity types into readable sport names', () => {
    expect(sportName('HKWorkoutActivityTypeTraditionalStrengthTraining')).toBe('Traditional Strength Training');
    expect(sportName('HKWorkoutActivityTypeHIIT')).toBe('HIIT');
  });

  it('prefers staged sleep over overlapping unstaged in-bed entries', () => {
    const hour = 3600_000;
    const sessions = buildSleepSessions(
      [
        { start: 0, end: 8 * hour, stage: 'in_bed' },
        { start: hour, end: 3 * hour, stage: 'deep' },
        { start: 3 * hour, end: 7 * hour, stage: 'rem' },
      ],
      'UTC',
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ startTs: hour, endTs: 7 * hour, deepMs: 2 * hour, remMs: 4 * hour });
  });
});

describe('AppleHealthParser', () => {
  it('aggregates records, sleep and workouts', () => {
    const hr: number[] = [];
    const parser = new AppleHealthParser('Europe/London', { heartRate: (batch) => hr.push(...batch.map((b) => b.bpm)) });
    parser.write(XML);
    const parsed = parser.finish();
    expect(hr).toEqual([61, 64]);
    expect(parsed.days).toEqual([
      { date: '2026-10-02', restingHr: 52, hrvSdnn: 50, respRate: 14.5, spo2: 97, skinTempC: 35.1 },
    ]);
    expect(parsed.sleeps).toHaveLength(1);
    expect(parsed.sleeps[0]).toMatchObject({ date: '2026-10-02', isNap: false, lightMs: 2 * 3600_000, deepMs: 3600_000, awakeMs: 600_000 });
    expect(parsed.workouts.map((w) => [w.sport, w.kcal, w.avgHr, w.maxHr, w.distanceM])).toEqual([
      ['Traditional Strength Training', 310, 128, 161, null],
      ['Running', 350, null, null, 5200],
    ]);
  });
});

describe('importAppleHealthStream', () => {
  const count = (db: ReturnType<typeof memoryDb>, t: typeof hrRrSamples | typeof dailySummaries | typeof sleepSessions | typeof workouts) =>
    db.select({ n: sql<number>`count(*)` }).from(t).get()!.n;

  it('imports export.xml streamed in small chunks', async () => {
    const db = memoryDb();
    const report = await importAppleHealthStream(db, chunked(strToU8(XML), 97), { timeZone: 'Europe/London', filename: 'export.xml' });
    expect(report).toMatchObject({ heartRateSamples: 2, days: 1, sleeps: 1, workouts: 2 });
    expect([count(db, hrRrSamples), count(db, dailySummaries), count(db, sleepSessions), count(db, workouts)]).toEqual([2, 1, 1, 2]);
  });

  it('imports export.zip and replaces the previous import', async () => {
    const db = memoryDb();
    const zip = zipSync({ 'apple_health_export/export.xml': strToU8(XML), 'apple_health_export/export_cda.xml': strToU8('<x/>') });
    await importAppleHealthStream(db, chunked(zip, 1024), { timeZone: 'Europe/London', filename: 'export.zip' });
    await importAppleHealthStream(db, chunked(zip, 333), { timeZone: 'Europe/London', filename: 'export.zip' });
    expect([count(db, hrRrSamples), count(db, workouts)]).toEqual([2, 2]);
  });

  it('fails clearly when the ZIP has no export.xml', async () => {
    const zip = zipSync({ 'other.xml': strToU8('<a/>') });
    await expect(importAppleHealthStream(memoryDb(), chunked(zip, 512), { timeZone: 'UTC', filename: 'x.zip' })).rejects.toThrow(/export.xml/);
  });
});
