/**
 * Raw-first ingest for the browser (Web Bluetooth) path. The browser batches
 * notifications exactly as received; each is stored verbatim before decoding.
 * One pipeline per device keeps frame reassembly state across batches.
 */
import { jsonError, readJson } from '@/lib/api';
import { IngestPipeline } from '@/lib/pipeline/ingest';
import { hexToBytes } from '@/lib/protocol/bytes';
import { normalizeUuid } from '@/lib/protocol/uuid';
import { getDb } from '@/lib/storage/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Body {
  deviceId: string;
  reset?: boolean;
  packets: Array<{ uuid: string; hex: string; t: number }>;
}

const globalPipelines = globalThis as unknown as { __openpulsePipelines?: Map<string, IngestPipeline> };
const pipelines = (globalPipelines.__openpulsePipelines ??= new Map());

export async function POST(request: Request) {
  let body: Body;
  try {
    body = await readJson<Body>(request, 4 << 20);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Invalid JSON');
  }
  if (typeof body.deviceId !== 'string' || body.deviceId.length === 0 || body.deviceId.length > 128) return jsonError('deviceId required');
  if (!Array.isArray(body.packets) || body.packets.length > 5000) return jsonError('packets must be an array of at most 5000');

  let pipeline = pipelines.get(body.deviceId);
  if (!pipeline || body.reset) {
    pipeline = new IngestPipeline(getDb(), 'web-bluetooth', body.deviceId);
    pipelines.set(body.deviceId, pipeline);
  }
  const statuses: Record<string, number> = {};
  let stored = 0;
  for (const packet of body.packets) {
    let bytes: Uint8Array;
    let uuid: string;
    try {
      bytes = hexToBytes(packet.hex);
      uuid = normalizeUuid(packet.uuid);
    } catch {
      statuses.rejected = (statuses.rejected ?? 0) + 1;
      continue;
    }
    if (bytes.length > 4096 || !Number.isFinite(packet.t)) {
      statuses.rejected = (statuses.rejected ?? 0) + 1;
      continue;
    }
    const { outcome } = pipeline.ingest({ characteristicUuid: uuid, bytes, receivedAt: Math.round(packet.t) });
    statuses[outcome.status] = (statuses[outcome.status] ?? 0) + 1;
    stored++;
  }
  return Response.json({ stored, statuses });
}
