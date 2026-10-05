/**
 * Browser fallback transport using the Web Bluetooth API (Chromium-based
 * browsers on macOS, Windows, Linux, ChromeOS and Android, over localhost or
 * HTTPS). Safari and every iOS browser do not implement Web Bluetooth; use the
 * Node daemon there.
 */
import { PROPRIETARY_SERVICES, SIG } from '../protocol/constants';
import { toUint8Array } from '../protocol/bytes';
import { normalizeUuid } from '../protocol/uuid';
import {
  BleError,
  withTimeout,
  type BleConnection,
  type BleTransport,
  type CharacteristicInfo,
  type DiscoveredDevice,
  type ScanOptions,
} from './transport';

const OPTIONAL_SERVICES = [
  SIG.HEART_RATE_SERVICE,
  SIG.BATTERY_SERVICE,
  SIG.DEVICE_INFORMATION_SERVICE,
  ...PROPRIETARY_SERVICES.map((s) => s.uuid),
];

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator && typeof navigator.bluetooth?.requestDevice === 'function';
}

class WebBluetoothConnection implements BleConnection {
  private readonly byUuid = new Map<string, BluetoothRemoteGATTCharacteristic>();
  private readonly info: CharacteristicInfo[] = [];
  private readonly disconnectListeners = new Set<(reason: string) => void>();
  private readonly handlers = new Map<string, (event: Event) => void>();

  constructor(
    private readonly device: BluetoothDevice,
    private readonly server: BluetoothRemoteGATTServer,
  ) {
    device.addEventListener('gattserverdisconnected', () => {
      for (const listener of this.disconnectListeners) listener('GATT server disconnected');
    });
  }

  async discover(): Promise<void> {
    for (const serviceUuid of OPTIONAL_SERVICES) {
      let service: BluetoothRemoteGATTService;
      try {
        service = await this.server.getPrimaryService(serviceUuid);
      } catch {
        continue; // Service not present on this strap.
      }
      let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
      try {
        characteristics = await service.getCharacteristics();
      } catch {
        continue;
      }
      for (const characteristic of characteristics) {
        const uuid = normalizeUuid(characteristic.uuid);
        this.byUuid.set(uuid, characteristic);
        const p = characteristic.properties;
        const properties: CharacteristicInfo['properties'] = [];
        if (p.read) properties.push('read');
        if (p.write) properties.push('write');
        if (p.writeWithoutResponse) properties.push('writeWithoutResponse');
        if (p.notify) properties.push('notify');
        if (p.indicate) properties.push('indicate');
        this.info.push({ uuid, serviceUuid: normalizeUuid(serviceUuid), properties });
      }
    }
  }

  get deviceId(): string {
    return this.device.id;
  }

  get deviceName(): string | null {
    return this.device.name ?? null;
  }

  characteristics(): CharacteristicInfo[] {
    return [...this.info];
  }

  private characteristic(uuid: string): BluetoothRemoteGATTCharacteristic {
    const found = this.byUuid.get(normalizeUuid(uuid));
    if (!found) throw new BleError('CHARACTERISTIC_MISSING', `Characteristic ${uuid} not found`);
    return found;
  }

  async read(uuid: string): Promise<Uint8Array> {
    const value = await withTimeout(this.characteristic(uuid).readValue(), 5000, `read ${uuid}`);
    return toUint8Array(value);
  }

  async write(uuid: string, data: Uint8Array, options: { withoutResponse?: boolean } = {}): Promise<void> {
    const characteristic = this.characteristic(uuid);
    const payload = new Uint8Array(toUint8Array(data)) as Uint8Array<ArrayBuffer>;
    if (options.withoutResponse) await characteristic.writeValueWithoutResponse(payload);
    else await characteristic.writeValueWithResponse(payload);
  }

  async subscribe(uuid: string, listener: (data: Uint8Array) => void): Promise<void> {
    const characteristic = this.characteristic(uuid);
    const handler = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (value) listener(toUint8Array(value));
    };
    this.handlers.set(normalizeUuid(uuid), handler);
    characteristic.addEventListener('characteristicvaluechanged', handler);
    await characteristic.startNotifications();
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async disconnect(): Promise<void> {
    for (const [uuid, handler] of this.handlers) {
      const characteristic = this.byUuid.get(uuid);
      characteristic?.removeEventListener('characteristicvaluechanged', handler);
      await characteristic?.stopNotifications().catch(() => undefined);
    }
    this.handlers.clear();
    if (this.server.connected) this.server.disconnect();
  }
}

export class WebBluetoothTransport implements BleTransport {
  readonly kind = 'web-bluetooth' as const;
  private readonly devices = new Map<string, BluetoothDevice>();

  async ready(): Promise<void> {
    if (!isWebBluetoothAvailable()) {
      throw new BleError('ADAPTER_UNAVAILABLE', 'Web Bluetooth is not available in this browser (use Chrome or Edge on desktop/Android).');
    }
    const available = await navigator.bluetooth.getAvailability?.();
    if (available === false) throw new BleError('ADAPTER_UNAVAILABLE', 'No Bluetooth adapter is available');
  }

  /** Opens the browser's device chooser (must be called from a user gesture). */
  async scan(options: ScanOptions): Promise<DiscoveredDevice[]> {
    await this.ready();
    const filters: BluetoothLEScanFilter[] = options.serviceUuids.map((uuid) => ({ services: [normalizeUuid(uuid)] }));
    if (options.nameFilter) filters.push({ namePrefix: options.nameFilter });
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({ filters, optionalServices: OPTIONAL_SERVICES });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return [];
      throw error;
    }
    this.devices.set(device.id, device);
    const discovered: DiscoveredDevice = { id: device.id, name: device.name ?? null, rssi: null, serviceUuids: [] };
    options.onDevice?.(discovered);
    return [discovered];
  }

  async connect(deviceId: string): Promise<BleConnection> {
    const device = this.devices.get(deviceId);
    if (!device?.gatt) throw new BleError('NOT_FOUND', 'Choose the strap in the browser dialog first');
    try {
      const server = await withTimeout(device.gatt.connect(), 20_000, 'GATT connect');
      const connection = new WebBluetoothConnection(device, server);
      await connection.discover();
      return connection;
    } catch (error) {
      if (error instanceof BleError) throw error;
      throw new BleError('CONNECT_FAILED', `GATT connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    for (const device of this.devices.values()) {
      if (device.gatt?.connected) device.gatt.disconnect();
    }
  }
}
