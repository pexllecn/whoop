import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { BleSession } from '@/lib/ble/session';
import { SIMULATOR_DEVICE_ID, SimulatorTransport } from '@/lib/ble/simulatorTransport';
import { BUILTIN_COMMANDS } from '@/lib/protocol/commands';
import { IngestPipeline } from '@/lib/pipeline/ingest';
import { rawPacketStatusCounts, replayRawPackets, stalePacketCount } from '@/lib/storage/replay';
import { hrRrSamples, motionSamples, rawPackets } from '@/lib/storage/schema';
import { memoryDb } from '../helpers/db';

const START = Date.UTC(2026, 9, 4, 10, 0, 0);

async function captureSession() {
  const db = memoryDb();
  let clock = START;
  const transport = new SimulatorTransport({ timeZone: 'UTC', autoTick: false, now: () => clock, seed: 5 });
  const connection = await transport.connect(SIMULATOR_DEVICE_ID);
  const pipeline = new IngestPipeline(db, 'simulator', SIMULATOR_DEVICE_ID);
  const session = new BleSession(connection, { onNotification: (n) => void pipeline.ingest(n) }, { ackTimeoutMs: 200, now: () => clock });
  await session.start();
  await session.sendCommand(BUILTIN_COMMANDS.toggleImuMode!);
  await session.sendCommand(BUILTIN_COMMANDS.toggleRealtimeHr!);
  for (let i = 0; i < 30; i++) {
    clock += 1000;
    transport.step(clock);
  }
  await session.drain();
  await session.stop();
  return db;
}

const count = (db: ReturnType<typeof memoryDb>, table: typeof hrRrSamples | typeof motionSamples) =>
  db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;

describe('replayRawPackets', () => {
  it('rebuilds derived rows identically from raw packets', async () => {
    const db = await captureSession();
    const before = { hr: count(db, hrRrSamples), motion: count(db, motionSamples), statuses: rawPacketStatusCounts(db) };
    expect(before.hr).toBeGreaterThan(30);
    expect(before.motion).toBeGreaterThan(20);
    expect(before.statuses.fragment).toBeGreaterThan(0);
    expect(before.statuses.unmapped).toBeGreaterThan(0);

    // Simulate an older parser: wipe derived data and parser versions.
    db.delete(hrRrSamples).run();
    db.delete(motionSamples).run();
    db.update(rawPackets).set({ parserVersion: null, decodedStatus: 'pending' }).run();
    expect(stalePacketCount(db)).toBeGreaterThan(0);

    const report = replayRawPackets(db, { staleOnly: true, batchSize: 17 });
    expect(report.packets).toBe(db.select({ n: sql<number>`count(*)` }).from(rawPackets).get()!.n);
    expect(count(db, hrRrSamples)).toBe(before.hr);
    expect(count(db, motionSamples)).toBe(before.motion);
    expect(rawPacketStatusCounts(db)).toEqual(before.statuses);
    expect(report.sampleRange).not.toBeNull();
    expect(stalePacketCount(db)).toBe(0);
  });

  it('is idempotent', async () => {
    const db = await captureSession();
    replayRawPackets(db);
    const hr = count(db, hrRrSamples);
    replayRawPackets(db);
    expect(count(db, hrRrSamples)).toBe(hr);
  });

  it('handles an empty database', () => {
    expect(replayRawPackets(memoryDb()).packets).toBe(0);
  });
});
