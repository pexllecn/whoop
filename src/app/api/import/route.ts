/**
 * Upload a WHOOP export (ZIP or CSV) or an Apple Health export (export.zip or
 * export.xml). The body is the raw file; Apple exports are parsed as a stream
 * so multi-gigabyte files never sit in memory.
 *   POST /api/import?kind=whoop|apple&filename=export.zip
 */
import { jsonError } from '@/lib/api';
import { importAppleHealthStream } from '@/lib/importers/appleHealth';
import { importWhoopExport, readWhoopUpload } from '@/lib/importers/whoopCsv';
import { recomputeRange } from '@/lib/pipeline/dailyProcessor';
import { getDb } from '@/lib/storage/db';
import { importRuns } from '@/lib/storage/schema';
import { getSettings } from '@/lib/storage/settings';
import { addDays, dateKey } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

const MAX_WHOOP_BYTES = 256 << 20;

async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) yield value;
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const filename = (url.searchParams.get('filename') ?? 'upload').slice(0, 200);
  if (!request.body) return jsonError('Empty body');
  const db = getDb();
  const settings = getSettings(db);

  try {
    if (kind === 'apple') {
      const report = await importAppleHealthStream(db, bodyChunks(request.body), {
        timeZone: settings.timeZone,
        filename,
        zip: /\.zip$/i.test(filename) ? true : /\.xml$/i.test(filename) ? false : undefined,
      });
      return Response.json(report);
    }
    if (kind === 'whoop') {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of bodyChunks(request.body)) {
        size += chunk.length;
        if (size > MAX_WHOOP_BYTES) return jsonError('WHOOP export larger than 256 MB', 413);
        chunks.push(chunk);
      }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      const report = importWhoopExport(db, readWhoopUpload(filename, data), settings.timeZone);
      if (report.dateRange) {
        const today = dateKey(Date.now(), settings.timeZone);
        const from = report.dateRange.from < addDays(today, -400) ? addDays(today, -400) : report.dateRange.from;
        recomputeRange({ db, settings }, from, today);
      }
      return Response.json(report);
    }
    return jsonError('kind must be "whoop" or "apple"');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.insert(importRuns).values({ source: kind ?? 'unknown', filename, startedAt: Date.now(), finishedAt: Date.now(), status: 'error', error: message }).run();
    return jsonError(`Import failed: ${message}`, 422);
  }
}
