/**
 * A software strap for development without hardware. It exposes the same
 * GATT layout as the real device, streams 0x2A37 heart-rate notifications from
 * the physiology simulator, answers commands on the proprietary channel and
 * emits proprietary records (fragmented across notifications) so the whole
 * raw-first pipeline runs end to end. Everything it produces is stored with
 * source 'simulator'.
 */
import { PacketType, SIG, WHOOP5, HRM_FLAGS, Opcode } from '../protocol/constants';
import { writeI16LE, writeU16LE, writeU32LE } from '../protocol/bytes';
import { buildFrame } from '../protocol/commands';
import { parseFrame } from '../protocol/packetParser';
import { normalizeUuid } from '../protocol/uuid';
import { PhysiologySimulator, beatsToNotifications } from '../simulation/physiologySimulator';
import { dateKey } from '../time';
import {
  BleError,
  type BleConnection,
  type BleTransport,
  type CharacteristicInfo,
  type DiscoveredDevice,
  type ScanOptions,
} from './transport';

export const SIMULATOR_DEVICE_ID = 'openpulse-simulator';
const TEXT = new TextEncoder();
/** Typical ATT payload size after MTU negotiation; frames larger than this are fragmented. */
const NOTIFICATION_CHUNK = 182;

export interface SimulatorOptions {
  timeZone: string;
  seed?: number;
  now?: () => number;
  /** Emit automatically every second (default). Tests drive `step()` manually instead. */
  autoTick?: boolean;
}

/** Encode a Heart Rate Measurement value exactly as a strap would (uint8 BPM + R-R in 1/1024 s). */
export function encodeHeartRateMeasurement(bpm: number, rrMs: number[]): Uint8Array {
  const flags = HRM_FLAGS.SENSOR_CONTACT_SUPPORTED | HRM_FLAGS.SENSOR_CONTACT_DETECTED | (rrMs.length ? HRM_FLAGS.RR_INTERVAL_PRESENT : 0);
  const out = new Uint8Array(2 + rrMs.length * 2);
  out[0] = flags;
  out[1] = Math.max(0, Math.min(255, Math.round(bpm)));
  rrMs.forEach((rr, i) => writeU16LE(out, 2 + i * 2, Math.round((rr * 1024) / 1000)));
  return out;
}

class SimulatorConnection implements BleConnection {
  readonly deviceId = SIMULATOR_DEVICE_ID;
  readonly deviceName = 'OpenPulse Simulator';
  private readonly listeners = new Map<string, (data: Uint8Array) => void>();
  private readonly disconnectListeners = new Set<(reason: string) => void>();
  private readonly simulator: PhysiologySimulator;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStep: number;
  private battery = 87;
  private realtimeRecords = false;
  private imuStream = false;
  private connected = true;
  private secondCounter = 0;

  constructor(private readonly options: SimulatorOptions) {
    const now = this.now();
    this.simulator = PhysiologySimulator.forRange(dateKey(now, options.timeZone), 3, options.timeZone, options.seed ?? 11);
    this.lastStep = now - 1000;
    if (options.autoTick !== false) {
      this.timer = setInterval(() => this.step(this.now()), 1000);
    }
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  characteristics(): CharacteristicInfo[] {
    const notify = (uuid: string, serviceUuid: string): CharacteristicInfo => ({ uuid, serviceUuid, properties: ['notify'] });
    const read = (uuid: string, serviceUuid: string): CharacteristicInfo => ({ uuid, serviceUuid, properties: ['read'] });
    return [
      notify(SIG.HEART_RATE_MEASUREMENT, SIG.HEART_RATE_SERVICE),
      { uuid: SIG.BATTERY_LEVEL, serviceUuid: SIG.BATTERY_SERVICE, properties: ['read', 'notify'] },
      read(SIG.MODEL_NUMBER, SIG.DEVICE_INFORMATION_SERVICE),
      read(SIG.SERIAL_NUMBER, SIG.DEVICE_INFORMATION_SERVICE),
      read(SIG.FIRMWARE_REVISION, SIG.DEVICE_INFORMATION_SERVICE),
      read(SIG.HARDWARE_REVISION, SIG.DEVICE_INFORMATION_SERVICE),
      { uuid: WHOOP5.COMMAND, serviceUuid: WHOOP5.SERVICE, properties: ['write', 'writeWithoutResponse'] },
      notify(WHOOP5.COMMAND_RESPONSE, WHOOP5.SERVICE),
      notify(WHOOP5.DATA_PRIMARY, WHOOP5.SERVICE),
      notify(WHOOP5.DATA_SECONDARY, WHOOP5.SERVICE),
      notify(WHOOP5.SYSTEM_STATUS, WHOOP5.SERVICE),
    ];
  }

  async read(uuid: string): Promise<Uint8Array> {
    this.assertConnected();
    switch (normalizeUuid(uuid)) {
      case SIG.MODEL_NUMBER:
        return TEXT.encode('SIM-5.0');
      case SIG.SERIAL_NUMBER:
        return TEXT.encode('SIM00000001');
      case SIG.FIRMWARE_REVISION:
        return TEXT.encode('sim-1.0.0');
      case SIG.HARDWARE_REVISION:
        return TEXT.encode('sim-hw-1');
      case SIG.BATTERY_LEVEL:
        return Uint8Array.of(this.battery);
      default:
        throw new BleError('CHARACTERISTIC_MISSING', `Characteristic ${uuid} is not readable`);
    }
  }

  async write(uuid: string, data: Uint8Array): Promise<void> {
    this.assertConnected();
    if (normalizeUuid(uuid) !== WHOOP5.COMMAND) throw new BleError('WRITE_FAILED', `Characteristic ${uuid} is not writable`);
    const parsed = parseFrame(data);
    if (!parsed.ok || parsed.value.packetType !== PacketType.COMMAND) return; // a real strap ignores garbage
    const { sequenceOrRecord: sequence, opcodeOrSubtype: opcode } = parsed.value;
    if (opcode === Opcode.TOGGLE_REALTIME_HR) this.realtimeRecords = !this.realtimeRecords;
    if (opcode === Opcode.TOGGLE_IMU_MODE) this.imuStream = !this.imuStream;
    const response = buildFrame(Uint8Array.of(PacketType.COMMAND_RESPONSE, sequence, opcode ?? 0, 0x00), 0x0001);
    queueMicrotask(() => this.emit(WHOOP5.COMMAND_RESPONSE, response));
  }

  async subscribe(uuid: string, listener: (data: Uint8Array) => void): Promise<void> {
    this.assertConnected();
    this.listeners.set(normalizeUuid(uuid), listener);
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.disconnectListeners) listener('simulator disconnected');
  }

  /** Emit everything that happened in (lastStep, now]. */
  step(now: number): void {
    if (!this.connected) return;
    const from = this.lastStep;
    const to = Math.max(from + 1000, now);
    this.lastStep = to;
    const beats = this.simulator.beats(from, to);
    for (const n of beatsToNotifications(beats, from, to)) {
      this.secondCounter++;
      this.emit(SIG.HEART_RATE_MEASUREMENT, encodeHeartRateMeasurement(n.bpm, n.rr));
      if (this.realtimeRecords) this.emit(WHOOP5.DATA_PRIMARY, this.realtimeRecord(n.t, n.bpm, n.rr));
      if (this.imuStream) this.emitFragmented(WHOOP5.DATA_SECONDARY, this.imuRecord(n.t));
      if (this.secondCounter % 10 === 0) this.emit(WHOOP5.SYSTEM_STATUS, this.statusRecord(n.t));
      if (this.secondCounter % 1200 === 0 && this.battery > 5) {
        this.battery--;
        this.emit(SIG.BATTERY_LEVEL, Uint8Array.of(this.battery));
      }
    }
  }

  /** Compact 0x28 realtime record: time u32 @2, HR @8, valid @9, u16 @10. */
  private realtimeRecord(t: number, bpm: number, rr: number[]): Uint8Array {
    const body = new Uint8Array(20);
    body[0] = PacketType.REALTIME_DATA;
    body[1] = 0x02;
    writeU32LE(body, 2, Math.floor(t / 1000));
    body[8] = bpm;
    body[9] = rr.length ? 1 : 0;
    writeU16LE(body, 10, rr.length ? Math.round(rr[rr.length - 1]!) : 0);
    body[18] = 0x01;
    return buildFrame(body, 0x0001);
  }

  /** 0x33 IMU record with 25 accelerometer/gyroscope samples. */
  private imuRecord(t: number): Uint8Array {
    const count = 25;
    const body = new Uint8Array(28 + count * 12);
    body[0] = PacketType.REALTIME_IMU;
    body[1] = 0x01;
    writeU32LE(body, 7, Math.floor(t / 1000));
    writeU16LE(body, 24, count);
    writeU16LE(body, 26, count);
    const activity = this.simulator.motion(t - 1000, t, 1000)[0]?.activity ?? 0.01;
    for (let i = 0; i < count; i++) {
      const wobble = Math.sin((i / count) * Math.PI * 2) * activity;
      writeI16LE(body, 28 + i * 12, Math.round(wobble * 4096));
      writeI16LE(body, 30 + i * 12, Math.round(wobble * 0.5 * 4096));
      writeI16LE(body, 32 + i * 12, Math.round((1 + wobble * 0.3) * 4096));
    }
    return buildFrame(body, 0x0001);
  }

  /** A periodic system-status frame. Its layout is deliberately unmapped (exercises the 'unmapped' path). */
  private statusRecord(t: number): Uint8Array {
    const body = new Uint8Array(12);
    body[0] = 0x31;
    body[1] = 0x00;
    writeU32LE(body, 2, Math.floor(t / 1000));
    body[6] = this.battery;
    return buildFrame(body, 0x0001);
  }

  private emitFragmented(uuid: string, frame: Uint8Array): void {
    for (let offset = 0; offset < frame.length; offset += NOTIFICATION_CHUNK) {
      this.emit(uuid, frame.slice(offset, offset + NOTIFICATION_CHUNK));
    }
  }

  private emit(uuid: string, data: Uint8Array): void {
    this.listeners.get(normalizeUuid(uuid))?.(data);
  }

  private assertConnected(): void {
    if (!this.connected) throw new BleError('DISCONNECTED', 'Simulator is disconnected');
  }
}

export class SimulatorTransport implements BleTransport {
  readonly kind = 'simulator' as const;
  private connection: SimulatorConnection | null = null;

  constructor(private readonly options: SimulatorOptions) {}

  async ready(): Promise<void> {}

  async scan(options: ScanOptions): Promise<DiscoveredDevice[]> {
    const device: DiscoveredDevice = {
      id: SIMULATOR_DEVICE_ID,
      name: 'OpenPulse Simulator',
      rssi: -42,
      serviceUuids: [WHOOP5.SERVICE, SIG.HEART_RATE_SERVICE],
    };
    options.onDevice?.(device);
    return [device];
  }

  async connect(deviceId: string): Promise<BleConnection> {
    if (deviceId !== SIMULATOR_DEVICE_ID) throw new BleError('NOT_FOUND', `Unknown simulator device ${deviceId}`);
    this.connection = new SimulatorConnection(this.options);
    return this.connection;
  }

  /** Manually advance the simulated strap (tests). */
  step(now: number): void {
    this.connection?.step(now);
  }

  async close(): Promise<void> {
    await this.connection?.disconnect();
    this.connection = null;
  }
}
