import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes } from '@/lib/protocol/bytes';
import {
  BUILTIN_COMMANDS,
  CLIENT_HELLO,
  CLIENT_HELLO_HEX,
  CommandSequencer,
  buildCommandFrame,
  buildFrame,
  encodeCommand,
  matchAck,
  parseProtocolMap,
} from '@/lib/protocol/commands';
import { Opcode, PacketType } from '@/lib/protocol/constants';
import { parseFrame } from '@/lib/protocol/packetParser';

describe('CLIENT_HELLO', () => {
  it('is exactly the 16-byte frame from the specification', () => {
    expect(CLIENT_HELLO).toHaveLength(16);
    expect(bytesToHex(CLIENT_HELLO).toUpperCase()).toBe(CLIENT_HELLO_HEX);
  });

  it('is reproduced byte for byte by the frame builder', () => {
    expect(bytesToHex(buildCommandFrame(Opcode.GET_HELLO, 1, [0x01])).toUpperCase()).toBe(CLIENT_HELLO_HEX);
    expect(bytesToHex(encodeCommand(BUILTIN_COMMANDS.hello!, 1)).toUpperCase()).toBe(CLIENT_HELLO_HEX);
  });

  it('is the only command marked verified', () => {
    const verified = Object.values(BUILTIN_COMMANDS).filter((c) => c.verified).map((c) => c.name);
    expect(verified).toEqual(['hello']);
  });
});

describe('buildFrame', () => {
  it('produces frames that parse and round-trip their body', () => {
    const body = Uint8Array.of(PacketType.COMMAND, 7, Opcode.TOGGLE_REALTIME_HR, 1, 1, 0, 0, 0);
    const parsed = parseFrame(buildFrame(body));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.from(parsed.value.body)).toEqual(Array.from(body));
  });

  it('rejects empty and oversized bodies', () => {
    expect(() => buildFrame(new Uint8Array(0))).toThrow();
    expect(() => buildFrame(new Uint8Array(9000))).toThrow();
  });

  it('rejects non-byte arguments', () => {
    expect(() => buildCommandFrame(0x100, 1)).toThrow();
    expect(() => buildCommandFrame(1, 1, [256])).toThrow();
  });
});

describe('CommandSequencer', () => {
  it('counts 1..255 and skips 0 on wrap', () => {
    const seq = new CommandSequencer(254);
    expect([seq.next(), seq.next(), seq.next()]).toEqual([254, 255, 1]);
    seq.reset(0);
    expect(seq.next()).toBe(1);
  });
});

describe('parseProtocolMap', () => {
  it('accepts well-formed user commands', () => {
    const commands = parseProtocolMap({ commands: [{ name: 'buzz', opcode: '0x13', args: '01 02' }] });
    expect(commands).toEqual([
      expect.objectContaining({ name: 'buzz', opcode: 0x13, args: [1, 2], packetType: PacketType.COMMAND, provenance: 'user', verified: false }),
    ]);
  });

  it('refuses to shadow built-ins, duplicates and bad bytes', () => {
    expect(() => parseProtocolMap({ commands: [{ name: 'hello', opcode: 1 }] })).toThrow(/reserved/);
    expect(() => parseProtocolMap({ commands: [{ name: 'a', opcode: 1 }, { name: 'a', opcode: 2 }] })).toThrow(/duplicated/);
    expect(() => parseProtocolMap({ commands: [{ name: 'x', opcode: 300 }] })).toThrow(/byte/);
    expect(() => parseProtocolMap({ commands: [{ name: '1bad', opcode: 1 }] })).toThrow(/name/);
    expect(() => parseProtocolMap({ commands: [{ name: 'x', opcode: 1, args: 'zz' }] })).toThrow(/hex/);
  });
});

describe('matchAck', () => {
  const response = (packetType: number, sequence: number, opcode: number) => {
    const parsed = parseFrame(buildFrame(Uint8Array.of(packetType, sequence, opcode, 0)));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };

  it('matches on echoed opcode or on the response sequence number', () => {
    expect(matchAck(response(PacketType.COMMAND_RESPONSE, 1, 0x91), { opcode: 0x91, sequence: 1 })).toBe('opcode');
    expect(matchAck(response(PacketType.COMMAND_RESPONSE, 5, 0x00), { opcode: 0x91, sequence: 5 })).toBe('sequence');
    expect(matchAck(response(PacketType.COMMAND, 1, 0x91), { opcode: 0x91, sequence: 1 })).toBe('opcode');
  });

  it('ignores data records and unrelated responses', () => {
    expect(matchAck(response(PacketType.HISTORICAL_DATA, 1, 0x91), { opcode: 0x91, sequence: 1 })).toBeNull();
    expect(matchAck(response(PacketType.COMMAND_RESPONSE, 2, 0x03), { opcode: 0x91, sequence: 1 })).toBeNull();
  });

  it('hex helpers round-trip', () => {
    expect(bytesToHex(hexToBytes('aa 01:ff'))).toBe('aa01ff');
  });
});
