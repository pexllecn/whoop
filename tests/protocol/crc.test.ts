import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@/lib/protocol/bytes';
import { crc16Modbus, crc32 } from '@/lib/protocol/crc';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('crc16Modbus', () => {
  it('matches the CRC-16/MODBUS catalogue check value', () => {
    expect(crc16Modbus(ascii('123456789'))).toBe(0x4b37);
  });

  it('reproduces the CLIENT_HELLO header checksum (bytes 0..5 -> 0x71E6)', () => {
    const frame = hexToBytes('AA0108000001E67123019101363E5C8D');
    expect(crc16Modbus(frame, 0, 6)).toBe(0x71e6);
  });

  it('returns the init value for empty input', () => {
    expect(crc16Modbus(new Uint8Array(0))).toBe(0xffff);
  });

  it('rejects invalid ranges', () => {
    expect(() => crc16Modbus(new Uint8Array(4), 2, 9)).toThrow(RangeError);
  });
});

describe('crc32', () => {
  it('matches the CRC-32 (zlib) catalogue check value', () => {
    expect(crc32(ascii('123456789'))).toBe(0xcbf43926);
  });

  it('reproduces the CLIENT_HELLO payload checksum (23 01 91 01 -> 0x8D5C3E36)', () => {
    expect(crc32(hexToBytes('23019101'))).toBe(0x8d5c3e36);
  });

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('honours sub-ranges', () => {
    const frame = hexToBytes('AA0108000001E67123019101363E5C8D');
    expect(crc32(frame, 8, 12)).toBe(0x8d5c3e36);
  });
});
