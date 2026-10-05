import { PARSER_VERSION, PacketType, SIG, proprietaryRoleOf } from './constants';
import { bytesToHex } from './bytes';
import { FrameAssembler } from './frameAssembler';
import {
  decodeFrameRecord,
  packetTypeName,
  parseBatteryLevel,
  parseHeartRateMeasurement,
  type ImuSample,
  type SensorContact,
} from './packetParser';
import { normalizeUuid } from './uuid';

export type DecodeStatus =
  /** Every frame/packet in the notification was decoded into typed events. */
  | 'decoded'
  /** Some frames decoded, others were unmapped or invalid. */
  | 'partial'
  /** Bytes buffered; the frame completes in a later notification. */
  | 'fragment'
  /** Bytes discarded while searching for an AA 01 frame start (e.g. tail of a frame from a previous connection). */
  | 'unsynced'
  /** Valid frame(s) whose layout is not mapped yet. Raw bytes kept for replay. */
  | 'unmapped'
  /** Frame(s) failed CRC or length validation. */
  | 'crc_error'
  /** A standard characteristic value that does not follow its specification. */
  | 'malformed'
  /** Characteristic not handled by the decoder. */
  | 'ignored';

export type HeartRateSource = 'sig_hrm' | 'proprietary_realtime' | 'proprietary_historical';

export type LiveEvent =
  | {
      type: 'heart_rate';
      /** Epoch ms of the sample (strap clock for historical records, host clock otherwise). */
      at: number;
      bpm: number | null;
      /** R-R intervals (ms) in chronological order; the last one ends at `at`. */
      rrMs: number[];
      source: HeartRateSource;
      sensorContact: SensorContact | null;
      /** Unverified u16 from compact realtime records (never used for HRV). */
      rrCandidateMs: number | null;
    }
  | { type: 'battery'; at: number; percent: number }
  | { type: 'motion'; at: number; samples: ImuSample[]; historical: boolean }
  | {
      type: 'command_frame';
      at: number;
      characteristicUuid: string;
      packetType: number;
      sequence: number;
      opcode: number | null;
      argsHex: string;
    }
  | {
      type: 'unmapped_frame';
      at: number;
      characteristicUuid: string;
      packetType: number;
      packetTypeName: string;
      recordType: number;
      reason: string;
      length: number;
    };

export interface DecodeOutcome {
  status: DecodeStatus;
  /** Packet type of the first complete frame, if any. */
  packetType: number | null;
  frames: number;
  invalidFrames: number;
  events: LiveEvent[];
  error: string | null;
  parserVersion: number;
}

/** Device timestamps outside [now - 400 days, now + 1 day] are treated as an unset strap clock. */
const MAX_DEVICE_CLOCK_AGE_MS = 400 * 24 * 3600 * 1000;
const MAX_DEVICE_CLOCK_LEAD_MS = 24 * 3600 * 1000;

export function resolveDeviceTime(deviceTimestampSec: number, receivedAt: number): number {
  const deviceMs = deviceTimestampSec * 1000;
  if (deviceMs >= receivedAt - MAX_DEVICE_CLOCK_AGE_MS && deviceMs <= receivedAt + MAX_DEVICE_CLOCK_LEAD_MS) {
    return deviceMs;
  }
  return receivedAt;
}

/**
 * Stateful decoder for raw notifications. One instance per connection (or per
 * replay run): it keeps a frame assembler for each proprietary characteristic
 * so fragments are stitched together in arrival order.
 */
export class PacketDecoder {
  private readonly assemblers = new Map<string, FrameAssembler>();

  reset(): void {
    this.assemblers.clear();
  }

  decode(characteristicUuid: string, bytes: Uint8Array, receivedAt: number): DecodeOutcome {
    const uuid = normalizeUuid(characteristicUuid);

    if (uuid === SIG.HEART_RATE_MEASUREMENT) {
      const parsed = parseHeartRateMeasurement(bytes);
      if (!parsed.ok) return outcome('malformed', { error: parsed.error });
      return outcome('decoded', {
        events: [
          {
            type: 'heart_rate',
            at: receivedAt,
            bpm: parsed.value.bpm > 0 ? parsed.value.bpm : null,
            rrMs: parsed.value.rrIntervalsMs,
            source: 'sig_hrm',
            sensorContact: parsed.value.sensorContact,
            rrCandidateMs: null,
          },
        ],
      });
    }

    if (uuid === SIG.BATTERY_LEVEL) {
      const parsed = parseBatteryLevel(bytes);
      if (!parsed.ok) return outcome('malformed', { error: parsed.error });
      return outcome('decoded', { events: [{ type: 'battery', at: receivedAt, percent: parsed.value }] });
    }

    if (!proprietaryRoleOf(uuid)) return outcome('ignored', {});

    let assembler = this.assemblers.get(uuid);
    if (!assembler) {
      assembler = new FrameAssembler();
      this.assemblers.set(uuid, assembler);
    }
    const { events: assembled, discardedBytes } = assembler.push(bytes);
    if (assembled.length === 0) {
      return assembler.pendingBytes === 0 && discardedBytes > 0
        ? outcome('unsynced', { error: `${discardedBytes} bytes outside any frame` })
        : outcome('fragment', {});
    }

    const events: LiveEvent[] = [];
    let frames = 0;
    let invalidFrames = 0;
    let mapped = 0;
    let firstPacketType: number | null = null;
    const errors: string[] = [];

    for (const item of assembled) {
      if (item.type === 'invalid_frame') {
        invalidFrames++;
        errors.push(item.error);
        continue;
      }
      frames++;
      const frame = item.frame;
      firstPacketType ??= frame.packetType;
      const record = decodeFrameRecord(frame);
      switch (record.kind) {
        case 'command':
          mapped++;
          events.push({
            type: 'command_frame',
            at: receivedAt,
            characteristicUuid: uuid,
            packetType: record.packetType,
            sequence: record.sequence,
            opcode: record.opcode,
            argsHex: bytesToHex(record.args),
          });
          break;
        case 'heart_rate': {
          mapped++;
          const historical = record.layout === 'historical_r18';
          events.push({
            type: 'heart_rate',
            at: historical ? resolveDeviceTime(record.deviceTimestampSec, receivedAt) : receivedAt,
            bpm: record.bpm,
            rrMs: record.rrMs !== null ? [record.rrMs] : [],
            source: historical ? 'proprietary_historical' : 'proprietary_realtime',
            sensorContact: null,
            rrCandidateMs: record.rrCandidateMs,
          });
          break;
        }
        case 'imu': {
          mapped++;
          const historical = frame.packetType === PacketType.HISTORICAL_IMU;
          events.push({
            type: 'motion',
            at: historical ? resolveDeviceTime(record.deviceTimestampSec, receivedAt) : receivedAt,
            samples: record.samples,
            historical,
          });
          break;
        }
        case 'unmapped':
          events.push({
            type: 'unmapped_frame',
            at: receivedAt,
            characteristicUuid: uuid,
            packetType: record.packetType,
            packetTypeName: packetTypeName(record.packetType),
            recordType: record.recordType,
            reason: record.reason,
            length: frame.totalLength,
          });
          break;
      }
    }

    let status: DecodeStatus;
    if (frames === 0) status = 'crc_error';
    else if (mapped === frames && invalidFrames === 0) status = 'decoded';
    else if (mapped === 0 && invalidFrames === 0) status = 'unmapped';
    else status = 'partial';

    return outcome(status, {
      packetType: firstPacketType,
      frames,
      invalidFrames,
      events,
      error: errors.length ? errors.join('; ') : null,
    });
  }
}

function outcome(status: DecodeStatus, partial: Partial<DecodeOutcome>): DecodeOutcome {
  return {
    status,
    packetType: partial.packetType ?? null,
    frames: partial.frames ?? 0,
    invalidFrames: partial.invalidFrames ?? 0,
    events: partial.events ?? [],
    error: partial.error ?? null,
    parserVersion: PARSER_VERSION,
  };
}
