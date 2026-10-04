import { readJson } from '@/lib/api';
import { recomputeFrom } from '@/lib/pipeline/dailyProcessor';
import { getDb } from '@/lib/storage/db';
import { replayRawPackets } from '@/lib/storage/replay';
import { getSettings } from '@/lib/storage/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

/** Re-decode stored raw packets with the current parser, then rescore affected days. */
export async function POST(request: Request) {
  const body = await readJson<{ all?: boolean }>(request).catch(() => ({ all: false }));
  const db = getDb();
  const report = replayRawPackets(db, { staleOnly: !body.all });
  let days = 0;
  if (report.sampleRange) days = recomputeFrom({ db, settings: getSettings(db) }, report.sampleRange.from).length;
  return Response.json({ ...report, daysRescored: days });
}
