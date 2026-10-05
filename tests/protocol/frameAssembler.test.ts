import { describe, expect, it } from 'vitest';
import { concatBytes, hexToBytes } from '@/lib/protocol/bytes';
import { CLIENT_HELLO, buildCommandFrame } from '@/lib/protocol/commands';
import { FrameAssembler } from '@/lib/protocol/frameAssembler';

const frames = (result: ReturnType<FrameAssembler['push']>) => result.events.filter((e) => e.type === 'frame');

describe('FrameAssembler', () => {
  it('reassembles a frame split across three notifications', () => {
    const asm = new FrameAssembler();
    expect(frames(asm.push(CLIENT_HELLO.slice(0, 3)))).toHaveLength(0);
    expect(frames(asm.push(CLIENT_HELLO.slice(3, 9)))).toHaveLength(0);
    const done = asm.push(CLIENT_HELLO.slice(9));
    expect(frames(done)).toHaveLength(1);
    expect(asm.pendingBytes).toBe(0);
  });

  it('splits coalesced frames', () => {
    const second = buildCommandFrame(0x03, 2, [1, 1, 0, 0, 0]);
    const result = new FrameAssembler().push(concatBytes(CLIENT_HELLO, second));
    expect(frames(result).map((e) => e.type === 'frame' && e.frame.sequenceOrRecord)).toEqual([1, 2]);
  });

  it('skips garbage, including a fake AA 01 whose header CRC fails', () => {
    const garbage = hexToBytes('0011AA01FFFF0000BEEF');
    const result = new FrameAssembler().push(concatBytes(garbage, CLIENT_HELLO));
    expect(frames(result)).toHaveLength(1);
    expect(result.discardedBytes).toBe(garbage.length);
  });

  it('reports a payload-corrupted frame and still finds the next good one', () => {
    const corrupted = CLIENT_HELLO.slice();
    corrupted[10] = corrupted[10]! ^ 0x01;
    const result = new FrameAssembler().push(concatBytes(corrupted, CLIENT_HELLO));
    expect(result.events.map((e) => e.type)).toEqual(['invalid_frame', 'frame']);
  });

  it('recovers when a fragment is lost', () => {
    const asm = new FrameAssembler();
    asm.push(CLIENT_HELLO.slice(0, 10)); // the rest of this frame never arrives
    const result = asm.push(concatBytes(CLIENT_HELLO, CLIENT_HELLO));
    expect(frames(result).length).toBeGreaterThanOrEqual(1);
    expect(asm.pendingBytes).toBe(0);
  });

  it('keeps a trailing 0xAA that may start the next frame', () => {
    const asm = new FrameAssembler();
    asm.push(Uint8Array.of(0x00, 0xaa));
    expect(asm.pendingBytes).toBe(1);
    expect(frames(asm.push(CLIENT_HELLO.slice(1)))).toHaveLength(1);
  });
});
