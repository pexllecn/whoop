/**
 * Fill a database with simulated history so the dashboard can be explored
 * without a strap. Every row is labelled 'simulated'.
 *   npm run seed:demo                     21 days into data/openpulse.db
 *   npm run seed:demo -- --days 30 --db data/demo.db
 *   npm run seed:demo -- --clear          remove simulated data again
 */
import { recomputeRange } from '../src/lib/pipeline/dailyProcessor';
import { clearSimulatedData, seedSimulatedHistory } from '../src/lib/simulation/seed';
import { openDatabase, resolveDbPath } from '../src/lib/storage/db';
import { getSettings, updateSettings } from '../src/lib/storage/settings';
import { addDays, dateKey } from '../src/lib/time';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (value('--db')) process.env.OPENPULSE_DB = value('--db');

const db = openDatabase();
if (args.includes('--clear')) {
  clearSimulatedData(db);
  console.log('Simulated data removed.');
  process.exit(0);
}

const days = Number(value('--days') ?? 21);
let settings = getSettings(db);
if (args.includes('--demo-profile')) {
  settings = updateSettings(db, { profile: { age: 34, sex: 'male', weightKg: 74, heightCm: 178, maxHrOverride: 188 } });
}
const now = Date.now();
const today = dateKey(now, settings.timeZone);
console.log(`Seeding ${days} simulated days into ${resolveDbPath()} (${settings.timeZone}) ...`);
const report = seedSimulatedHistory(db, { days, timeZone: settings.timeZone, until: now, seed: Number(value('--seed') ?? 7) });
console.log(`  ${report.heartRateRows.toLocaleString()} heart-rate rows, ${report.motionRows.toLocaleString()} motion rows`);
console.log('Scoring days ...');
recomputeRange({ db, settings }, addDays(today, -(days - 1)), today, (d) => {
  if (!d.hasData) return;
  console.log(
    `  ${d.date}  recovery ${d.recovery ? `${Math.round(d.recovery.score)}%${d.recovery.calibrating ? ' (calibrating)' : ''}` : '—'}  strain ${d.dayStrain?.toFixed(1) ?? '—'}  sleep ${d.sleep ? (d.sleep.asleepMs / 3_600_000).toFixed(1) + ' h' : '—'}  workouts ${d.workouts}`,
  );
});
db.$client.close();
