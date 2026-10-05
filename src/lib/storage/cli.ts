/**
 * Storage maintenance CLI.
 *   npm run db:migrate
 *   npm run replay [-- --all]                  re-decode raw packets (stale only by default), then recompute
 *   npm run recompute [-- --from 2026-09-01] [--to 2026-10-04] [--days 30]
 *   npx tsx src/lib/storage/cli.ts prune --sig-raw-older-than 180
 *       delete standard-service (0x2A37 / 0x2A19) raw packets older than N days;
 *       proprietary packets are always kept, derived samples are kept.
 */
import { and, inArray, lt, sql } from 'drizzle-orm';
import { SIG } from '../protocol/constants';
import { recomputeFrom, recomputeRange, sampleSpan } from '../pipeline/dailyProcessor';
import { addDays, dateKey, DAY_MS } from '../time';
import { openDatabase, resolveDbPath } from './db';
import { replayRawPackets } from './replay';
import { hrRrSamples, motionSamples, rawPackets } from './schema';
import { getSettings } from './settings';

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2);
  const db = openDatabase();
  const settings = getSettings(db);
  const ctx = { db, settings };
  const log = (result: { date: string; hasData: boolean; recovery: { score: number } | null; dayStrain: number | null }) => {
    if (result.hasData) {
      console.log(`${result.date}  recovery ${result.recovery ? Math.round(result.recovery.score) + '%' : '—'}  strain ${result.dayStrain?.toFixed(1) ?? '—'}`);
    }
  };

  switch (command) {
    case 'migrate':
      console.log(`Database ready at ${resolveDbPath()}`);
      break;

    case 'replay': {
      const report = replayRawPackets(db, {
        staleOnly: !args.includes('--all'),
        onProgress: (done, total) => process.stdout.write(`\rReplayed ${done}/${total}`),
      });
      process.stdout.write('\n');
      console.log(JSON.stringify({ ...report, statuses: report.statuses }, null, 2));
      if (report.sampleRange) recomputeFrom(ctx, report.sampleRange.from, log);
      break;
    }

    case 'recompute': {
      const today = dateKey(Date.now(), settings.timeZone);
      const span = sampleSpan(db);
      const days = flag(args, 'days');
      const from = flag(args, 'from') ?? (days ? addDays(today, -(Number(days) - 1)) : span ? dateKey(span.from, settings.timeZone) : today);
      const to = flag(args, 'to') ?? today;
      console.log(`Recomputing ${from} .. ${to} (${settings.timeZone})`);
      recomputeRange(ctx, from, to, log);
      break;
    }

    case 'prune': {
      const days = Number(flag(args, 'sig-raw-older-than'));
      if (!Number.isFinite(days) || days < 1) throw new Error('Usage: prune --sig-raw-older-than <days>');
      const cutoff = Date.now() - days * DAY_MS;
      const where = and(lt(rawPackets.receivedAt, cutoff), inArray(rawPackets.characteristicUuid, [SIG.HEART_RATE_MEASUREMENT, SIG.BATTERY_LEVEL]));
      const removed = db.transaction((tx) => {
        const ids = tx.select({ id: rawPackets.id }).from(rawPackets).where(where).all().map((r) => r.id);
        for (let i = 0; i < ids.length; i += 500) {
          const chunk = ids.slice(i, i + 500);
          // Keep the derived samples: detach them before the cascade would remove them.
          tx.update(hrRrSamples).set({ rawPacketId: null }).where(inArray(hrRrSamples.rawPacketId, chunk)).run();
          tx.update(motionSamples).set({ rawPacketId: null }).where(inArray(motionSamples.rawPacketId, chunk)).run();
          tx.delete(rawPackets).where(inArray(rawPackets.id, chunk)).run();
        }
        return ids.length;
      });
      db.$client.exec('VACUUM');
      console.log(`Removed ${removed} standard-service raw packets older than ${days} days.`);
      console.log(`Remaining raw packets: ${db.select({ n: sql<number>`count(*)` }).from(rawPackets).get()?.n ?? 0}`);
      break;
    }

    default:
      console.log('Commands: migrate | replay [--all] | recompute [--from D] [--to D] [--days N] | prune --sig-raw-older-than N');
  }
  db.$client.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
