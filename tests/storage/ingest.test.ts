import { describe, expect, it } from 'vitest';
import { hexToBytes, writeU16LE } from '@/lib/protocol/bytes';
import { buildFrame } from '@/lib/protocol/commands';
import { PacketType, SIG, WHOOP5 } from '@/lib/protocol/constants';
import { IngestPipeline, activityFromImu } from '@/lib/pipeline/ingest';
import { hrRrSamples, motionSamples, rawPackets } from '@/lib/storage/schema';
import { memoryDb } from '../helpers/db';

const T = Date.UTC(2026, 9, 4, 8, 0, 0);

function imuFrame(samples: number): Uint8Array {
  const body = new Uint8Array(28 + samples * 12);
  body[0] = PacketType.REALTIME_IMU;
  writeU16LE(body, 24, samples);
  writeU16LE(body, 26, samples);
  for (let i = 0; i < samples; i++) writeU16LE(body, 32 + i * 12, 4096); // az = 1 g
  return buildFrame(body, 0x0001);
}

describe('IngestPipeline (raw-first)', () => {
  it('stores the raw packet and the decoded HR/RR sample', () => {
    const db = memoryDb();
    const pipeline = new IngestPipeline(db, 'noble', 'strap-1');
    const { rawPacketId, outcome } = pipeline.ingest({ characteristicUuid: '2a37', bytes: hexToBytes('10407c03'), receivedAt: T });
    expect(outcome.status).toBe('decoded');
    const raw = db.select().from(rawPackets).all();
    expect(raw).toEqual([
      expect.objectContaining({
        id: rawPacketId,
        receivedAt: T,
        deviceId: 'strap-1',
        characteristicUuid: SIG.HEART_RATE_MEASUREMENT,
        payloadHex: '10407c03',
        decodedStatus: 'decoded',
        source: 'noble',
        parserVersion: 1,
      }),
    ]);
    const hr = db.select().from(hrRrSamples).all();
    expect(hr).toEqual([expect.objectContaining({ ts: T, bpm: 64, rrCount: 1, source: 'sig_hrm', rawPacketId })]);
    expect(JSON.parse(hr[0]!.rrMs)).toEqual([871.094]);
  });

  it('keeps the raw bytes even when decoding throws', () => {
    const db = memoryDb();
    const pipeline = new IngestPipeline(db, 'noble', null);
    (pipeline as unknown as { decoder: { decode: () => never } }).decoder = {
      decode: () => {
        throw new Error('decoder exploded');
      },
    };
    pipeline.ingest({ characteristicUuid: WHOOP5.DATA_PRIMARY, bytes: Uint8Array.of(1, 2, 3), receivedAt: T });
    expect(db.select().from(rawPackets).all()).toEqual([
      expect.objectContaining({ payloadHex: '010203', decodedStatus: 'error', decodeError: 'decoder exploded' }),
    ]);
  });

  it('marks fragments and decodes the frame when it completes', () => {
    const db = memoryDb();
    const pipeline = new IngestPipeline(db, 'simulator', 'sim');
    const frame = imuFrame(10);
    const first = pipeline.ingest({ characteristicUuid: WHOOP5.DATA_SECONDARY, bytes: frame.slice(0, 60), receivedAt: T });
    const second = pipeline.ingest({ characteristicUuid: WHOOP5.DATA_SECONDARY, bytes: frame.slice(60), receivedAt: T + 5 });
    expect(first.outcome.status).toBe('fragment');
    expect(second.outcome.status).toBe('decoded');
    const motion = db.select().from(motionSamples).all();
    expect(motion).toEqual([expect.objectContaining({ ts: T + 5, sampleCount: 10, rawPacketId: second.rawPacketId })]);
    expect(motion[0]!.activityG).toBeCloseTo(0, 6);
  });

  it('starts fresh frame assembly after a reconnect', () => {
    const db = memoryDb();
    const pipeline = new IngestPipeline(db, 'noble', 'a');
    const frame = imuFrame(4);
    pipeline.ingest({ characteristicUuid: WHOOP5.DATA_SECONDARY, bytes: frame.slice(0, 20), receivedAt: T });
    pipeline.resetConnection('a');
    const result = pipeline.ingest({ characteristicUuid: WHOOP5.DATA_SECONDARY, bytes: frame.slice(20), receivedAt: T + 1 });
    expect(result.outcome.status).toBe('unsynced');
  });

  it('computes activity as mean |‖a‖ - 1 g|', () => {
    expect(activityFromImu([{ ax: 0, ay: 0, az: 1 }, { ax: 0, ay: 0, az: 1.5 }])).toBeCloseTo(0.25, 9);
    expect(activityFromImu([])).toBe(0);
  });
});
