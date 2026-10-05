import { describe, expect, it } from 'vitest';
import { hexToBytes, writeI16LE, writeU16LE, writeU32LE } from '@/lib/protocol/bytes';
import { buildFrame } from '@/lib/protocol/commands';
import { PacketType } from '@/lib/protocol/constants';
import {
  decodeFrameRecord,
  parseBatteryLevel,
  parseFrame,
  parseHeartRateMeasurement,
  rrTicksToMs,
} from '@/lib/protocol/packetParser';

describe('parseHeartRateMeasurement', () => {
  it('decodes the spec vector 10407c03: 64 BPM, one R-R of 892 ticks = 871.09 ms', () => {
    const result = parseHeartRateMeasurement(hexToBytes('10407c03'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.flags).toBe(0x10);
    expect(result.value.bpm).toBe(64);
    expect(result.value.rrTicks).toEqual([892]);
    expect(result.value.rrIntervalsMs[0]).toBeCloseTo(871.09375, 5);
    expect(result.value.sensorContact).toBe('unsupported');
    expect(result.value.energyExpendedKj).toBeNull();
  });

  it('converts ticks with rr_ms = raw / 1024 * 1000', () => {
    expect(rrTicksToMs(1024)).toBe(1000);
    expect(rrTicksToMs(512)).toBe(500);
  });

  it('decodes uint16 BPM, sensor contact, energy expended and several R-R intervals', () => {
    // flags 0x1F: uint16 HR, contact supported+detected, energy present, RR present
    const result = parseHeartRateMeasurement(hexToBytes('1F' + 'B400' + '3412' + '0004' + '0002'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bpm).toBe(180);
    expect(result.value.sensorContact).toBe('detected');
    expect(result.value.energyExpendedKj).toBe(0x1234);
    expect(result.value.rrIntervalsMs).toEqual([1000, 500]);
  });

  it('reports contact not detected when supported but bit 1 is clear', () => {
    const result = parseHeartRateMeasurement(hexToBytes('0448'));
    expect(result.ok && result.value.sensorContact).toBe('not_detected');
  });

  it('rejects truncated and malformed values', () => {
    expect(parseHeartRateMeasurement(hexToBytes('10')).ok).toBe(false);
    expect(parseHeartRateMeasurement(hexToBytes('01b4')).ok).toBe(false); // uint16 flag, 1 byte
    expect(parseHeartRateMeasurement(hexToBytes('10407c')).ok).toBe(false); // odd R-R bytes
    expect(parseHeartRateMeasurement(hexToBytes('1040')).ok).toBe(false); // RR flag, no RR
    expect(parseHeartRateMeasurement(hexToBytes('00407c03')).ok).toBe(false); // trailing bytes
  });
});

describe('parseBatteryLevel', () => {
  it('accepts 0-100 and rejects the rest', () => {
    expect(parseBatteryLevel(Uint8Array.of(87))).toEqual({ ok: true, value: 87 });
    expect(parseBatteryLevel(Uint8Array.of(101)).ok).toBe(false);
    expect(parseBatteryLevel(Uint8Array.of(1, 2)).ok).toBe(false);
  });
});

describe('parseFrame', () => {
  it('validates the spec CLIENT_HELLO frame field by field', () => {
    const result = parseFrame(hexToBytes('AA0108000001E67123019101363E5C8D'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const f = result.value;
    expect(f.header.lengthField).toBe(8);
    expect(f.header.flags).toBe(0x0100);
    expect(f.header.headerCrc).toBe(0x71e6);
    expect(f.totalLength).toBe(16);
    expect(f.packetType).toBe(PacketType.COMMAND);
    expect(f.sequenceOrRecord).toBe(0x01);
    expect(f.opcodeOrSubtype).toBe(0x91);
    expect(Array.from(f.args)).toEqual([0x01]);
    expect(Array.from(f.body)).toEqual([0x23, 0x01, 0x91, 0x01]);
    expect(f.payloadCrc).toBe(0x8d5c3e36);
  });

  it('detects every class of corruption', () => {
    const good = hexToBytes('AA0108000001E67123019101363E5C8D');
    const flip = (index: number) => {
      const copy = good.slice();
      copy[index] = copy[index]! ^ 0xff;
      return copy;
    };
    expect(parseFrame(good.slice(0, 7))).toMatchObject({ ok: false, code: 'too_short' });
    expect(parseFrame(flip(0))).toMatchObject({ ok: false, code: 'bad_magic' });
    expect(parseFrame(flip(4))).toMatchObject({ ok: false, code: 'header_crc' });
    expect(parseFrame(flip(6))).toMatchObject({ ok: false, code: 'header_crc' });
    expect(parseFrame(flip(10))).toMatchObject({ ok: false, code: 'payload_crc' });
    expect(parseFrame(flip(15))).toMatchObject({ ok: false, code: 'payload_crc' });
    expect(parseFrame(good.slice(0, 15))).toMatchObject({ ok: false, code: 'length_mismatch' });
  });
});

describe('decodeFrameRecord', () => {
  const frameOf = (body: Uint8Array) => {
    const parsed = parseFrame(buildFrame(body, 0x0001));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it('decodes command frames', () => {
    const parsed = parseFrame(hexToBytes('AA0108000001E67123019101363E5C8D'));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(decodeFrameRecord(parsed.value)).toMatchObject({ kind: 'command', sequence: 1, opcode: 0x91 });
  });

  it('decodes historical record type 18 (HR @14, R-R @16)', () => {
    const body = new Uint8Array(46);
    body[0] = PacketType.HISTORICAL_DATA;
    body[1] = 18;
    writeU32LE(body, 7, 1_790_000_000);
    writeU16LE(body, 11, 1234);
    body[14] = 58;
    body[15] = 1;
    writeU16LE(body, 16, 1035);
    expect(decodeFrameRecord(frameOf(body))).toMatchObject({
      kind: 'heart_rate',
      layout: 'historical_r18',
      deviceTimestampSec: 1_790_000_000,
      subSeconds: 1234,
      bpm: 58,
      rrMs: 1035,
    });
  });

  it('keeps the compact realtime u16 as a candidate, never as an R-R interval', () => {
    const body = new Uint8Array(20);
    body[0] = PacketType.REALTIME_DATA;
    body[1] = 2;
    body[8] = 61;
    body[9] = 1;
    writeU16LE(body, 10, 980);
    expect(decodeFrameRecord(frameOf(body))).toMatchObject({ layout: 'realtime_compact', bpm: 61, rrMs: null, rrCandidateMs: 980 });
  });

  it('decodes IMU batches in g and dps', () => {
    const body = new Uint8Array(28 + 2 * 12);
    body[0] = PacketType.REALTIME_IMU;
    writeU16LE(body, 24, 2);
    writeU16LE(body, 26, 2);
    writeI16LE(body, 28, 4096);
    writeI16LE(body, 34, 164);
    writeI16LE(body, 40 + 4, -2048);
    const record = decodeFrameRecord(frameOf(body));
    expect(record.kind).toBe('imu');
    if (record.kind !== 'imu') return;
    expect(record.samples).toHaveLength(2);
    expect(record.samples[0]!.ax).toBe(1);
    expect(record.samples[0]!.gx).toBeCloseTo(10, 6);
    expect(record.samples[1]!.az).toBe(-0.5);
  });

  it('marks unknown layouts as unmapped instead of guessing', () => {
    expect(decodeFrameRecord(frameOf(Uint8Array.of(0x2f, 7, 0, 0)))).toMatchObject({ kind: 'unmapped', recordType: 7 });
    expect(decodeFrameRecord(frameOf(Uint8Array.of(0x55, 0, 0)))).toMatchObject({ kind: 'unmapped', packetType: 0x55 });
  });
});
