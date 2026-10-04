/**
 * BLE connection manager.
 *
 * Runs forever: scan -> connect -> handshake -> stream, and on any disconnect
 * or failure backs off exponentially (1 s doubling to 60 s, with jitter) and
 * starts over. Every notification goes through the raw-first ingest pipeline
 * before anything else; live events are then broadcast to dashboard clients.
 * Every few minutes the daily processor rescores today (and catches up any
 * days missed while the daemon was not running).
 */
import { desc, eq } from 'drizzle-orm';
import { BleSession, type RawNotification, type SessionInfo } from '../ble/session';
import { BleError, type BleTransport } from '../ble/transport';
import { PROPRIETARY_SERVICES, SIG } from '../protocol/constants';
import type { CommandDefinition } from '../protocol/commands';
import { IngestPipeline, activityFromImu } from '../pipeline/ingest';
import { recomputeRange } from '../pipeline/dailyProcessor';
import type { ConnectionState, DaemonStatus, ServerMessage } from '../live/messages';
import type { OpenPulseDb } from '../storage/db';
import { dailySummaries, devices, userBaseline } from '../storage/schema';
import { effectiveMaxHr, getSettings, type AppSettings } from '../storage/settings';
import { addDays, dateKey } from '../time';
import { LiveStressMonitor } from './liveStress';
import { loadCommandCatalogue } from './protocolMap';

export interface DaemonOptions {
  db: OpenPulseDb;
  transport: BleTransport;
  settings: AppSettings;
  processIntervalMs?: number;
  batteryIntervalMs?: number;
  stressIntervalMs?: number;
  scanTimeoutMs?: number;
  maxBackoffMs?: number;
  autoProcess?: boolean;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
}

type Broadcaster = { broadcast(message: ServerMessage): void };

const PACKETS_PER_SECOND = 25;

export class BleDaemon {
  private readonly pipeline: IngestPipeline;
  private readonly stress: LiveStressMonitor;
  private settings: AppSettings;
  private session: BleSession | null = null;
  private broadcaster: Broadcaster | null = null;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private forceReconnect: (() => void) | null = null;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private commands: CommandDefinition[];
  private packetBudget = { second: 0, used: 0 };
  private lastProcessedDate: string | null = null;
  private processing = false;
  private readonly current: DaemonStatus;
  /** Short history replayed to dashboards when they connect. */
  private readonly recent = {
    hr: [] as Array<{ t: number; bpm: number | null; rr: number[]; source: string }>,
    stress: [] as Array<Extract<ServerMessage, { type: 'stress' }>>,
    packets: [] as Array<Extract<ServerMessage, { type: 'packet' }>>,
  };

  constructor(private readonly options: DaemonOptions) {
    this.settings = options.settings;
    this.pipeline = new IngestPipeline(options.db, options.transport.kind);
    this.stress = new LiveStressMonitor(this.stressReference());
    const catalogue = loadCommandCatalogue();
    if (catalogue.error) this.log('warn', catalogue.error);
    this.commands = catalogue.commands;
    this.current = {
      state: 'idle',
      transport: options.transport.kind,
      device: null,
      batteryPercent: null,
      bond: null,
      helloAck: null,
      lastPacketAt: null,
      packetsThisSession: 0,
      reconnectAttempt: 0,
      error: null,
      lastProcessedAt: null,
      commands: this.commands.map((c) => ({ name: c.name, label: c.label, provenance: c.provenance, verified: c.verified })),
    };
  }

  setBroadcaster(broadcaster: Broadcaster): void {
    this.broadcaster = broadcaster;
  }

  status(): DaemonStatus {
    return { ...this.current };
  }

  backlog(): Extract<ServerMessage, { type: 'backlog' }> {
    return {
      type: 'backlog',
      hr: [...this.recent.hr],
      stress: this.recent.stress.map(({ type: _type, ...rest }) => rest),
      packets: this.recent.packets.map(({ type: _type, ...rest }) => rest),
    };
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
    if (level !== 'debug') this.broadcaster?.broadcast({ type: 'log', level, message, t: Date.now() });
  }

  private setState(state: ConnectionState, error: string | null = this.current.error): void {
    this.current.state = state;
    this.current.error = error;
    this.broadcaster?.broadcast({ type: 'status', status: this.status() });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.runLoop();
    this.timers.push(
      setInterval(() => this.emitStress(), this.options.stressIntervalMs ?? 5000),
      setInterval(() => void this.readBattery(), this.options.batteryIntervalMs ?? 10 * 60_000),
    );
    if (this.options.autoProcess !== false) {
      this.timers.push(setInterval(() => this.processNow(), this.options.processIntervalMs ?? 5 * 60_000));
      setTimeout(() => this.processNow(), 3000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.wake?.();
    this.forceReconnect?.();
    if (this.session) await this.session.stop().catch(() => undefined);
    await this.loop?.catch(() => undefined);
    await this.options.transport.close().catch(() => undefined);
    this.setState('stopped');
  }

  /** Drop the current link (if any) and reconnect immediately. */
  requestReconnect(): void {
    this.current.reconnectAttempt = 0;
    this.forceReconnect?.();
    this.wake?.();
  }

  private async runLoop(): Promise<void> {
    const maxBackoff = this.options.maxBackoffMs ?? 60_000;
    while (!this.stopped) {
      try {
        await this.connectOnce();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(error instanceof BleError && error.code === 'NOT_FOUND' ? 'info' : 'warn', message);
        this.current.error = message;
      }
      this.session = null;
      if (this.stopped) break;
      const attempt = this.current.reconnectAttempt++;
      const delay = Math.min(maxBackoff, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
      this.setState('reconnecting');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async connectOnce(): Promise<void> {
    const { transport } = this.options;
    this.settings = getSettings(this.options.db);
    this.setState('scanning', null);
    await transport.ready();

    let deviceId = this.settings.daemon.deviceId;
    if (!deviceId) {
      const found = await transport.scan({
        serviceUuids: [...PROPRIETARY_SERVICES.map((s) => s.uuid), SIG.HEART_RATE_SERVICE],
        timeoutMs: this.options.scanTimeoutMs ?? 20_000,
        nameFilter: this.settings.daemon.nameFilter ?? undefined,
        stopOnFirst: true,
      });
      deviceId = found[0]?.id ?? null;
      if (!deviceId) throw new BleError('NOT_FOUND', 'No strap found. Is it awake, nearby and not connected to another app?');
    }

    this.setState('connecting');
    const connection = await transport.connect(deviceId);
    this.pipeline.resetConnection(deviceId);
    const disconnected = new Promise<string>((resolve) => {
      connection.onDisconnect(resolve);
      this.forceReconnect = () => {
        void connection.disconnect();
        resolve('reconnect requested');
      };
    });

    this.setState('handshaking');
    const startup = this.settings.daemon.startupCommands
      .map((name) => this.commands.find((c) => c.name === name))
      .filter((c): c is CommandDefinition => Boolean(c));
    const session = new BleSession(
      connection,
      { onNotification: (n) => this.handleNotification(n), onLog: (level, message) => this.log(level, message) },
      { startupCommands: startup },
    );
    this.session = session;
    let info: SessionInfo;
    try {
      info = await session.start();
    } catch (error) {
      await session.stop().catch(() => undefined);
      throw error;
    }
    this.recordDevice(info);
    this.current.packetsThisSession = 0;
    this.current.reconnectAttempt = 0;
    this.setState('streaming', null);
    this.log('info', `Streaming from ${info.deviceName ?? info.deviceId} (bond ${info.bond}, hello ack ${info.helloAck})`);

    const reason = await disconnected;
    this.forceReconnect = null;
    await session.drain().catch(() => undefined);
    this.log('info', `Disconnected: ${reason}`);
  }

  private recordDevice(info: SessionInfo): void {
    const now = Date.now();
    this.current.device = {
      id: info.deviceId,
      name: info.deviceName,
      model: info.deviceInfo.model,
      serial: info.deviceInfo.serial,
      firmware: info.deviceInfo.firmware,
      hardware: info.deviceInfo.hardware,
      serviceVariant: info.serviceVariant,
    };
    this.current.batteryPercent = info.batteryPercent;
    this.current.bond = info.bond;
    this.current.helloAck = info.helloAck;
    const values = {
      id: info.deviceId,
      name: info.deviceName,
      transport: this.options.transport.kind,
      serviceVariant: info.serviceVariant,
      model: info.deviceInfo.model,
      serial: info.deviceInfo.serial,
      firmware: info.deviceInfo.firmware,
      hardware: info.deviceInfo.hardware,
      batteryPct: info.batteryPercent,
      batteryAt: info.batteryPercent === null ? null : now,
      lastConnectedAt: now,
      lastSeenAt: now,
    };
    this.options.db.insert(devices).values(values).onConflictDoUpdate({ target: devices.id, set: values }).run();
  }

  private handleNotification(notification: RawNotification): void {
    const { rawPacketId, outcome } = this.pipeline.ingest(notification);
    this.current.lastPacketAt = notification.receivedAt;
    this.current.packetsThisSession++;

    const second = Math.floor(notification.receivedAt / 1000);
    if (second !== this.packetBudget.second) this.packetBudget = { second, used: 0 };
    if (this.packetBudget.used++ < PACKETS_PER_SECOND) {
      const hex = Array.from(notification.bytes.subarray(0, 48), (b) => b.toString(16).padStart(2, '0')).join('');
      const packet: Extract<ServerMessage, { type: 'packet' }> = {
        type: 'packet',
        id: rawPacketId,
        t: notification.receivedAt,
        uuid: notification.characteristicUuid,
        hex: notification.bytes.length > 48 ? `${hex}…` : hex,
        status: outcome.status,
        length: notification.bytes.length,
      };
      this.recent.packets = [packet, ...this.recent.packets].slice(0, 80);
      this.broadcaster?.broadcast(packet);
    }

    for (const event of outcome.events) {
      if (event.type === 'heart_rate') {
        this.stress.addHeartRate(event.at, event.bpm, event.rrMs, event.source);
        const cutoff = event.at - 10 * 60_000;
        this.recent.hr.push({ t: event.at, bpm: event.bpm, rr: event.rrMs, source: event.source });
        if (this.recent.hr[0]!.t < cutoff) this.recent.hr = this.recent.hr.filter((h) => h.t >= cutoff);
        this.broadcaster?.broadcast({ type: 'hr', t: event.at, bpm: event.bpm, rr: event.rrMs, source: event.source });
      } else if (event.type === 'battery') {
        this.current.batteryPercent = event.percent;
        if (this.current.device) {
          this.options.db.update(devices).set({ batteryPct: event.percent, batteryAt: event.at }).where(eq(devices.id, this.current.device.id)).run();
        }
        this.broadcaster?.broadcast({ type: 'battery', t: event.at, percent: event.percent });
      } else if (event.type === 'motion' && !event.historical) {
        const activity = activityFromImu(event.samples);
        this.stress.addMotion(event.at, activity);
        this.broadcaster?.broadcast({ type: 'motion', t: event.at, activity });
      }
    }
  }

  private emitStress(): void {
    if (this.current.state !== 'streaming') return;
    const now = Date.now();
    const result = this.stress.score(now);
    const message: Extract<ServerMessage, { type: 'stress' }> = {
      type: 'stress',
      t: now,
      score: result.score,
      reason: result.reason,
      hr60: result.hr60,
      lnRmssd60: result.lnRmssd60,
      rmssd60: result.rmssd60,
    };
    this.recent.stress.push(message);
    if (this.recent.stress[0]!.t < now - 60 * 60_000) this.recent.stress = this.recent.stress.filter((m) => m.t >= now - 60 * 60_000);
    this.broadcaster?.broadcast(message);
  }

  private async readBattery(): Promise<void> {
    if (!this.session || this.current.state !== 'streaming') return;
    try {
      const percent = await this.session.readBattery();
      if (percent !== null) this.handleNotification({ characteristicUuid: SIG.BATTERY_LEVEL, bytes: Uint8Array.of(percent), receivedAt: Date.now() });
    } catch (error) {
      this.log('debug', `Battery read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async sendCommand(name: string): Promise<ServerMessage> {
    const definition = this.commands.find((c) => c.name === name);
    if (!definition) return { type: 'command_result', name, ok: false, error: `Unknown command "${name}"` };
    if (!this.session || this.current.state !== 'streaming') return { type: 'command_result', name, ok: false, error: 'Not connected' };
    try {
      const result = await this.session.sendCommand(definition);
      this.log('info', `Sent ${name} (seq ${result.sequence}): ack ${result.ack}`);
      return { type: 'command_result', name, ok: true, sequence: result.sequence, ack: result.ack, hex: result.hex };
    } catch (error) {
      return { type: 'command_result', name, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Rescore today, catching up every day since the last processed one. */
  processNow(): void {
    if (this.processing) return;
    this.processing = true;
    try {
      this.settings = getSettings(this.options.db);
      const today = dateKey(Date.now(), this.settings.timeZone);
      if (!this.lastProcessedDate) {
        const last = this.options.db
          .select({ date: dailySummaries.date })
          .from(dailySummaries)
          .where(eq(dailySummaries.source, 'openpulse'))
          .orderBy(desc(dailySummaries.date))
          .limit(1)
          .get();
        this.lastProcessedDate = last?.date ?? addDays(today, -1);
      }
      const from = this.lastProcessedDate < today ? this.lastProcessedDate : today;
      recomputeRange({ db: this.options.db, settings: this.settings }, from, today);
      this.lastProcessedDate = today;
      this.current.lastProcessedAt = Date.now();
      this.stress.setReference(this.stressReference());
      this.broadcaster?.broadcast({ type: 'processed', t: Date.now(), date: today });
    } catch (error) {
      this.log('error', `Processing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.processing = false;
    }
  }

  private stressReference() {
    const latest = (metric: string) =>
      this.options.db.select().from(userBaseline).where(eq(userBaseline.metric, metric)).orderBy(desc(userBaseline.date)).limit(1).get();
    const rhr = latest('resting_hr')?.mean ?? 60;
    const ln = latest('ln_rmssd');
    const dayLn = latest('day_ln_rmssd');
    return {
      restingHr: rhr,
      maxHr: effectiveMaxHr(this.settings.profile),
      dayRestHr: latest('day_rest_hr')?.mean ?? rhr + 15,
      dayLnRmssd: dayLn?.mean ?? (ln ? ln.mean - 0.6 : Math.log(30)),
      dayLnRmssdSd: dayLn?.sd ?? 0.3,
    };
  }
}
