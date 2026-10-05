import { FRAME, Opcode, PacketType, type Provenance } from './constants';
import { bytesToHex, hexToBytes, writeU16LE, writeU32LE } from './bytes';
import { crc16Modbus, crc32 } from './crc';
import type { Frame } from './packetParser';

/**
 * The 16-byte wake frame from the OpenPulse 5.0 specification:
 *   AA 01 | 08 00 | 00 01 | E6 71 | 23 01 91 01 | 36 3E 5C 8D
 *   magic | len 8 | flags | CRC16 | cmd seq=1 GET_HELLO arg=01 | CRC32
 * Its checksums are verified by the test suite.
 */
export const CLIENT_HELLO_HEX = 'AA0108000001E67123019101363E5C8D';
export const CLIENT_HELLO: Uint8Array = hexToBytes(CLIENT_HELLO_HEX);
export const CLIENT_HELLO_SEQUENCE = 0x01;

/**
 * Wrap a payload body in an AA01 frame:
 * magic, uint16 LE length (body + 4), uint16 LE flags, CRC16-Modbus(bytes 0..5),
 * body, CRC32(body) uint32 LE.
 */
export function buildFrame(body: Uint8Array, flags: number = FRAME.DEFAULT_CLIENT_FLAGS): Uint8Array {
  if (body.length < FRAME.MIN_BODY_LENGTH) throw new Error('Frame body must contain a packet type byte');
  const lengthField = body.length + FRAME.CRC32_LENGTH;
  if (lengthField > FRAME.MAX_LENGTH_FIELD) throw new Error(`Frame body too large (${body.length} bytes)`);

  const frame = new Uint8Array(FRAME.HEADER_LENGTH + lengthField);
  frame[0] = FRAME.MAGIC_0;
  frame[1] = FRAME.MAGIC_1;
  writeU16LE(frame, 2, lengthField);
  writeU16LE(frame, 4, flags);
  writeU16LE(frame, 6, crc16Modbus(frame, 0, FRAME.HEADER_CRC_COVERAGE));
  frame.set(body, FRAME.HEADER_LENGTH);
  writeU32LE(frame, FRAME.HEADER_LENGTH + body.length, crc32(body));
  return frame;
}

export function buildCommandFrame(
  opcode: number,
  sequence: number,
  args: ArrayLike<number> = [],
  options: { packetType?: number; flags?: number } = {},
): Uint8Array {
  assertByte(opcode, 'opcode');
  assertByte(sequence, 'sequence');
  const packetType = options.packetType ?? PacketType.COMMAND;
  assertByte(packetType, 'packetType');
  const body = new Uint8Array(3 + args.length);
  body[0] = packetType;
  body[1] = sequence;
  body[2] = opcode;
  for (let i = 0; i < args.length; i++) {
    assertByte(args[i]!, `args[${i}]`);
    body[3 + i] = args[i]!;
  }
  return buildFrame(body, options.flags);
}

/** uint8 command sequence counter. 0 is skipped on wrap-around. */
export class CommandSequencer {
  private value: number;

  constructor(start = 1) {
    this.value = start;
  }

  next(): number {
    const current = this.value;
    this.value = this.value >= 0xff ? 1 : this.value + 1;
    return current;
  }

  peek(): number {
    return this.value;
  }

  reset(start = 1): void {
    assertByte(start, 'start');
    this.value = start === 0 ? 1 : start;
  }
}

// ---------------------------------------------------------------------------
// Command catalogue
// ---------------------------------------------------------------------------

export interface CommandDefinition {
  name: string;
  label: string;
  description: string;
  opcode: number;
  args: number[];
  packetType: number;
  provenance: Provenance | 'user';
  /** True only when the exact bytes are backed by a test vector. */
  verified: boolean;
}

/**
 * Parameter bytes that accompany every community-captured command
 * ([0x23, seq, opcode, 01 01 00 00 00]). The commands are toggles: there is no
 * known separate on/off argument, so none is invented here.
 */
const COMMUNITY_COMMAND_ARGS = [0x01, 0x01, 0x00, 0x00, 0x00];

export const BUILTIN_COMMANDS: Readonly<Record<string, CommandDefinition>> = Object.freeze({
  hello: {
    name: 'hello',
    label: 'Client hello',
    description: 'Wakes the command channel. Sent automatically after subscribing.',
    opcode: Opcode.GET_HELLO,
    args: [0x01],
    packetType: PacketType.COMMAND,
    provenance: 'spec',
    verified: true,
  },
  toggleRealtimeHr: {
    name: 'toggleRealtimeHr',
    label: 'Toggle realtime HR stream',
    description: 'Toggles proprietary realtime HR records (0x28).',
    opcode: Opcode.TOGGLE_REALTIME_HR,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  sendR10R11Realtime: {
    name: 'sendR10R11Realtime',
    label: 'Request R10/R11 realtime records',
    description: 'Requests realtime record types 10 and 11.',
    opcode: Opcode.SEND_R10_R11_REALTIME,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  startRawData: {
    name: 'startRawData',
    label: 'Start raw sensor stream',
    description: 'Starts raw sensor batches (0x2B).',
    opcode: Opcode.START_RAW_DATA,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  stopRawData: {
    name: 'stopRawData',
    label: 'Stop raw sensor stream',
    description: 'Stops raw sensor batches (0x2B).',
    opcode: Opcode.STOP_RAW_DATA,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  toggleImuMode: {
    name: 'toggleImuMode',
    label: 'Toggle realtime IMU stream',
    description: 'Toggles realtime accelerometer/gyroscope batches (0x33).',
    opcode: Opcode.TOGGLE_IMU_MODE,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  toggleImuModeHistorical: {
    name: 'toggleImuModeHistorical',
    label: 'Toggle historical IMU',
    description: 'Toggles historical IMU batches (0x34).',
    opcode: Opcode.TOGGLE_IMU_MODE_HISTORICAL,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
  toggleOpticalMode: {
    name: 'toggleOpticalMode',
    label: 'Toggle optical stream',
    description: 'Toggles optical (PPG) data.',
    opcode: Opcode.TOGGLE_OPTICAL_MODE,
    args: COMMUNITY_COMMAND_ARGS,
    packetType: PacketType.COMMAND,
    provenance: 'community',
    verified: false,
  },
});

/** Encode a catalogue command with a sequence number. `hello` with seq 1 yields CLIENT_HELLO exactly. */
export function encodeCommand(definition: CommandDefinition, sequence: number): Uint8Array {
  return buildCommandFrame(definition.opcode, sequence, definition.args, { packetType: definition.packetType });
}

// ---------------------------------------------------------------------------
// User protocol map: commands discovered from the owner's own captures
// ---------------------------------------------------------------------------

export interface ProtocolMapFile {
  commands?: Array<{
    name: string;
    label?: string;
    description?: string;
    opcode: number | string;
    args?: string;
    packetType?: number | string;
  }>;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/;

function parseByteValue(value: number | string, field: string): number {
  const n = typeof value === 'number' ? value : Number.parseInt(value.replace(/^0x/i, ''), 16);
  if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new Error(`${field} must be a byte (0-255 or hex), got ${value}`);
  return n;
}

/**
 * Validate a user protocol map (JSON) and return its commands. User entries
 * cannot shadow built-in names, so `hello` always sends the verified frame.
 */
export function parseProtocolMap(input: unknown): CommandDefinition[] {
  if (typeof input !== 'object' || input === null) throw new Error('Protocol map must be a JSON object');
  const file = input as ProtocolMapFile;
  if (file.commands === undefined) return [];
  if (!Array.isArray(file.commands)) throw new Error('"commands" must be an array');
  const seen = new Set<string>();
  return file.commands.map((entry, index) => {
    const where = `commands[${index}]`;
    if (typeof entry !== 'object' || entry === null) throw new Error(`${where} must be an object`);
    if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) {
      throw new Error(`${where}.name must match ${NAME_PATTERN}`);
    }
    if (entry.name in BUILTIN_COMMANDS) throw new Error(`${where}.name "${entry.name}" is reserved`);
    if (seen.has(entry.name)) throw new Error(`${where}.name "${entry.name}" is duplicated`);
    seen.add(entry.name);
    const args = entry.args ? Array.from(hexToBytes(entry.args)) : [];
    if (args.length > 64) throw new Error(`${where}.args longer than 64 bytes`);
    return {
      name: entry.name,
      label: entry.label?.slice(0, 80) || entry.name,
      description: entry.description?.slice(0, 240) || 'User-defined command from protocol map',
      opcode: parseByteValue(entry.opcode, `${where}.opcode`),
      args,
      packetType: entry.packetType === undefined ? PacketType.COMMAND : parseByteValue(entry.packetType, `${where}.packetType`),
      provenance: 'user' as const,
      verified: false,
    };
  });
}

export function describeCommand(definition: CommandDefinition, sequence = 1): string {
  return bytesToHex(encodeCommand(definition, sequence)).toUpperCase();
}

// ---------------------------------------------------------------------------
// Acknowledgements
// ---------------------------------------------------------------------------

const COMMAND_FAMILY = new Set<number>([PacketType.COMMAND, PacketType.COMMAND_REQUEST, PacketType.COMMAND_RESPONSE]);

/**
 * Decide whether a frame received on the command-response characteristic
 * acknowledges a command we sent. A response echoing the opcode is the
 * strongest signal; a COMMAND_RESPONSE carrying our sequence number counts too.
 */
export function matchAck(frame: Frame, sent: { opcode: number; sequence: number }): 'opcode' | 'sequence' | null {
  if (!COMMAND_FAMILY.has(frame.packetType)) return null;
  if (frame.opcodeOrSubtype === sent.opcode && frame.sequenceOrRecord === sent.sequence) return 'opcode';
  if (frame.opcodeOrSubtype === sent.opcode && frame.packetType === PacketType.COMMAND_RESPONSE) return 'opcode';
  if (frame.packetType === PacketType.COMMAND_RESPONSE && frame.sequenceOrRecord === sent.sequence) return 'sequence';
  return null;
}

function assertByte(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`${field} must be a byte, got ${value}`);
}
