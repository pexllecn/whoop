/**
 * Raw-first ingestion: every notification is written verbatim to raw_packets
 * BEFORE decoding. Decoding then produces derived rows (heart rate / R-R,
 * motion) linked back to the raw packet, and the packet's decoded_status is
 * updated. If decoding throws, the raw bytes are still safe and marked 'error'
 * so `npm run replay` can re-parse them with a newer parser.
 */
import { eq } from 'drizzle-orm';
import { bytesToHex } from '../protocol/bytes';
import { PacketDecoder, type DecodeOutcome, type LiveEvent } from '../protocol/decoder';
import { normalizeUuid } from '../protocol/uuid';
import type { RawNotification } from '../ble/session';
import type { TransportKind } from '../ble/transport';
import type { OpenPulseDb } from '../storage/db';
import { hrRrSamples, motionSamples, rawPackets } from '../storage/schema';

export interface IngestResult {
  rawPacketId: number;
  outcome: DecodeOutcome;
}

/** Mean absolute deviation of acceleration magnitude from 1 g. */
export function activityFromImu(samples: Array<{ ax: number; ay: number; az: number }>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += Math.abs(Math.hypot(s.ax, s.ay, s.az) - 1);
  return sum / samples.length;
}

/** Write the derived rows for one decoded notification. */
export function writeDerivedRows(db: OpenPulseDb, rawPacketId: number | null, events: LiveEvent[]): void {
  for (const event of events) {
    if (event.type === 'heart_rate') {
      db.insert(hrRrSamples)
        .values({
          ts: Math.round(event.at),
          bpm: event.bpm,
          rrMs: JSON.stringify(event.rrMs.map((v) => Math.round(v * 1000) / 1000)),
          rrCount: event.rrMs.length,
          rrCandidateMs: event.rrCandidateMs,
          source: event.source,
          sensorContact: event.sensorContact,
          rawPacketId,
        })
        .run();
    } else if (event.type === 'motion' && event.samples.length > 0) {
      db.insert(motionSamples)
        .values({
          ts: Math.round(event.at),
          activityG: activityFromImu(event.samples),
          sampleCount: event.samples.length,
          source: event.historical ? 'proprietary_historical' : 'proprietary_realtime',
          rawPacketId,
        })
        .run();
    }
  }
}

export class IngestPipeline {
  private decoder = new PacketDecoder();

  constructor(
    private readonly db: OpenPulseDb,
    private readonly transport: TransportKind,
    private deviceId: string | null = null,
  ) {}

  /** Call on (re)connect: frame assembly state never spans connections. */
  resetConnection(deviceId: string | null): void {
    this.deviceId = deviceId;
    this.decoder = new PacketDecoder();
  }

  ingest(notification: RawNotification): IngestResult {
    const characteristicUuid = normalizeUuid(notification.characteristicUuid);

    // 1. Persist the raw bytes first, in their own statement.
    const inserted = this.db
      .insert(rawPackets)
      .values({
        receivedAt: notification.receivedAt,
        deviceId: this.deviceId,
        characteristicUuid,
        payloadHex: bytesToHex(notification.bytes),
        decodedStatus: 'pending',
        source: this.transport,
      })
      .returning({ id: rawPackets.id })
      .get();
    const rawPacketId = inserted.id;

    // 2. Decode, then write derived rows and the status atomically.
    let outcome: DecodeOutcome;
    try {
      outcome = this.decoder.decode(characteristicUuid, notification.bytes, notification.receivedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.update(rawPackets).set({ decodedStatus: 'error', decodeError: message }).where(eq(rawPackets.id, rawPacketId)).run();
      return {
        rawPacketId,
        outcome: { status: 'malformed', packetType: null, frames: 0, invalidFrames: 0, events: [], error: message, parserVersion: 0 },
      };
    }

    this.db.transaction((tx) => {
      writeDerivedRows(tx as unknown as OpenPulseDb, rawPacketId, outcome.events);
      tx.update(rawPackets)
        .set({
          decodedStatus: outcome.status,
          packetType: outcome.packetType,
          frameCount: outcome.frames,
          decodeError: outcome.error,
          parserVersion: outcome.parserVersion,
        })
        .where(eq(rawPackets.id, rawPacketId))
        .run();
    });

    return { rawPacketId, outcome };
  }
}
