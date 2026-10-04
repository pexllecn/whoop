/**
 * BLE identifiers and wire-format constants for the WHOOP 5.0 strap.
 *
 * Provenance matters here because the proprietary protocol is undocumented:
 *   - 'sig'       Bluetooth SIG assigned numbers (authoritative).
 *   - 'spec'      The OpenPulse 5.0 specification supplied by the strap owner,
 *                 including the CLIENT_HELLO test vector (validated in tests).
 *   - 'community' Values published by the MIT-licensed @dofek/whoop-ble project
 *                 (reverse-engineered from the official app and PacketLogger
 *                 captures). Not verified against hardware by OpenPulse; every
 *                 decoded record keeps its raw bytes so it can be re-parsed.
 */

export type Provenance = 'sig' | 'spec' | 'community';

// ---------------------------------------------------------------------------
// Path A: standard Bluetooth SIG services
// ---------------------------------------------------------------------------

export const SIG_BASE_UUID_SUFFIX = '-0000-1000-8000-00805f9b34fb';

/** Expand a 16-bit SIG UUID ("180d") to its 128-bit form. */
export function sigUuid(short16: string): string {
  return `0000${short16.toLowerCase()}${SIG_BASE_UUID_SUFFIX}`;
}

export const SIG = {
  HEART_RATE_SERVICE: sigUuid('180d'),
  HEART_RATE_MEASUREMENT: sigUuid('2a37'),
  BATTERY_SERVICE: sigUuid('180f'),
  BATTERY_LEVEL: sigUuid('2a19'),
  DEVICE_INFORMATION_SERVICE: sigUuid('180a'),
  MODEL_NUMBER: sigUuid('2a24'),
  SERIAL_NUMBER: sigUuid('2a25'),
  FIRMWARE_REVISION: sigUuid('2a26'),
  HARDWARE_REVISION: sigUuid('2a27'),
} as const;

/** Heart Rate Measurement flag bits (Bluetooth HRS 1.0, section 3.1.1.1). */
export const HRM_FLAGS = {
  /** 0 = uint8 BPM, 1 = uint16 LE BPM */
  VALUE_FORMAT_UINT16: 0x01,
  /** Sensor contact status bit (valid only when SUPPORTED is set). */
  SENSOR_CONTACT_DETECTED: 0x02,
  SENSOR_CONTACT_SUPPORTED: 0x04,
  /** uint16 LE energy expended (kJ) follows the BPM field. */
  ENERGY_EXPENDED_PRESENT: 0x08,
  /** One or more uint16 LE R-R intervals (1/1024 s) follow. */
  RR_INTERVAL_PRESENT: 0x10,
} as const;

/** R-R intervals are transmitted in units of 1/1024 second. */
export const RR_TICKS_PER_SECOND = 1024;

// ---------------------------------------------------------------------------
// Path B: proprietary service
// ---------------------------------------------------------------------------

/**
 * Proprietary service UUID variants. All of them share one convention: each
 * characteristic UUID is the service UUID with the 4 hex digits before the
 * first dash replaced by the characteristic suffix (0002, 0003, ...).
 */
export const PROPRIETARY_SERVICES = [
  {
    id: 'fd4b',
    uuid: 'fd4b0001-cce1-4033-93ce-002d5875f58a',
    label: 'WHOOP 5.0 primary service',
    provenance: 'spec' as Provenance,
  },
  {
    id: '1150',
    uuid: '11500001-6215-11ee-8c99-0242ac120002',
    label: 'Alternate 5.x service (same AA01 framing)',
    provenance: 'community' as Provenance,
  },
] as const;

export type ProprietaryServiceId = (typeof PROPRIETARY_SERVICES)[number]['id'];

export const CHARACTERISTIC_SUFFIX = {
  /** Write / Write Without Response: client -> strap commands. */
  COMMAND: '0002',
  /** Notify: command responses and ack events. */
  COMMAND_RESPONSE: '0003',
  /** Notify: primary telemetry and historical data stream. */
  DATA_PRIMARY: '0004',
  /** Notify: secondary / high-frequency sensor stream. */
  DATA_SECONDARY: '0005',
  /** Notify: metadata and system status stream. */
  SYSTEM_STATUS: '0007',
} as const;

export type CharacteristicRole = keyof typeof CHARACTERISTIC_SUFFIX;

/** Derive a characteristic UUID from a proprietary service UUID. */
export function proprietaryCharacteristicUuid(serviceUuid: string, suffix: string): string {
  const uuid = serviceUuid.toLowerCase();
  const dash = uuid.indexOf('-');
  if (dash < 4 || !/^[0-9a-f]{4}$/.test(suffix)) {
    throw new Error(`Cannot derive characteristic ${suffix} from ${serviceUuid}`);
  }
  return `${uuid.slice(0, dash - 4)}${suffix}${uuid.slice(dash)}`;
}

/** The spec's primary service with its characteristics spelled out. */
export const WHOOP5 = {
  SERVICE: PROPRIETARY_SERVICES[0].uuid,
  COMMAND: 'fd4b0002-cce1-4033-93ce-002d5875f58a',
  COMMAND_RESPONSE: 'fd4b0003-cce1-4033-93ce-002d5875f58a',
  DATA_PRIMARY: 'fd4b0004-cce1-4033-93ce-002d5875f58a',
  DATA_SECONDARY: 'fd4b0005-cce1-4033-93ce-002d5875f58a',
  SYSTEM_STATUS: 'fd4b0007-cce1-4033-93ce-002d5875f58a',
} as const;

/** Every notify characteristic the session subscribes to on a proprietary service. */
export const NOTIFY_ROLES: readonly CharacteristicRole[] = [
  'COMMAND_RESPONSE',
  'DATA_PRIMARY',
  'DATA_SECONDARY',
  'SYSTEM_STATUS',
];

export function characteristicsForService(serviceUuid: string): Record<CharacteristicRole, string> {
  return {
    COMMAND: proprietaryCharacteristicUuid(serviceUuid, CHARACTERISTIC_SUFFIX.COMMAND),
    COMMAND_RESPONSE: proprietaryCharacteristicUuid(serviceUuid, CHARACTERISTIC_SUFFIX.COMMAND_RESPONSE),
    DATA_PRIMARY: proprietaryCharacteristicUuid(serviceUuid, CHARACTERISTIC_SUFFIX.DATA_PRIMARY),
    DATA_SECONDARY: proprietaryCharacteristicUuid(serviceUuid, CHARACTERISTIC_SUFFIX.DATA_SECONDARY),
    SYSTEM_STATUS: proprietaryCharacteristicUuid(serviceUuid, CHARACTERISTIC_SUFFIX.SYSTEM_STATUS),
  };
}

/** Which proprietary service (if any) a characteristic UUID belongs to. */
export function proprietaryRoleOf(
  characteristicUuid: string,
): { serviceId: ProprietaryServiceId; role: CharacteristicRole } | null {
  const uuid = characteristicUuid.toLowerCase();
  for (const service of PROPRIETARY_SERVICES) {
    const chars = characteristicsForService(service.uuid);
    for (const role of Object.keys(chars) as CharacteristicRole[]) {
      if (chars[role] === uuid) return { serviceId: service.id, role };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// AA01 frame format
// ---------------------------------------------------------------------------

export const FRAME = {
  MAGIC_0: 0xaa,
  MAGIC_1: 0x01,
  /** Magic(2) + length(2) + flags(2) + header CRC16(2) */
  HEADER_LENGTH: 8,
  /** Bytes covered by the header CRC16. */
  HEADER_CRC_COVERAGE: 6,
  CRC32_LENGTH: 4,
  /** Packet type + sequence/record byte + opcode/subtype byte. */
  MIN_BODY_LENGTH: 1,
  /**
   * Upper bound on the length field. The largest frames reported so far are
   * ~1.2 KB raw-sensor batches; anything far beyond that is a desynchronised
   * stream, not a frame.
   */
  MAX_LENGTH_FIELD: 8192,
  /** Header flags used by every client command observed (bytes 00 01). */
  DEFAULT_CLIENT_FLAGS: 0x0100,
} as const;

// ---------------------------------------------------------------------------
// Packet types (first byte of the frame payload, i.e. frame byte 8)
// ---------------------------------------------------------------------------

export const PacketType = {
  COMMAND: 0x23,
  REALTIME_DATA: 0x28,
  REALTIME_RAW_DATA: 0x2b,
  HISTORICAL_DATA: 0x2f,
  LIVE_SENSOR_RECORD: 0x30,
  REALTIME_IMU: 0x33,
  HISTORICAL_IMU: 0x34,
  COMMAND_REQUEST: 0x72,
  COMMAND_RESPONSE: 0x73,
} as const;

export type PacketTypeName = keyof typeof PacketType;

export const PACKET_TYPE_INFO: Record<number, { name: PacketTypeName; description: string; provenance: Provenance[] }> = {
  [PacketType.COMMAND]: { name: 'COMMAND', description: 'Command', provenance: ['spec', 'community'] },
  [PacketType.REALTIME_DATA]: { name: 'REALTIME_DATA', description: 'Realtime HR record', provenance: ['community'] },
  [PacketType.REALTIME_RAW_DATA]: { name: 'REALTIME_RAW_DATA', description: 'Realtime raw sensor batch', provenance: ['community'] },
  [PacketType.HISTORICAL_DATA]: { name: 'HISTORICAL_DATA', description: 'Historical biometric record', provenance: ['spec', 'community'] },
  [PacketType.LIVE_SENSOR_RECORD]: { name: 'LIVE_SENSOR_RECORD', description: 'Live biometric sensor record', provenance: ['spec'] },
  [PacketType.REALTIME_IMU]: { name: 'REALTIME_IMU', description: 'Realtime IMU batch', provenance: ['community'] },
  [PacketType.HISTORICAL_IMU]: { name: 'HISTORICAL_IMU', description: 'Historical IMU batch', provenance: ['community'] },
  [PacketType.COMMAND_REQUEST]: { name: 'COMMAND_REQUEST', description: 'Command request', provenance: ['spec'] },
  [PacketType.COMMAND_RESPONSE]: { name: 'COMMAND_RESPONSE', description: 'Command response', provenance: ['spec'] },
};

// ---------------------------------------------------------------------------
// Command opcodes (frame byte 10 of a 0x23 command)
// ---------------------------------------------------------------------------

export const Opcode = {
  GET_HELLO: 0x91,
  TOGGLE_REALTIME_HR: 0x03,
  SEND_R10_R11_REALTIME: 0x3f,
  START_RAW_DATA: 0x51,
  STOP_RAW_DATA: 0x52,
  TOGGLE_IMU_MODE_HISTORICAL: 0x69,
  TOGGLE_IMU_MODE: 0x6a,
  TOGGLE_OPTICAL_MODE: 0x6c,
} as const;

export type OpcodeName = keyof typeof Opcode;

// ---------------------------------------------------------------------------
// Sensor scale factors for decoded IMU samples (community-reported)
// ---------------------------------------------------------------------------

/** Accelerometer: +/-8 g range, 4096 LSB per g (gravity vector reads ~4096). */
export const ACCEL_LSB_PER_G = 4096;
/** Gyroscope: +/-2000 dps, 16.4 LSB per degree/second (assumed common MEMS range). */
export const GYRO_LSB_PER_DPS = 16.4;

/**
 * Bumped whenever a decoder layout changes, so `npm run replay` knows which
 * stored raw packets were decoded by an older parser.
 */
export const PARSER_VERSION = 1;
