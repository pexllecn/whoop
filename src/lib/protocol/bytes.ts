/** Byte helpers that work identically in Node and browsers (no Buffer). */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[\s:_-]/g, '').replace(/^0x/i, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`Invalid hex string: "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array, separator = ''): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && separator) out += separator;
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function assertReadable(bytes: Uint8Array, offset: number, width: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset + width > bytes.length) {
    throw new RangeError(`Read of ${width} bytes at offset ${offset} exceeds ${bytes.length}-byte buffer`);
  }
}

export function readU8(bytes: Uint8Array, offset: number): number {
  assertReadable(bytes, offset, 1);
  return bytes[offset]!;
}

export function readU16LE(bytes: Uint8Array, offset: number): number {
  assertReadable(bytes, offset, 2);
  return view(bytes).getUint16(offset, true);
}

export function readI16LE(bytes: Uint8Array, offset: number): number {
  assertReadable(bytes, offset, 2);
  return view(bytes).getInt16(offset, true);
}

export function readU32LE(bytes: Uint8Array, offset: number): number {
  assertReadable(bytes, offset, 4);
  return view(bytes).getUint32(offset, true);
}

export function readF32LE(bytes: Uint8Array, offset: number): number {
  assertReadable(bytes, offset, 4);
  return view(bytes).getFloat32(offset, true);
}

export function writeU16LE(target: Uint8Array, offset: number, value: number): void {
  assertReadable(target, offset, 2);
  view(target).setUint16(offset, value & 0xffff, true);
}

export function writeU32LE(target: Uint8Array, offset: number, value: number): void {
  assertReadable(target, offset, 4);
  view(target).setUint32(offset, value >>> 0, true);
}

export function writeI16LE(target: Uint8Array, offset: number, value: number): void {
  assertReadable(target, offset, 2);
  view(target).setInt16(offset, value, true);
}

export function writeF32LE(target: Uint8Array, offset: number, value: number): void {
  assertReadable(target, offset, 4);
  view(target).setFloat32(offset, value, true);
}

/** Copy bytes into a fresh, tightly sized buffer (detaches from pooled Node Buffers). */
export function toUint8Array(data: ArrayBufferView | ArrayBuffer | ArrayLike<number>): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  }
  return Uint8Array.from(data);
}
