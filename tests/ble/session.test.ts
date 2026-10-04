import { describe, expect, it } from 'vitest';
import { BleSession, type RawNotification } from '@/lib/ble/session';
import { SIMULATOR_DEVICE_ID, SimulatorTransport, encodeHeartRateMeasurement } from '@/lib/ble/simulatorTransport';
import { BUILTIN_COMMANDS } from '@/lib/protocol/commands';
import { SIG, WHOOP5 } from '@/lib/protocol/constants';
import { PacketDecoder } from '@/lib/protocol/decoder';
import { parseHeartRateMeasurement } from '@/lib/protocol/packetParser';
import { isAuthenticationError, type BleConnection, type CharacteristicInfo } from '@/lib/ble/transport';

const START = Date.UTC(2026, 9, 4, 9, 30, 0);

async function connectedSession() {
  let clock = START;
  const transport = new SimulatorTransport({ timeZone: 'UTC', autoTick: false, now: () => clock, seed: 3 });
  const connection = await transport.connect(SIMULATOR_DEVICE_ID);
  const received: RawNotification[] = [];
  const session = new BleSession(connection, { onNotification: (n) => void received.push(n) }, { ackTimeoutMs: 300, now: () => clock });
  return {
    transport,
    session,
    received,
    advance: (ms: number) => {
      clock += ms;
      transport.step(clock);
    },
  };
}

describe('BleSession handshake', () => {
  it('subscribes, sends CLIENT_HELLO and receives the ack', async () => {
    const { session, received } = await connectedSession();
    const info = await session.start();
    expect(info.serviceVariant).toBe('fd4b');
    expect(info.helloAck).toBe('opcode');
    expect(info.bond).toBe('passed');
    expect(info.deviceInfo.model).toBe('SIM-5.0');
    expect(info.batteryPercent).toBe(87);
    expect(new Set(info.subscribed)).toEqual(
      new Set([SIG.HEART_RATE_MEASUREMENT, SIG.BATTERY_LEVEL, WHOOP5.COMMAND_RESPONSE, WHOOP5.DATA_PRIMARY, WHOOP5.DATA_SECONDARY, WHOOP5.SYSTEM_STATUS]),
    );
    // Raw-first: the ack bytes reached the sink before the handshake resolved.
    expect(received[0]?.characteristicUuid).toBe(WHOOP5.COMMAND_RESPONSE);
    await session.stop();
  });

  it('streams decodable heart-rate notifications in order', async () => {
    const { session, received, advance } = await connectedSession();
    await session.start();
    advance(10_000);
    await session.drain();
    const hr = received.filter((n) => n.characteristicUuid === SIG.HEART_RATE_MEASUREMENT);
    expect(hr.length).toBeGreaterThanOrEqual(9);
    for (const n of hr) expect(parseHeartRateMeasurement(n.bytes).ok).toBe(true);
    await session.stop();
  });

  it('sends catalogue commands with increasing sequence numbers and reassembles fragmented IMU frames', async () => {
    const { session, received, advance } = await connectedSession();
    await session.start();
    const first = await session.sendCommand(BUILTIN_COMMANDS.toggleImuMode!);
    expect(first).toMatchObject({ sequence: 2, ack: 'opcode' });
    advance(3000);
    await session.drain();
    const decoder = new PacketDecoder();
    const motion = received
      .filter((n) => n.characteristicUuid === WHOOP5.DATA_SECONDARY)
      .flatMap((n) => decoder.decode(n.characteristicUuid, n.bytes, n.receivedAt).events)
      .filter((e) => e.type === 'motion');
    expect(motion.length).toBeGreaterThanOrEqual(2);
    expect(motion[0]).toMatchObject({ samples: expect.any(Array) });
    const second = await session.sendCommand(BUILTIN_COMMANDS.toggleRealtimeHr!);
    expect(second.sequence).toBe(3);
    await session.stop();
  });

  it('reports BOND_REQUIRED when the strap rejects unencrypted reads', async () => {
    const characteristics: CharacteristicInfo[] = [
      { uuid: SIG.MODEL_NUMBER, serviceUuid: SIG.DEVICE_INFORMATION_SERVICE, properties: ['read'] },
      { uuid: WHOOP5.COMMAND, serviceUuid: WHOOP5.SERVICE, properties: ['write'] },
      { uuid: WHOOP5.COMMAND_RESPONSE, serviceUuid: WHOOP5.SERVICE, properties: ['notify'] },
    ];
    const connection: BleConnection = {
      deviceId: 'locked',
      deviceName: null,
      characteristics: () => characteristics,
      read: async () => {
        throw new Error('Insufficient Authentication');
      },
      write: async () => undefined,
      subscribe: async () => undefined,
      onDisconnect: () => () => undefined,
      disconnect: async () => undefined,
    };
    await expect(new BleSession(connection, { onNotification: () => undefined }).start()).rejects.toMatchObject({ code: 'BOND_REQUIRED' });
  });

  it('encodes simulator HRM values that round-trip', () => {
    const parsed = parseHeartRateMeasurement(encodeHeartRateMeasurement(64, [871.09375]));
    expect(parsed.ok && parsed.value.rrTicks).toEqual([892]);
  });
});

describe('isAuthenticationError', () => {
  it('recognises bonding failures from noble, CoreBluetooth and Web Bluetooth', () => {
    expect(isAuthenticationError(new Error('Insufficient Authentication'))).toBe(true);
    expect(isAuthenticationError(new Error('Encryption is insufficient.'))).toBe(true);
    expect(isAuthenticationError(new Error('GATT Error: Not paired.'))).toBe(true);
    expect(isAuthenticationError(new Error('Authentication failed'))).toBe(true);
  });

  it('does not treat blocklisted characteristics or ordinary failures as bonding problems', () => {
    const blocked = new Error("readValue() called on blocklisted object marked exclude-reads.");
    blocked.name = 'SecurityError';
    expect(isAuthenticationError(blocked)).toBe(false);
    expect(isAuthenticationError(new Error('read timed out after 5000 ms'))).toBe(false);
    expect(isAuthenticationError(new Error('GATT operation failed for unknown reason.'))).toBe(false);
  });
});
