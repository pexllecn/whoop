/**
 * Transport abstraction shared by the Node daemon (noble), the browser
 * fallback (Web Bluetooth) and the simulator. All UUIDs crossing this boundary
 * are canonical 128-bit lowercase strings (see protocol/uuid.ts).
 */

export type TransportKind = 'noble' | 'web-bluetooth' | 'simulator';

export interface DiscoveredDevice {
  id: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: string[];
}

export interface ScanOptions {
  serviceUuids: string[];
  timeoutMs: number;
  /** Case-insensitive substring match on the advertised name. */
  nameFilter?: string;
  /** Stop at the first matching device. */
  stopOnFirst?: boolean;
  /** Custom predicate; when set it replaces the service/name filters (noble only). */
  match?: (device: DiscoveredDevice) => boolean;
  onDevice?: (device: DiscoveredDevice) => void;
}

export interface CharacteristicInfo {
  uuid: string;
  serviceUuid: string;
  properties: Array<'read' | 'write' | 'writeWithoutResponse' | 'notify' | 'indicate'>;
}

export interface BleConnection {
  readonly deviceId: string;
  readonly deviceName: string | null;
  characteristics(): CharacteristicInfo[];
  read(uuid: string): Promise<Uint8Array>;
  write(uuid: string, data: Uint8Array, options?: { withoutResponse?: boolean }): Promise<void>;
  subscribe(uuid: string, listener: (data: Uint8Array) => void): Promise<void>;
  /** Returns an unsubscribe function. */
  onDisconnect(listener: (reason: string) => void): () => void;
  disconnect(): Promise<void>;
}

export interface BleTransport {
  readonly kind: TransportKind;
  /** Resolve once the adapter is powered on; reject with a readable reason otherwise. */
  ready(timeoutMs?: number): Promise<void>;
  scan(options: ScanOptions): Promise<DiscoveredDevice[]>;
  connect(deviceId: string): Promise<BleConnection>;
  close(): Promise<void>;
}

export class BleError extends Error {
  constructor(
    readonly code:
      | 'ADAPTER_UNAVAILABLE'
      | 'NOT_FOUND'
      | 'CONNECT_FAILED'
      | 'BOND_REQUIRED'
      | 'CHARACTERISTIC_MISSING'
      | 'WRITE_FAILED'
      | 'TIMEOUT'
      | 'DISCONNECTED',
    message: string,
  ) {
    super(message);
    this.name = 'BleError';
  }
}

/**
 * Errors that mean the link is not encrypted / the strap is not bonded with
 * this host. Web Bluetooth's SecurityError is deliberately excluded: Chrome
 * raises it for blocklisted characteristics (e.g. the 0x2A25 serial number),
 * which has nothing to do with bonding.
 */
export function isAuthenticationError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/blocklist/i.test(text)) return false;
  return /insufficient (authentication|encryption|authorization)|(authentication|encryption) is insufficient|not (paired|bonded)|(authentication|encryption|pairing) (required|failed)/i.test(text);
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BleError('TIMEOUT', `${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
