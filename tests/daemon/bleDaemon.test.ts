import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { BleDaemon } from '@/lib/daemon/bleDaemon';
import { SimulatorTransport } from '@/lib/ble/simulatorTransport';
import { parseDaemonArgs } from '@/lib/daemon/main';
import type { ServerMessage } from '@/lib/live/messages';
import { parseClientMessage } from '@/lib/live/messages';
import { hrRrSamples, rawPackets } from '@/lib/storage/schema';
import { DEFAULT_SETTINGS } from '@/lib/storage/settings';
import { memoryDb } from '../helpers/db';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BleDaemon with the simulator', () => {
  it('connects, streams raw-first, answers commands and stops cleanly', async () => {
    const db = memoryDb();
    const messages: ServerMessage[] = [];
    const daemon = new BleDaemon({ db, transport: new SimulatorTransport({ timeZone: 'UTC' }), settings: DEFAULT_SETTINGS, autoProcess: false, stressIntervalMs: 500 });
    daemon.setBroadcaster({ broadcast: (m) => messages.push(m) });
    daemon.start();
    for (let i = 0; i < 40 && daemon.status().state !== 'streaming'; i++) await sleep(50);
    expect(daemon.status()).toMatchObject({ state: 'streaming', helloAck: 'opcode', bond: 'passed', transport: 'simulator' });

    await sleep(2300);
    const result = await daemon.sendCommand('toggleRealtimeHr');
    expect(result).toMatchObject({ type: 'command_result', ok: true, ack: 'opcode' });
    expect(await daemon.sendCommand('nope')).toMatchObject({ ok: false });
    await daemon.stop();

    const raw = db.select({ n: sql<number>`count(*)` }).from(rawPackets).get()!.n;
    const hr = db.select({ n: sql<number>`count(*)` }).from(hrRrSamples).get()!.n;
    expect(raw).toBeGreaterThanOrEqual(3);
    expect(hr).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.type === 'hr')).toBe(true);
    expect(messages.some((m) => m.type === 'packet')).toBe(true);
    expect(messages.some((m) => m.type === 'stress')).toBe(true);
    expect(daemon.status().state).toBe('stopped');
  });
});

describe('daemon helpers', () => {
  it('parses CLI flags', () => {
    expect(parseDaemonArgs(['--simulate', '--port', '9000', '--name', 'WHOOP', '--no-process'])).toMatchObject({
      simulate: true,
      port: 9000,
      name: 'WHOOP',
      process: false,
    });
  });

  it('validates client messages', () => {
    expect(parseClientMessage('{"type":"command","name":"hello"}')).toEqual({ type: 'command', name: 'hello' });
    expect(parseClientMessage('{"type":"rm -rf"}')).toBeNull();
    expect(parseClientMessage('not json')).toBeNull();
  });
});
