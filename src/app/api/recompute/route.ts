import { jsonError, readJson } from '@/lib/api';
import { recomputeRange } from '@/lib/pipeline/dailyProcessor';
import { getDb } from '@/lib/storage/db';
import { getSettings } from '@/lib/storage/settings';
import { addDays, dateKey } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

/** Rescore the last `days` days (default 30) or an explicit range. */
export async function POST(request: Request) {
  const body = await readJson<{ from?: string; to?: string; days?: number }>(request).catch(() => ({}) as { from?: string; to?: string; days?: number });
  const db = getDb();
  const settings = getSettings(db);
  const today = dateKey(Date.now(), settings.timeZone);
  const days = Math.min(400, Math.max(1, Math.round(body.days ?? 30)));
  const from = body.from ?? addDays(today, -(days - 1));
  const to = body.to ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return jsonError('Invalid date range');
  const results = recomputeRange({ db, settings }, from, to);
  return Response.json({ from, to, days: results.length, scored: results.filter((r) => r.hasData).length });
}
