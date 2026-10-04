/**
 * Raw packet replay: re-run stored notifications through the current decoder.
 *
 * Because every notification is stored verbatim, newly mapped byte offsets
 * (bump PARSER_VERSION) can be applied to the entire history: derived rows for
 * the replayed id range are deleted and rebuilt, and each packet's
 * decoded_status / parser_version is refreshed.
 */
import { and, asc, eq, gt, gte, isNull, lt, lte, max, min, ne, or, sql } from 'drizzle-orm';
import { PARSER_VERSION } from '../protocol/constants';
import { hexToBytes } from '../protocol/bytes';
import { PacketDecoder } from '../protocol/decoder';
import { writeDerivedRows } from '../pipeline/ingest';
import type { OpenPulseDb } from './db';
import { hrRrSamples, motionSamples, rawPackets } from './schema';

export interface ReplayOptions {
  fromId?: number;
  toId?: number;
  /** Start from the oldest packet decoded by an older parser (or never decoded). */
  staleOnly?: boolean;
  batchSize?: number;
  onProgress?: (processed: number, total: number) => void;
}

export interface ReplayReport {
  fromId: number | null;
  toId: number | null;
  packets: number;
  statuses: Record<string, number>;
  derivedHeartRate: number;
  derivedMotion: number;
  /** Time span covered by rebuilt samples; recompute daily summaries over it. */
  sampleRange: { from: number; to: number } | null;
  parserVersion: number;
}

export function replayRawPackets(db: OpenPulseDb, options: ReplayOptions = {}): ReplayReport {
  const bounds = db.select({ lo: min(rawPackets.id), hi: max(rawPackets.id) }).from(rawPackets).get();
  const empty: ReplayReport = {
    fromId: null,
    toId: null,
    packets: 0,
    statuses: {},
    derivedHeartRate: 0,
    derivedMotion: 0,
    sampleRange: null,
    parserVersion: PARSER_VERSION,
  };
  if (!bounds || bounds.lo === null || bounds.hi === null) return empty;

  let fromId = options.fromId ?? bounds.lo;
  const toId = options.toId ?? bounds.hi;
  if (options.staleOnly) {
    const stale = db
      .select({ id: min(rawPackets.id) })
      .from(rawPackets)
      .where(
        or(
          isNull(rawPackets.parserVersion),
          lt(rawPackets.parserVersion, PARSER_VERSION),
          eq(rawPackets.decodedStatus, 'pending'),
          eq(rawPackets.decodedStatus, 'error'),
        ),
      )
      .get();
    if (!stale || stale.id === null) return { ...empty, fromId: null, toId: null };
    fromId = Math.max(fromId, stale.id);
  }
  if (fromId > toId) return empty;

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(rawPackets)
      .where(and(gte(rawPackets.id, fromId), lte(rawPackets.id, toId)))
      .get()?.n ?? 0;

  db.transaction((tx) => {
    tx.delete(hrRrSamples).where(and(gte(hrRrSamples.rawPacketId, fromId), lte(hrRrSamples.rawPacketId, toId))).run();
    tx.delete(motionSamples).where(and(gte(motionSamples.rawPacketId, fromId), lte(motionSamples.rawPacketId, toId))).run();
  });

  const decoders = new Map<string, PacketDecoder>();
  const statuses: Record<string, number> = {};
  let derivedHeartRate = 0;
  let derivedMotion = 0;
  let rangeFrom = Number.POSITIVE_INFINITY;
  let rangeTo = Number.NEGATIVE_INFINITY;
  let processed = 0;
  let cursor = fromId - 1;
  const batchSize = options.batchSize ?? 5000;

  while (true) {
    const batch = db
      .select()
      .from(rawPackets)
      .where(and(gt(rawPackets.id, cursor), lte(rawPackets.id, toId)))
      .orderBy(asc(rawPackets.id))
      .limit(batchSize)
      .all();
    if (batch.length === 0) break;

    db.transaction((tx) => {
      for (const packet of batch) {
        const key = packet.deviceId ?? `transport:${packet.source}`;
        let decoder = decoders.get(key);
        if (!decoder) {
          decoder = new PacketDecoder();
          decoders.set(key, decoder);
        }
        let status: string;
        try {
          const outcome = decoder.decode(packet.characteristicUuid, hexToBytes(packet.payloadHex), packet.receivedAt);
          writeDerivedRows(tx as unknown as OpenPulseDb, packet.id, outcome.events);
          for (const event of outcome.events) {
            if (event.type === 'heart_rate') derivedHeartRate++;
            if (event.type === 'motion') derivedMotion++;
            if (event.type === 'heart_rate' || event.type === 'motion') {
              rangeFrom = Math.min(rangeFrom, event.at);
              rangeTo = Math.max(rangeTo, event.at);
            }
          }
          status = outcome.status;
          tx.update(rawPackets)
            .set({
              decodedStatus: outcome.status,
              packetType: outcome.packetType,
              frameCount: outcome.frames,
              decodeError: outcome.error,
              parserVersion: outcome.parserVersion,
            })
            .where(eq(rawPackets.id, packet.id))
            .run();
        } catch (error) {
          status = 'error';
          tx.update(rawPackets)
            .set({ decodedStatus: 'error', decodeError: error instanceof Error ? error.message : String(error), parserVersion: PARSER_VERSION })
            .where(eq(rawPackets.id, packet.id))
            .run();
        }
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    });

    processed += batch.length;
    cursor = batch[batch.length - 1]!.id;
    options.onProgress?.(processed, total);
  }

  return {
    fromId,
    toId,
    packets: processed,
    statuses,
    derivedHeartRate,
    derivedMotion,
    sampleRange: Number.isFinite(rangeFrom) ? { from: rangeFrom, to: rangeTo } : null,
    parserVersion: PARSER_VERSION,
  };
}

/** Counts by decoded_status, for the device page. */
export function rawPacketStatusCounts(db: OpenPulseDb): Record<string, number> {
  const rows = db
    .select({ status: rawPackets.decodedStatus, n: sql<number>`count(*)` })
    .from(rawPackets)
    .groupBy(rawPackets.decodedStatus)
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Packets decoded by an older parser version, i.e. candidates for replay. */
export function stalePacketCount(db: OpenPulseDb): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(rawPackets)
      .where(or(isNull(rawPackets.parserVersion), ne(rawPackets.parserVersion, PARSER_VERSION)))
      .get()?.n ?? 0
  );
}
