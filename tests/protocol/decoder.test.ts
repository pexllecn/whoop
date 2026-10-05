import { describe, expect, it } from 'vitest';
import { hexToBytes, writeU16LE, writeU32LE } from '@/lib/protocol/bytes';
import { CLIENT_HELLO, buildFrame } from '@/lib/protocol/commands';
import { PacketType, SIG, WHOOP5 } from '@/lib/protocol/constants';
import { PacketDecoder, resolveDeviceTime } from '@/lib/protocol/decoder';

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

describe('PacketDecoder', () => {
  it('decodes 0x2A37 into a heart_rate event', () => {
    const outcome = new PacketDecoder().decode('2a37', hexToBytes('10407c03'), NOW);
    expect(outcome.status).toBe('decoded');
    expect(outcome.events).toEqual([
      expect.objectContaining({ type: 'heart_rate', at: NOW, bpm: 64, source: 'sig_hrm', rrMs: [871.09375] }),
    ]);
  });

  it('flags malformed standard values', () => {
    expect(new PacketDecoder().decode(SIG.HEART_RATE_MEASUREMENT, hexToBytes('10'), NOW).status).toBe('malformed');
    expect(new PacketDecoder().decode(SIG.BATTERY_LEVEL, Uint8Array.of(200), NOW).status).toBe('malformed');
  });

  it('decodes battery notifications', () => {
    expect(new PacketDecoder().decode(SIG.BATTERY_LEVEL, Uint8Array.of(55), NOW).events).toEqual([{ type: 'battery', at: NOW, percent: 55 }]);
  });

  it('reports fragments until the frame completes', () => {
    const decoder = new PacketDecoder();
    expect(decoder.decode(WHOOP5.COMMAND_RESPONSE, CLIENT_HELLO.slice(0, 6), NOW).status).toBe('fragment');
    const done = decoder.decode(WHOOP5.COMMAND_RESPONSE, CLIENT_HELLO.slice(6), NOW);
    expect(done.status).toBe('decoded');
    expect(done.packetType).toBe(PacketType.COMMAND);
    expect(done.events[0]).toMatchObject({ type: 'command_frame', sequence: 1, opcode: 0x91, argsHex: '01' });
  });

  it('keeps per-characteristic assemblers independent', () => {
    const decoder = new PacketDecoder();
    decoder.decode(WHOOP5.DATA_PRIMARY, CLIENT_HELLO.slice(0, 8), NOW);
    expect(decoder.decode(WHOOP5.DATA_SECONDARY, CLIENT_HELLO, NOW).status).toBe('decoded');
    expect(decoder.decode(WHOOP5.DATA_PRIMARY, CLIENT_HELLO.slice(8), NOW).status).toBe('decoded');
  });

  it('labels unknown layouts unmapped and corrupted frames crc_error', () => {
    const decoder = new PacketDecoder();
    expect(decoder.decode(WHOOP5.SYSTEM_STATUS, buildFrame(Uint8Array.of(0x31, 0, 1, 2)), NOW).status).toBe('unmapped');
    const bad = CLIENT_HELLO.slice();
    bad[12] = bad[12]! ^ 0xff;
    expect(decoder.decode(WHOOP5.SYSTEM_STATUS, bad, NOW).status).toBe('crc_error');
  });

  it('ignores characteristics it does not handle', () => {
    expect(new PacketDecoder().decode(SIG.MODEL_NUMBER, Uint8Array.of(1), NOW).status).toBe('ignored');
  });

  it('timestamps historical records with the strap clock', () => {
    const body = new Uint8Array(46);
    body[0] = PacketType.HISTORICAL_DATA;
    body[1] = 18;
    const deviceSec = Math.floor(NOW / 1000) - 3600;
    writeU32LE(body, 7, deviceSec);
    body[14] = 50;
    body[15] = 1;
    writeU16LE(body, 16, 1200);
    const outcome = new PacketDecoder().decode(WHOOP5.DATA_PRIMARY, buildFrame(body, 0x0001), NOW);
    expect(outcome.events[0]).toMatchObject({ type: 'heart_rate', at: deviceSec * 1000, source: 'proprietary_historical', rrMs: [1200] });
  });

  it('falls back to host time when the strap clock is implausible', () => {
    expect(resolveDeviceTime(5, NOW)).toBe(NOW);
    expect(resolveDeviceTime(NOW / 1000 + 10 * 86400, NOW)).toBe(NOW);
  });
});
