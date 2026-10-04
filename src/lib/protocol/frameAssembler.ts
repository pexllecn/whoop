import { FRAME } from './constants';
import { concatBytes } from './bytes';
import { parseFrame, parseFrameHeader, type Frame, type FrameErrorCode } from './packetParser';

export type AssemblerEvent =
  | { type: 'frame'; frame: Frame; bytes: Uint8Array }
  | { type: 'invalid_frame'; code: FrameErrorCode; error: string; bytes: Uint8Array };

export interface AssemblerResult {
  events: AssemblerEvent[];
  /** Bytes thrown away while resynchronising on the AA 01 sync word. */
  discardedBytes: number;
}

/**
 * Reassembles AA01 frames from a stream of BLE notifications.
 *
 * A notification can carry a fragment of a frame, exactly one frame or several
 * coalesced frames. The header CRC16 lets the assembler tell a real frame start
 * from an 0xAA 0x01 that happens to occur inside a payload: a candidate header
 * that fails its CRC is skipped one byte at a time until the stream lines up.
 * A frame whose header is valid but whose payload CRC32 fails is reported as
 * invalid and scanning resumes one byte later, so a corrupted or truncated
 * frame never swallows the frames that follow it.
 */
export class FrameAssembler {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly maxBufferedBytes = 64 * 1024) {}

  /** Bytes held while waiting for the rest of a frame. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  push(chunk: Uint8Array): AssemblerResult {
    this.buffer = this.buffer.length ? concatBytes(this.buffer, chunk) : chunk.slice();
    const events: AssemblerEvent[] = [];
    let discardedBytes = 0;

    const drop = (count: number) => {
      discardedBytes += count;
      this.buffer = this.buffer.slice(count);
    };

    while (this.buffer.length > 0) {
      const start = findSync(this.buffer);
      if (start === -1) {
        // Keep a trailing 0xAA: it may be the first half of the next sync word.
        const keep = this.buffer[this.buffer.length - 1] === FRAME.MAGIC_0 ? 1 : 0;
        drop(this.buffer.length - keep);
        break;
      }
      if (start > 0) drop(start);
      if (this.buffer.length < FRAME.HEADER_LENGTH) break;

      const header = parseFrameHeader(this.buffer);
      if (!header.ok) {
        drop(1);
        continue;
      }

      const totalLength = FRAME.HEADER_LENGTH + header.value.lengthField;
      if (this.buffer.length < totalLength) break;

      const candidate = this.buffer.slice(0, totalLength);
      const parsed = parseFrame(candidate);
      if (parsed.ok) {
        events.push({ type: 'frame', frame: parsed.value, bytes: candidate });
        this.buffer = this.buffer.slice(totalLength);
      } else {
        events.push({ type: 'invalid_frame', code: parsed.code, error: parsed.error, bytes: candidate });
        drop(1);
      }
    }

    if (this.buffer.length > this.maxBufferedBytes) {
      drop(this.buffer.length);
    }

    return { events, discardedBytes };
  }
}

function findSync(buffer: Uint8Array): number {
  for (let i = 0; i + 1 < buffer.length; i++) {
    if (buffer[i] === FRAME.MAGIC_0 && buffer[i + 1] === FRAME.MAGIC_1) return i;
  }
  return -1;
}
