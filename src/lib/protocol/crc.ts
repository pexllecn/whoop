/**
 * Checksums used by the AA01 frame format.
 *
 *   Header:  CRC-16/MODBUS  (poly 0x8005 reflected = 0xA001, init 0xFFFF, no final XOR)
 *            over frame bytes 0..5, stored uint16 LE at bytes 6..7.
 *   Payload: CRC-32/ISO-HDLC (zlib.crc32: poly 0xEDB88320 reflected, init and
 *            final XOR 0xFFFFFFFF) over the payload body, stored uint32 LE in
 *            the last 4 bytes of the frame.
 *
 * Both are table driven and operate on Uint8Array ranges so they run unchanged
 * in Node and in the browser.
 */

const CRC16_MODBUS_TABLE: Uint16Array = (() => {
  const table = new Uint16Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    table[n] = crc;
  }
  return table;
})();

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[n] = crc >>> 0;
  }
  return table;
})();

function checkRange(data: Uint8Array, start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > data.length || start > end) {
    throw new RangeError(`Invalid CRC range [${start}, ${end}) for ${data.length} bytes`);
  }
}

/** CRC-16/MODBUS of data[start, end). Check value for "123456789" is 0x4B37. */
export function crc16Modbus(data: Uint8Array, start = 0, end = data.length): number {
  checkRange(data, start, end);
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC16_MODBUS_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return crc & 0xffff;
}

/** CRC-32 (zlib / IEEE 802.3) of data[start, end). Check value for "123456789" is 0xCBF43926. */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  checkRange(data, start, end);
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ data[i]!) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
