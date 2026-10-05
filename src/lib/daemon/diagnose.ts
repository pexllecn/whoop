/**
 * First-contact diagnostics for a real strap (uses noble, like the daemon).
 *
 *   npm run ble:scan                      list every advertising BLE device for 15 s
 *   npm run ble:scan -- --seconds 30
 *   npm run ble:probe -- <peripheral-id>  connect, dump the GATT table, read device info,
 *   npm run ble:probe -- --name WHOOP     subscribe to everything, send CLIENT_HELLO and
 *                                         record every notification for 20 s
 *
 * The probe writes a capture file (data/captures/probe-<time>.json) with the
 * GATT table and every raw notification in hex. It does not touch the database
 * and sends no command except the verified CLIENT_HELLO.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NobleTransport } from '../ble/nobleTransport';
import { BleSession, type RawNotification } from '../ble/session';
import type { DiscoveredDevice } from '../ble/transport';
import { bytesToHex } from '../protocol/bytes';
import { PROPRIETARY_SERVICES, SIG } from '../protocol/constants';
import { PacketDecoder } from '../protocol/decoder';
import { normalizeUuid } from '../protocol/uuid';

const STRAP_SERVICES = new Set([...PROPRIETARY_SERVICES.map((s) => s.uuid), SIG.HEART_RATE_SERVICE]);

export function looksLikeStrap(device: Pick<DiscoveredDevice, 'name' | 'serviceUuids'>): boolean {
  if (device.name && /whoop/i.test(device.name)) return true;
  return device.serviceUuids.some((u) => {
    try {
      return STRAP_SERVICES.has(normalizeUuid(u));
    } catch {
      return false;
    }
  });
}

function shortUuid(uuid: string): string {
  const canonical = normalizeUuid(uuid);
  return canonical.endsWith('-0000-1000-8000-00805f9b34fb') && canonical.startsWith('0000') ? `0x${canonical.slice(4, 8)}` : canonical;
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function scan(argv: string[]): Promise<void> {
  const seconds = Number(flag(argv, 'seconds') ?? 15);
  const transport = new NobleTransport();
  console.log(`Scanning for ${seconds} s (all devices). Make sure the strap is awake and not connected to your phone.\n`);
  await transport.ready();
  const devices = await transport.scan({
    serviceUuids: [],
    timeoutMs: seconds * 1000,
    onDevice: (d) => {
      const mark = looksLikeStrap(d) ? '  <-- possible strap' : '';
      console.log(`${d.id}  rssi ${d.rssi ?? '?'}  name ${JSON.stringify(d.name)}  services [${d.serviceUuids.map(shortUuid).join(', ')}]${mark}`);
    },
  });
  await transport.close();
  const candidates = devices.filter(looksLikeStrap);
  console.log(`\n${devices.length} device(s) seen, ${candidates.length} possible strap(s).`);
  if (candidates.length) {
    console.log(`Next: npm run ble:probe -- ${candidates[0]!.id}`);
  } else {
    console.log('No strap seen. Turn Bluetooth off on your phone (or force-quit the official app), wake the strap, and scan again.');
  }
  process.exit(0);
}

async function probe(argv: string[]): Promise<void> {
  const seconds = Number(flag(argv, 'seconds') ?? 20);
  const name = flag(argv, 'name');
  let deviceId = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--name' && argv[i - 1] !== '--seconds') ?? null;
  const transport = new NobleTransport();
  await transport.ready();

  if (!deviceId) {
    console.log(`Looking for ${name ? `a device named like "${name}"` : 'a strap'} (20 s) ...`);
    const found = await transport.scan({
      serviceUuids: [],
      timeoutMs: 20_000,
      nameFilter: name,
      stopOnFirst: true,
      ...(name ? {} : { match: looksLikeStrap }),
    });
    deviceId = found[0]?.id ?? null;
    if (!deviceId) throw new Error('No matching device found. Run `npm run ble:scan` to see what is advertising.');
  }

  console.log(`Connecting to ${deviceId} ...`);
  const connection = await transport.connect(deviceId);
  const capture = {
    tool: 'openpulse ble:probe',
    startedAt: new Date().toISOString(),
    deviceId,
    deviceName: connection.deviceName,
    gatt: connection.characteristics().map((c) => ({ service: c.serviceUuid, characteristic: c.uuid, properties: c.properties })),
    session: null as unknown,
    error: null as string | null,
    notifications: [] as Array<{ t: number; characteristic: string; hex: string; status: string; error: string | null }>,
  };

  console.log('\nGATT table:');
  let currentService = '';
  for (const c of capture.gatt) {
    if (c.service !== currentService) {
      currentService = c.service;
      console.log(`  service ${shortUuid(c.service)}`);
    }
    console.log(`    ${shortUuid(c.characteristic)}  [${c.properties.join(', ')}]`);
  }

  const decoder = new PacketDecoder();
  const onNotification = (n: RawNotification) => {
    const outcome = decoder.decode(n.characteristicUuid, n.bytes, n.receivedAt);
    capture.notifications.push({ t: n.receivedAt, characteristic: n.characteristicUuid, hex: bytesToHex(n.bytes), status: outcome.status, error: outcome.error });
    const summary = outcome.events
      .map((e) => (e.type === 'heart_rate' ? `HR ${e.bpm ?? '-'} bpm, R-R [${e.rrMs.map((v) => v.toFixed(0)).join(', ')}]` : e.type === 'battery' ? `battery ${e.percent}%` : e.type))
      .join('; ');
    console.log(`  ${shortUuid(n.characteristicUuid)}  ${outcome.status.padEnd(9)} ${bytesToHex(n.bytes).slice(0, 64)}${n.bytes.length > 32 ? '…' : ''}  ${summary}`);
  };

  const session = new BleSession(connection, { onNotification, onLog: (level, message) => console.log(`  [${level}] ${message}`) }, { ackTimeoutMs: 5000 });
  try {
    const info = await session.start();
    capture.session = info;
    console.log(`\nHandshake: service ${info.serviceVariant ?? 'none'} | bond ${info.bond} | hello ack ${info.helloAck} | battery ${info.batteryPercent ?? '?'}%`);
    console.log(`Device info: model ${info.deviceInfo.model ?? '?'} | serial ${info.deviceInfo.serial ? 'read' : '?'} | firmware ${info.deviceInfo.firmware ?? '?'} | hardware ${info.deviceInfo.hardware ?? '?'}`);
    console.log(`\nRecording notifications for ${seconds} s ...`);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  } catch (error) {
    capture.error = error instanceof Error ? error.message : String(error);
    console.error(`\nProbe failed: ${capture.error}`);
  } finally {
    await session.stop().catch(() => undefined);
    await transport.close();
  }

  const dir = path.join(process.cwd(), 'data', 'captures');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `probe-${capture.startedAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(capture, null, 2));
  const counts = capture.notifications.reduce<Record<string, number>>((acc, n) => ((acc[n.status] = (acc[n.status] ?? 0) + 1), acc), {});
  console.log(`\n${capture.notifications.length} notifications ${JSON.stringify(counts)}`);
  console.log(`Capture saved to ${file}`);
  process.exit(capture.error ? 1 : 0);
}

const [command, ...rest] = process.argv.slice(2);
const entry = process.argv[1] ?? '';
if (entry.endsWith('diagnose.ts') || entry.endsWith('diagnose.mjs')) {
  (command === 'probe' ? probe(rest) : command === 'scan' ? scan(rest) : Promise.reject(new Error('Usage: diagnose.ts scan|probe'))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
