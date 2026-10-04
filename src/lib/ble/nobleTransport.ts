/**
 * BLE transport for the Node daemon using @abandonware/noble.
 *
 * noble is an optional native dependency (CoreBluetooth on macOS, HCI sockets
 * on Linux, WinRT on Windows). It is imported lazily so the rest of OpenPulse
 * (dashboard, importers, simulator) works on machines where it cannot build.
 */
import { toUint8Array } from '../protocol/bytes';
import { normalizeUuid, toNobleUuid } from '../protocol/uuid';
import {
  BleError,
  withTimeout,
  type BleConnection,
  type BleTransport,
  type CharacteristicInfo,
  type DiscoveredDevice,
  type ScanOptions,
} from './transport';

// Minimal structural types for the parts of noble we use.
interface NobleCharacteristic {
  uuid: string;
  properties: string[];
  readAsync(): Promise<Buffer>;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  subscribeAsync(): Promise<void>;
  on(event: 'data', listener: (data: Buffer, isNotification: boolean) => void): void;
  removeAllListeners(event?: string): void;
  _serviceUuid?: string;
}

interface NobleService {
  uuid: string;
  characteristics: NobleCharacteristic[] | null;
}

interface NoblePeripheral {
  id: string;
  rssi: number;
  state: string;
  advertisement: { localName?: string; serviceUuids?: string[] };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverAllServicesAndCharacteristicsAsync(): Promise<{ services: NobleService[]; characteristics: NobleCharacteristic[] }>;
  once(event: 'disconnect', listener: (reason?: unknown) => void): void;
  removeListener(event: 'disconnect', listener: (reason?: unknown) => void): void;
}

interface Noble {
  state: string;
  on(event: 'stateChange', listener: (state: string) => void): void;
  on(event: 'discover', listener: (peripheral: NoblePeripheral) => void): void;
  removeListener(event: 'stateChange' | 'discover', listener: (...args: never[]) => void): void;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
  stop?(): void;
}

async function loadNoble(): Promise<Noble> {
  try {
    const moduleName = '@abandonware/noble';
    const imported = (await import(/* webpackIgnore: true */ moduleName)) as { default?: Noble } & Noble;
    return imported.default ?? imported;
  } catch (error) {
    throw new BleError(
      'ADAPTER_UNAVAILABLE',
      `@abandonware/noble could not be loaded (${error instanceof Error ? error.message : String(error)}). ` +
        'Install it on a machine with Bluetooth (npm install @abandonware/noble), or use --simulate / Web Bluetooth.',
    );
  }
}

class NobleConnection implements BleConnection {
  private readonly byUuid = new Map<string, NobleCharacteristic>();
  private readonly info: CharacteristicInfo[] = [];
  private readonly disconnectListeners = new Set<(reason: string) => void>();

  constructor(
    private readonly peripheral: NoblePeripheral,
    services: NobleService[],
  ) {
    for (const service of services) {
      for (const characteristic of service.characteristics ?? []) {
        const uuid = normalizeUuid(characteristic.uuid);
        this.byUuid.set(uuid, characteristic);
        this.info.push({
          uuid,
          serviceUuid: normalizeUuid(service.uuid),
          properties: characteristic.properties.filter((p): p is CharacteristicInfo['properties'][number] =>
            ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].includes(p),
          ),
        });
      }
    }
    const onDisconnect = (reason?: unknown) => {
      for (const listener of this.disconnectListeners) listener(reason ? String(reason) : 'peripheral disconnected');
    };
    peripheral.once('disconnect', onDisconnect);
  }

  get deviceId(): string {
    return this.peripheral.id;
  }

  get deviceName(): string | null {
    return this.peripheral.advertisement.localName ?? null;
  }

  characteristics(): CharacteristicInfo[] {
    return [...this.info];
  }

  private characteristic(uuid: string): NobleCharacteristic {
    const found = this.byUuid.get(normalizeUuid(uuid));
    if (!found) throw new BleError('CHARACTERISTIC_MISSING', `Characteristic ${uuid} not found`);
    return found;
  }

  async read(uuid: string): Promise<Uint8Array> {
    return toUint8Array(await withTimeout(this.characteristic(uuid).readAsync(), 5000, `read ${uuid}`));
  }

  async write(uuid: string, data: Uint8Array, options: { withoutResponse?: boolean } = {}): Promise<void> {
    await withTimeout(this.characteristic(uuid).writeAsync(Buffer.from(data), options.withoutResponse ?? false), 5000, `write ${uuid}`);
  }

  async subscribe(uuid: string, listener: (data: Uint8Array) => void): Promise<void> {
    const characteristic = this.characteristic(uuid);
    characteristic.on('data', (data, isNotification) => {
      if (isNotification !== false) listener(toUint8Array(data));
    });
    await withTimeout(characteristic.subscribeAsync(), 5000, `subscribe ${uuid}`);
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    for (const characteristic of this.byUuid.values()) characteristic.removeAllListeners('data');
    if (this.peripheral.state === 'connected' || this.peripheral.state === 'connecting') {
      await this.peripheral.disconnectAsync().catch(() => undefined);
    }
  }
}

export class NobleTransport implements BleTransport {
  readonly kind = 'noble' as const;
  private noble: Noble | null = null;
  private readonly peripherals = new Map<string, NoblePeripheral>();

  private async instance(): Promise<Noble> {
    this.noble ??= await loadNoble();
    return this.noble;
  }

  async ready(timeoutMs = 10_000): Promise<void> {
    const noble = await this.instance();
    if (noble.state === 'poweredOn') return;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        const listener = (state: string) => {
          if (state === 'poweredOn') {
            noble.removeListener('stateChange', listener as (...args: never[]) => void);
            resolve();
          } else if (state === 'unsupported' || state === 'unauthorized') {
            noble.removeListener('stateChange', listener as (...args: never[]) => void);
            reject(new BleError('ADAPTER_UNAVAILABLE', `Bluetooth adapter is ${state}`));
          }
        };
        noble.on('stateChange', listener);
      }),
      timeoutMs,
      'Bluetooth adapter power-on',
    );
  }

  async scan(options: ScanOptions): Promise<DiscoveredDevice[]> {
    const noble = await this.instance();
    await this.ready();
    const found = new Map<string, DiscoveredDevice>();
    const wanted = new Set(options.serviceUuids.map(normalizeUuid));
    const nameFilter = options.nameFilter?.toLowerCase();

    return new Promise<DiscoveredDevice[]>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover as (...args: never[]) => void);
        noble.stopScanningAsync().catch(() => undefined).finally(() => resolve([...found.values()]));
      };
      const onDiscover = (peripheral: NoblePeripheral) => {
        const serviceUuids = (peripheral.advertisement.serviceUuids ?? []).map((u) => {
          try {
            return normalizeUuid(u);
          } catch {
            return u;
          }
        });
        const name = peripheral.advertisement.localName ?? null;
        const matchesService = wanted.size === 0 || serviceUuids.some((u) => wanted.has(u));
        const matchesName = !nameFilter || (name?.toLowerCase().includes(nameFilter) ?? false);
        if (!matchesService || !matchesName) return;
        this.peripherals.set(peripheral.id, peripheral);
        const device: DiscoveredDevice = { id: peripheral.id, name, rssi: peripheral.rssi, serviceUuids };
        if (!found.has(device.id)) {
          found.set(device.id, device);
          options.onDevice?.(device);
          if (options.stopOnFirst) finish();
        }
      };
      const timer = setTimeout(finish, options.timeoutMs);
      noble.on('discover', onDiscover);
      // Scan unfiltered and filter in onDiscover: some straps only list a subset of services in the advertisement.
      noble.startScanningAsync([], false).catch((error: unknown) => {
        finished = true;
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover as (...args: never[]) => void);
        reject(new BleError('ADAPTER_UNAVAILABLE', `Scan failed: ${error instanceof Error ? error.message : String(error)}`));
      });
    });
  }

  async connect(deviceId: string): Promise<BleConnection> {
    let peripheral = this.peripherals.get(deviceId);
    if (!peripheral) {
      await this.scan({ serviceUuids: [], timeoutMs: 15_000, stopOnFirst: false, onDevice: () => undefined });
      peripheral = this.peripherals.get(deviceId);
    }
    if (!peripheral) throw new BleError('NOT_FOUND', `Device ${deviceId} is not advertising`);
    try {
      await withTimeout(peripheral.connectAsync(), 15_000, 'connect');
      const { services } = await withTimeout(peripheral.discoverAllServicesAndCharacteristicsAsync(), 15_000, 'service discovery');
      return new NobleConnection(peripheral, services);
    } catch (error) {
      await peripheral.disconnectAsync().catch(() => undefined);
      if (error instanceof BleError) throw error;
      throw new BleError('CONNECT_FAILED', `Connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (!this.noble) return;
    await this.noble.stopScanningAsync().catch(() => undefined);
    this.noble.stop?.();
  }
}

/** Exposed for diagnostics: the noble-style form of a canonical UUID. */
export const nobleUuid = toNobleUuid;
