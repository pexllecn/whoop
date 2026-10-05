import {
  NOTIFY_ROLES,
  PROPRIETARY_SERVICES,
  SIG,
  characteristicsForService,
  type ProprietaryServiceId,
} from '../protocol/constants';
import { CLIENT_HELLO, CLIENT_HELLO_SEQUENCE, CommandSequencer, encodeCommand, matchAck, BUILTIN_COMMANDS, type CommandDefinition } from '../protocol/commands';
import { FrameAssembler } from '../protocol/frameAssembler';
import { parseBatteryLevel, parseUtf8String } from '../protocol/packetParser';
import { normalizeUuid } from '../protocol/uuid';
import { BleError, isAuthenticationError, type BleConnection } from './transport';

export interface RawNotification {
  characteristicUuid: string;
  bytes: Uint8Array;
  receivedAt: number;
}

export type BondCheck = 'passed' | 'failed' | 'not_applicable';
export type AckResult = 'opcode' | 'sequence' | 'timeout' | 'not_sent';

export interface DeviceInfo {
  model: string | null;
  serial: string | null;
  firmware: string | null;
  hardware: string | null;
}

export interface SessionInfo {
  deviceId: string;
  deviceName: string | null;
  serviceVariant: ProprietaryServiceId | null;
  deviceInfo: DeviceInfo;
  batteryPercent: number | null;
  bond: BondCheck;
  helloAck: AckResult;
  subscribed: string[];
}

export interface SessionCallbacks {
  /**
   * Raw-first sink. Called for every notification, in arrival order, before
   * anything else looks at the bytes. Returning a promise holds back the next
   * notification until persistence finished.
   */
  onNotification(notification: RawNotification): void | Promise<void>;
  onLog?(level: 'debug' | 'info' | 'warn' | 'error', message: string): void;
}

export interface SessionOptions {
  ackTimeoutMs?: number;
  /** Commands sent after the hello handshake, in order. */
  startupCommands?: CommandDefinition[];
  now?: () => number;
}

interface PendingAck {
  opcode: number;
  sequence: number;
  resolve: (result: AckResult) => void;
}

/**
 * Drives one connected strap through the wake handshake:
 *   1. verify the link can access protected characteristics (bond check)
 *   2. subscribe to 0x2A37 and the proprietary notify characteristics
 *   3. write CLIENT_HELLO to the command characteristic
 *   4. wait for the ack on the command-response characteristic
 *   5. issue any configured startup commands
 * Every notification is handed to `onNotification` first (raw-first rule).
 */
export class BleSession {
  private readonly sequencer = new CommandSequencer(CLIENT_HELLO_SEQUENCE);
  private readonly ackAssembler = new FrameAssembler();
  private readonly pendingAcks: PendingAck[] = [];
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private serviceVariant: ProprietaryServiceId | null = null;
  private commandUuid: string | null = null;
  private commandResponseUuid: string | null = null;
  private stopped = false;

  constructor(
    readonly connection: BleConnection,
    private readonly callbacks: SessionCallbacks,
    private readonly options: SessionOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.callbacks.onLog?.(level, message);
  }

  private available(): Set<string> {
    return new Set(this.connection.characteristics().map((c) => normalizeUuid(c.uuid)));
  }

  async start(): Promise<SessionInfo> {
    const available = this.available();
    for (const service of PROPRIETARY_SERVICES) {
      const chars = characteristicsForService(service.uuid);
      if (available.has(chars.COMMAND)) {
        this.serviceVariant = service.id;
        this.commandUuid = chars.COMMAND;
        this.commandResponseUuid = chars.COMMAND_RESPONSE;
        break;
      }
    }
    if (!this.serviceVariant && !available.has(SIG.HEART_RATE_MEASUREMENT)) {
      throw new BleError('CHARACTERISTIC_MISSING', 'Device exposes neither the proprietary service nor the Heart Rate service');
    }

    // 1. Bond check: Device Information reads succeed only over an accepted link;
    //    an authentication/encryption failure means the strap is not bonded to this host.
    let bond: BondCheck = 'not_applicable';
    const deviceInfo: DeviceInfo = { model: null, serial: null, firmware: null, hardware: null };
    const readString = async (uuid: string): Promise<string | null> => {
      if (!available.has(uuid)) return null;
      try {
        const value = parseUtf8String(await this.connection.read(uuid));
        bond = 'passed';
        return value || null;
      } catch (error) {
        if (isAuthenticationError(error)) {
          bond = 'failed';
          throw new BleError(
            'BOND_REQUIRED',
            'The strap rejected an unencrypted read. Pair (bond) it with this computer in the OS Bluetooth settings and retry.',
          );
        }
        this.log('debug', `Read ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    };
    deviceInfo.model = await readString(SIG.MODEL_NUMBER);
    deviceInfo.serial = await readString(SIG.SERIAL_NUMBER);
    deviceInfo.firmware = await readString(SIG.FIRMWARE_REVISION);
    deviceInfo.hardware = await readString(SIG.HARDWARE_REVISION);

    let batteryPercent: number | null = null;
    if (available.has(SIG.BATTERY_LEVEL)) {
      try {
        const parsed = parseBatteryLevel(await this.connection.read(SIG.BATTERY_LEVEL));
        if (parsed.ok) batteryPercent = parsed.value;
      } catch (error) {
        this.log('debug', `Battery read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 2. Subscriptions. Proprietary subscriptions double as the bond check when DIS is absent.
    const subscribed: string[] = [];
    const subscribe = async (uuid: string, required: boolean) => {
      if (!available.has(uuid)) return;
      try {
        await this.connection.subscribe(uuid, (bytes) => this.enqueue(uuid, bytes));
        subscribed.push(uuid);
      } catch (error) {
        if (isAuthenticationError(error)) {
          bond = 'failed';
          throw new BleError('BOND_REQUIRED', `Subscribing to ${uuid} requires an encrypted (bonded) link`);
        }
        if (required) throw error;
        this.log('warn', `Subscribe ${uuid} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await subscribe(SIG.HEART_RATE_MEASUREMENT, false);
    await subscribe(SIG.BATTERY_LEVEL, false);
    if (this.serviceVariant) {
      const chars = characteristicsForService(PROPRIETARY_SERVICES.find((s) => s.id === this.serviceVariant)!.uuid);
      for (const role of NOTIFY_ROLES) await subscribe(chars[role], role === 'COMMAND_RESPONSE');
      if (bond === 'not_applicable' && subscribed.some((u) => u !== SIG.HEART_RATE_MEASUREMENT && u !== SIG.BATTERY_LEVEL)) {
        bond = 'passed';
      }
    }

    // 3-4. Hello + ack.
    let helloAck: AckResult = 'not_sent';
    if (this.commandUuid) {
      helloAck = await this.writeAndAwaitAck(CLIENT_HELLO, BUILTIN_COMMANDS.hello!.opcode, CLIENT_HELLO_SEQUENCE);
      this.sequencer.reset(CLIENT_HELLO_SEQUENCE + 1);
      if (helloAck === 'timeout') this.log('warn', 'No ack for CLIENT_HELLO; continuing (standard HR service still streams)');
      else this.log('info', `CLIENT_HELLO acknowledged (${helloAck} match)`);

      // 5. Startup commands.
      for (const command of this.options.startupCommands ?? []) {
        const result = await this.sendCommand(command);
        this.log('info', `Startup command ${command.name}: ack=${result.ack}`);
      }
    }

    return {
      deviceId: this.connection.deviceId,
      deviceName: this.connection.deviceName,
      serviceVariant: this.serviceVariant,
      deviceInfo,
      batteryPercent,
      bond,
      helloAck,
      subscribed,
    };
  }

  /** Send a catalogue or protocol-map command with the next sequence number. */
  async sendCommand(definition: CommandDefinition): Promise<{ sequence: number; ack: AckResult; hex: string }> {
    if (!this.commandUuid) throw new BleError('CHARACTERISTIC_MISSING', 'This device has no proprietary command characteristic');
    const sequence = definition.name === 'hello' ? CLIENT_HELLO_SEQUENCE : this.sequencer.next();
    const frame = definition.name === 'hello' ? CLIENT_HELLO : encodeCommand(definition, sequence);
    const ack = await this.writeAndAwaitAck(frame, definition.opcode, sequence);
    return { sequence, ack, hex: Array.from(frame, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase() };
  }

  async readBattery(): Promise<number | null> {
    if (!this.available().has(SIG.BATTERY_LEVEL)) return null;
    const parsed = parseBatteryLevel(await this.connection.read(SIG.BATTERY_LEVEL));
    return parsed.ok ? parsed.value : null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const pending of this.pendingAcks.splice(0)) pending.resolve('timeout');
    await this.queue.catch(() => undefined);
    await this.connection.disconnect();
  }

  /** Wait for every queued notification to be persisted. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private async writeAndAwaitAck(frame: Uint8Array, opcode: number, sequence: number): Promise<AckResult> {
    const timeoutMs = this.options.ackTimeoutMs ?? 3000;
    const ack = new Promise<AckResult>((resolve) => {
      const pending: PendingAck = { opcode, sequence, resolve };
      this.pendingAcks.push(pending);
      setTimeout(() => {
        const index = this.pendingAcks.indexOf(pending);
        if (index >= 0) {
          this.pendingAcks.splice(index, 1);
          resolve('timeout');
        }
      }, timeoutMs);
    });
    const commandChar = this.connection.characteristics().find((c) => normalizeUuid(c.uuid) === this.commandUuid);
    const withoutResponse = commandChar ? !commandChar.properties.includes('write') && commandChar.properties.includes('writeWithoutResponse') : false;
    try {
      await this.connection.write(this.commandUuid!, frame, { withoutResponse });
    } catch (error) {
      const index = this.pendingAcks.findIndex((p) => p.opcode === opcode && p.sequence === sequence);
      if (index >= 0) this.pendingAcks.splice(index, 1);
      if (isAuthenticationError(error)) throw new BleError('BOND_REQUIRED', 'Command write rejected: the link is not encrypted');
      throw new BleError('WRITE_FAILED', `Command write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return ack;
  }

  private enqueue(characteristicUuid: string, bytes: Uint8Array): void {
    if (this.stopped) return;
    const notification: RawNotification = { characteristicUuid, bytes: bytes.slice(), receivedAt: this.now() };
    this.queue = this.queue
      .then(async () => {
        await this.callbacks.onNotification(notification);
        if (characteristicUuid === this.commandResponseUuid) this.inspectForAck(notification.bytes);
      })
      .catch((error: unknown) => {
        this.log('error', `Notification handling failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }

  private inspectForAck(bytes: Uint8Array): void {
    for (const event of this.ackAssembler.push(bytes).events) {
      if (event.type !== 'frame') continue;
      for (let i = 0; i < this.pendingAcks.length; i++) {
        const pending = this.pendingAcks[i]!;
        const match = matchAck(event.frame, pending);
        if (match) {
          this.pendingAcks.splice(i, 1);
          pending.resolve(match);
          break;
        }
      }
    }
  }
}
