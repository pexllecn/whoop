/**
 * Historical import CLI.
 *   npm run import -- ~/Downloads/my_whoop_data.zip
 *   npm run import -- ~/Downloads/export.zip --type apple
 *   npm run import -- physiological_cycles.csv sleeps.csv workouts.csv
 * Options: --type whoop|apple (auto-detected otherwise), --tz <IANA zone>
 */
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { recomputeRange } from '../pipeline/dailyProcessor';
import { openDatabase } from '../storage/db';
import { getSettings } from '../storage/settings';
import { addDays, dateKey, isValidTimeZone } from '../time';
import { importAppleHealthFile } from './appleHealth';
import { importWhoopExport, readWhoopUpload } from './whoopCsv';

/** Peek at a ZIP's central directory (the last bytes of the file) for an Apple export.xml. */
export function detectImportType(filePath: string): 'whoop' | 'apple' {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.xml')) return 'apple';
  if (lower.endsWith('.csv')) return 'whoop';
  if (lower.endsWith('.zip')) {
    const fd = openSync(filePath, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, 1 << 20);
      const tail = Buffer.alloc(length);
      readSync(fd, tail, 0, length, size - length);
      return /export\.xml/i.test(tail.toString('latin1')) ? 'apple' : 'whoop';
    } finally {
      closeSync(fd);
    }
  }
  throw new Error(`Cannot tell what ${filePath} is; pass --type whoop|apple`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const typeIndex = args.indexOf('--type');
  const tzIndex = args.indexOf('--tz');
  const forced = typeIndex >= 0 ? args[typeIndex + 1] : undefined;
  const files = args.filter((a, i) => !a.startsWith('--') && i !== typeIndex + 1 && i !== tzIndex + 1);
  if (files.length === 0) throw new Error('Usage: npm run import -- <file...> [--type whoop|apple] [--tz Zone]');

  const db = openDatabase();
  const settings = getSettings(db);
  const timeZone = tzIndex >= 0 && isValidTimeZone(args[tzIndex + 1] ?? '') ? args[tzIndex + 1]! : settings.timeZone;
  const type = (forced as 'whoop' | 'apple' | undefined) ?? detectImportType(files[0]!);
  let earliest: string | null = null;

  if (type === 'apple') {
    for (const file of files) {
      console.log(`Importing Apple Health export ${file} ...`);
      const report = await importAppleHealthFile(db, file, timeZone);
      console.log(JSON.stringify({ ...report, recordCounts: undefined }, null, 2));
      if (report.dateRange && (!earliest || report.dateRange.from < earliest)) earliest = report.dateRange.from;
    }
  } else {
    const inputs = files.flatMap((file) => readWhoopUpload(path.basename(file), new Uint8Array(readFileSync(file))));
    console.log(`Importing WHOOP export (${inputs.map((f) => f.name).join(', ')}) ...`);
    const report = importWhoopExport(db, inputs, timeZone);
    console.log(JSON.stringify(report, null, 2));
    earliest = report.dateRange?.from ?? null;
    // Imported WHOOP HRV / RHR bootstrap the baselines for days without strap data.
    if (earliest) {
      const today = dateKey(Date.now(), settings.timeZone);
      const from = earliest < addDays(today, -400) ? addDays(today, -400) : earliest;
      console.log(`Rebuilding baselines ${from} .. ${today}`);
      recomputeRange({ db, settings }, from, today);
    }
  }
  db.$client.close();
}

if (process.argv[1]?.endsWith('cli.ts') || process.argv[1]?.endsWith('cli.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
