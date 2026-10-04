import { SIG_BASE_UUID_SUFFIX } from './constants';

const DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Canonicalise a BLE UUID to lowercase, dashed, 128-bit form.
 * Accepts 16-bit ("2a37"), 32-bit ("00002a37"), undashed 128-bit (noble style)
 * and dashed 128-bit UUIDs.
 */
export function normalizeUuid(uuid: string): string {
  const lower = uuid.trim().toLowerCase().replace(/^0x/, '');
  if (DASHED.test(lower)) return lower;
  if (/^[0-9a-f]{4}$/.test(lower)) return `0000${lower}${SIG_BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(lower)) return `${lower}${SIG_BASE_UUID_SUFFIX}`;
  if (/^[0-9a-f]{32}$/.test(lower)) {
    return `${lower.slice(0, 8)}-${lower.slice(8, 12)}-${lower.slice(12, 16)}-${lower.slice(16, 20)}-${lower.slice(20)}`;
  }
  throw new Error(`Not a BLE UUID: "${uuid}"`);
}

/** noble's representation: SIG UUIDs as 4 hex digits, others as 32 undashed hex digits. */
export function toNobleUuid(uuid: string): string {
  const canonical = normalizeUuid(uuid);
  if (canonical.startsWith('0000') && canonical.endsWith(SIG_BASE_UUID_SUFFIX)) {
    return canonical.slice(4, 8);
  }
  return canonical.replace(/-/g, '');
}

export function uuidEquals(a: string, b: string): boolean {
  return normalizeUuid(a) === normalizeUuid(b);
}
