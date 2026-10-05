import {
  ACCEL_LSB_PER_G,
  FRAME,
  GYRO_LSB_PER_DPS,
  HRM_FLAGS,
  PACKET_TYPE_INFO,
  PacketType,
  RR_TICKS_PER_SECOND,
  type Provenance,
} from './constants';
import { readF32LE, readI16LE, readU16LE, readU32LE, readU8 } from './bytes';
import { crc16Modbus, crc32 } from './crc';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error });

// ---------------------------------------------------------------------------
// 0x2A37 Heart Rate Measurement
// ---------------------------------------------------------------------------

export type SensorContact = 'unsupported' | 'detected' | 'not_detected';

export interface HeartRateMeasurement {
  flags: number;
  bpm: number;
  sensorContact: SensorContact;
  energyExpendedKj: number | null;
  /** R-R intervals in raw 1/1024 s ticks, in transmission (chronological) order. */
  rrTicks: number[];
  /** R-R intervals in milliseconds: rr_ms = ticks / 1024 * 1000. */
  rrIntervalsMs: number[];
}

/** Convert a raw R-R tick count (1/1024 s) to milliseconds. */
export function rrTicksToMs(ticks: number): number {
  return (ticks / RR_TICKS_PER_SECOND) * 1000;
}

export function parseHeartRateMeasurement(data: Uint8Array): ParseResult<HeartRateMeasurement> {
  if (data.length < 2) return fail(`HRM too short (${data.length} bytes)`);
  const flags = data[0]!;
  let offset = 1;

  let bpm: number;
  if (flags & HRM_FLAGS.VALUE_FORMAT_UINT16) {
    if (data.length < offset + 2) return fail('HRM uint16 value truncated');
    bpm = readU16LE(data, offset);
    offset += 2;
  } else {
    bpm = data[offset]!;
    offset += 1;
  }

  let sensorContact: SensorContact = 'unsupported';
  if (flags & HRM_FLAGS.SENSOR_CONTACT_SUPPORTED) {
    sensorContact = flags & HRM_FLAGS.SENSOR_CONTACT_DETECTED ? 'detected' : 'not_detected';
  }

  let energyExpendedKj: number | null = null;
  if (flags & HRM_FLAGS.ENERGY_EXPENDED_PRESENT) {
    if (data.length < offset + 2) return fail('HRM energy expended field truncated');
    energyExpendedKj = readU16LE(data, offset);
    offset += 2;
  }

  const rrTicks: number[] = [];
  if (flags & HRM_FLAGS.RR_INTERVAL_PRESENT) {
    const remaining = data.length - offset;
    if (remaining < 2 || remaining % 2 !== 0) {
      return fail(`HRM R-R field has ${remaining} bytes; expected a non-zero multiple of 2`);
    }
    for (; offset < data.length; offset += 2) rrTicks.push(readU16LE(data, offset));
  } else if (offset !== data.length) {
    return fail(`HRM has ${data.length - offset} trailing bytes with no R-R flag`);
  }

  return ok({
    flags,
    bpm,
    sensorContact,
    energyExpendedKj,
    rrTicks,
    rrIntervalsMs: rrTicks.map(rrTicksToMs),
  });
}

// ---------------------------------------------------------------------------
// 0x2A19 Battery Level and Device Information strings
// ---------------------------------------------------------------------------

export function parseBatteryLevel(data: Uint8Array): ParseResult<number> {
  if (data.length !== 1) return fail(`Battery level must be 1 byte, got ${data.length}`);
  const percent = data[0]!;
  if (percent > 100) return fail(`Battery level ${percent}% out of range`);
  return ok(percent);
}

export function parseUtf8String(data: Uint8Array): string {
  // DIS strings are UTF-8 and sometimes NUL padded.
  return new TextDecoder('utf-8').decode(data).replace(/\0+$/, '').trim();
}

// ---------------------------------------------------------------------------
// AA01 frames
// ---------------------------------------------------------------------------

export interface FrameHeader {
  /** Value of the uint16 LE length field: payload body + 4-byte CRC32 tail. */
  lengthField: number;
  /** Bytes 4..5 as uint16 LE (routing / sequence / header flags). */
  flags: number;
  headerCrc: number;
}

export interface Frame {
  header: FrameHeader;
  /** Frame byte 8: packet type. */
  packetType: number;
  /**
   * Frame byte 9. For commands/responses this is the sequence number; data
   * records use it as the record type.
   */
  sequenceOrRecord: number;
  /** Frame byte 10: command opcode / record subtype (null if the body is shorter). */
  opcodeOrSubtype: number | null;
  /** Payload body: frame bytes 8..(N-4), i.e. everything covered by the CRC32. */
  body: Uint8Array;
  /** Bytes 11..(N-4): command arguments or binary sensor payload. */
  args: Uint8Array;
  payloadCrc: number;
  /** Total frame size in bytes (8 + lengthField). */
  totalLength: number;
}

export type FrameErrorCode =
  | 'too_short'
  | 'bad_magic'
  | 'bad_length'
  | 'header_crc'
  | 'length_mismatch'
  | 'payload_crc';

export type FrameParseResult = { ok: true; value: Frame } | { ok: false; error: string; code: FrameErrorCode };

/** Validate only the 8-byte header (magic, length bounds, CRC16). */
export function parseFrameHeader(
  data: Uint8Array,
  offset = 0,
): { ok: true; value: FrameHeader } | { ok: false; error: string; code: FrameErrorCode } {
  if (data.length - offset < FRAME.HEADER_LENGTH) {
    return { ok: false, code: 'too_short', error: `Need ${FRAME.HEADER_LENGTH} header bytes` };
  }
  if (data[offset] !== FRAME.MAGIC_0 || data[offset + 1] !== FRAME.MAGIC_1) {
    return { ok: false, code: 'bad_magic', error: 'Missing AA 01 sync bytes' };
  }
  const lengthField = readU16LE(data, offset + 2);
  const flags = readU16LE(data, offset + 4);
  const headerCrc = readU16LE(data, offset + 6);
  const computed = crc16Modbus(data, offset, offset + FRAME.HEADER_CRC_COVERAGE);
  if (computed !== headerCrc) {
    return {
      ok: false,
      code: 'header_crc',
      error: `Header CRC16 mismatch: stored 0x${hex16(headerCrc)}, computed 0x${hex16(computed)}`,
    };
  }
  if (lengthField < FRAME.CRC32_LENGTH + FRAME.MIN_BODY_LENGTH || lengthField > FRAME.MAX_LENGTH_FIELD) {
    return { ok: false, code: 'bad_length', error: `Length field ${lengthField} out of bounds` };
  }
  return { ok: true, value: { lengthField, flags, headerCrc } };
}

/** Parse and fully validate one complete frame occupying exactly `data`. */
export function parseFrame(data: Uint8Array): FrameParseResult {
  const header = parseFrameHeader(data);
  if (!header.ok) return header;
  const totalLength = FRAME.HEADER_LENGTH + header.value.lengthField;
  if (data.length !== totalLength) {
    return {
      ok: false,
      code: 'length_mismatch',
      error: `Length field says ${totalLength} bytes, got ${data.length}`,
    };
  }
  const bodyEnd = totalLength - FRAME.CRC32_LENGTH;
  const payloadCrc = readU32LE(data, bodyEnd);
  const computed = crc32(data, FRAME.HEADER_LENGTH, bodyEnd);
  if (computed !== payloadCrc) {
    return {
      ok: false,
      code: 'payload_crc',
      error: `Payload CRC32 mismatch: stored 0x${hex32(payloadCrc)}, computed 0x${hex32(computed)}`,
    };
  }
  const body = data.slice(FRAME.HEADER_LENGTH, bodyEnd);
  return {
    ok: true,
    value: {
      header: header.value,
      packetType: body[0]!,
      sequenceOrRecord: body.length > 1 ? body[1]! : 0,
      opcodeOrSubtype: body.length > 2 ? body[2]! : null,
      body,
      args: body.length > 3 ? body.slice(3) : new Uint8Array(0),
      payloadCrc,
      totalLength,
    },
  };
}

export function packetTypeName(packetType: number): string {
  return PACKET_TYPE_INFO[packetType]?.name ?? `UNKNOWN_0x${packetType.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Record decoders (frame body layouts)
// ---------------------------------------------------------------------------

export interface ImuSample {
  /** Acceleration in g. */
  ax: number;
  ay: number;
  az: number;
  /** Angular rate in degrees per second. */
  gx: number;
  gy: number;
  gz: number;
}

export type DecodedRecord =
  | {
      kind: 'command';
      packetType: number;
      sequence: number;
      opcode: number | null;
      args: Uint8Array;
    }
  | {
      kind: 'heart_rate';
      layout: 'realtime_full' | 'realtime_compact' | 'historical_r18';
      provenance: Provenance;
      /** Strap clock, Unix seconds (may be 0 / implausible if the strap clock is unset). */
      deviceTimestampSec: number;
      subSeconds: number | null;
      bpm: number | null;
      /** R-R interval in ms when the layout maps one with confidence. */
      rrMs: number | null;
      /**
       * A u16 that may be an R-R interval or an optical ADC value. Kept for
       * analysis but never fed into HRV.
       */
      rrCandidateMs: number | null;
      quaternion: { w: number; x: number; y: number; z: number } | null;
    }
  | {
      kind: 'imu';
      layout: 'imu_stream' | 'raw_r21';
      provenance: Provenance;
      deviceTimestampSec: number;
      subSeconds: number;
      samples: ImuSample[];
    }
  | {
      kind: 'unmapped';
      packetType: number;
      recordType: number;
      reason: string;
    };

const IMU_SAMPLE_BYTES = 12;
const IMU_MAX_SAMPLES = 200;

function imuSampleAt(body: Uint8Array, offset: number): ImuSample {
  return {
    ax: readI16LE(body, offset) / ACCEL_LSB_PER_G,
    ay: readI16LE(body, offset + 2) / ACCEL_LSB_PER_G,
    az: readI16LE(body, offset + 4) / ACCEL_LSB_PER_G,
    gx: readI16LE(body, offset + 6) / GYRO_LSB_PER_DPS,
    gy: readI16LE(body, offset + 8) / GYRO_LSB_PER_DPS,
    gz: readI16LE(body, offset + 10) / GYRO_LSB_PER_DPS,
  };
}

function quaternionAt(body: Uint8Array, offset: number) {
  if (body.length < offset + 16) return null;
  const q = {
    w: readF32LE(body, offset),
    x: readF32LE(body, offset + 4),
    y: readF32LE(body, offset + 8),
    z: readF32LE(body, offset + 12),
  };
  return [q.w, q.x, q.y, q.z].every(Number.isFinite) ? q : null;
}

/**
 * Decode a validated frame's body into a typed record. Layouts for data
 * records are community-reported (see constants.ts); anything not matching a
 * known layout is returned as 'unmapped' and stays re-parseable from raw bytes.
 */
export function decodeFrameRecord(frame: Frame): DecodedRecord {
  const { body, packetType } = frame;
  const recordType = frame.sequenceOrRecord;

  switch (packetType) {
    case PacketType.COMMAND:
    case PacketType.COMMAND_REQUEST:
    case PacketType.COMMAND_RESPONSE:
      return {
        kind: 'command',
        packetType,
        sequence: frame.sequenceOrRecord,
        opcode: frame.opcodeOrSubtype,
        args: frame.args,
      };

    case PacketType.REALTIME_DATA: {
      // Full layout (>= 53 body bytes): device time u32 @2, HR @22, quaternion @41.
      if (body.length >= 53) {
        const bpm = readU8(body, 22);
        return {
          kind: 'heart_rate',
          layout: 'realtime_full',
          provenance: 'community',
          deviceTimestampSec: readU32LE(body, 2),
          subSeconds: null,
          bpm: bpm > 0 ? bpm : null,
          rrMs: null,
          rrCandidateMs: null,
          quaternion: quaternionAt(body, 41),
        };
      }
      // Compact layout (~20 body bytes): device time u32 @2, HR @8, valid flag @9, u16 @10.
      if (body.length >= 12) {
        const valid = readU8(body, 9) !== 0;
        const bpm = readU8(body, 8);
        return {
          kind: 'heart_rate',
          layout: 'realtime_compact',
          provenance: 'community',
          deviceTimestampSec: readU32LE(body, 2),
          subSeconds: null,
          bpm: valid && bpm > 0 ? bpm : null,
          rrMs: null,
          rrCandidateMs: valid ? readU16LE(body, 10) : null,
          quaternion: null,
        };
      }
      return { kind: 'unmapped', packetType, recordType, reason: `realtime record too short (${body.length})` };
    }

    case PacketType.HISTORICAL_DATA: {
      // Record type 18: device time u32 @7, sub-seconds u16 @11, HR @14, R-R valid flag @15, R-R ms u16 @16.
      if (recordType === 18 && body.length >= 18) {
        const valid = readU8(body, 15) !== 0;
        const bpm = readU8(body, 14);
        const rr = valid ? readU16LE(body, 16) : 0;
        return {
          kind: 'heart_rate',
          layout: 'historical_r18',
          provenance: 'community',
          deviceTimestampSec: readU32LE(body, 7),
          subSeconds: readU16LE(body, 11),
          bpm: bpm > 0 ? bpm : null,
          rrMs: valid && rr > 0 ? rr : null,
          rrCandidateMs: null,
          quaternion: quaternionAt(body, 33),
        };
      }
      return { kind: 'unmapped', packetType, recordType, reason: `historical record type ${recordType} not mapped` };
    }

    case PacketType.REALTIME_IMU:
    case PacketType.HISTORICAL_IMU: {
      // Sample counts u16 @24 and @26, interleaved 12-byte samples from @28.
      if (body.length < 28) {
        return { kind: 'unmapped', packetType, recordType, reason: `IMU record too short (${body.length})` };
      }
      const count = Math.min(readU16LE(body, 24), readU16LE(body, 26), IMU_MAX_SAMPLES);
      const samples: ImuSample[] = [];
      for (let i = 0, offset = 28; i < count && offset + IMU_SAMPLE_BYTES <= body.length; i++, offset += IMU_SAMPLE_BYTES) {
        samples.push(imuSampleAt(body, offset));
      }
      return {
        kind: 'imu',
        layout: 'imu_stream',
        provenance: 'community',
        deviceTimestampSec: readU32LE(body, 7),
        subSeconds: readU16LE(body, 11),
        samples,
      };
    }

    case PacketType.REALTIME_RAW_DATA: {
      // Record type 21: separate channel arrays. Accel X/Y/Z @20/@220/@420
      // (count u16 @16), gyro X/Y/Z @632/@832/@1032 (count u16 @622).
      if (recordType === 21 && body.length >= 620) {
        const accelCount = Math.min(readU16LE(body, 16), 100);
        const gyroCount = body.length >= 624 ? Math.min(readU16LE(body, 622), 100) : 0;
        const samples: ImuSample[] = [];
        for (let i = 0; i < accelCount; i++) {
          const gyroAt = (base: number) =>
            i < gyroCount && base + i * 2 + 2 <= body.length ? readI16LE(body, base + i * 2) / GYRO_LSB_PER_DPS : 0;
          samples.push({
            ax: readI16LE(body, 20 + i * 2) / ACCEL_LSB_PER_G,
            ay: readI16LE(body, 220 + i * 2) / ACCEL_LSB_PER_G,
            az: readI16LE(body, 420 + i * 2) / ACCEL_LSB_PER_G,
            gx: gyroAt(632),
            gy: gyroAt(832),
            gz: gyroAt(1032),
          });
        }
        return {
          kind: 'imu',
          layout: 'raw_r21',
          provenance: 'community',
          deviceTimestampSec: readU32LE(body, 7),
          subSeconds: readU16LE(body, 11),
          samples,
        };
      }
      return { kind: 'unmapped', packetType, recordType, reason: `raw record type ${recordType} not mapped` };
    }

    default:
      return { kind: 'unmapped', packetType, recordType, reason: `packet type ${packetTypeName(packetType)} not mapped` };
  }
}

function hex16(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function hex32(n: number): string {
  return n.toString(16).toUpperCase().padStart(8, '0');
}
