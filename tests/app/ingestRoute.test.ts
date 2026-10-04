import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex } from '@/lib/protocol/bytes';
import { CLIENT_HELLO } from '@/lib/protocol/commands';
import { WHOOP5 } from '@/lib/protocol/constants';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'openpulse-ingest-'));
  process.env.OPENPULSE_DB = path.join(dir, 'test.db');
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/storage/db');
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const post = async (body: unknown) => {
  const { POST } = await import('@/app/api/ingest/route');
  const response = await POST(new Request('http://127.0.0.1:3000/api/ingest', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  return { status: response.status, body: (await response.json()) as { stored?: number; statuses?: Record<string, number>; error?: string } };
};

describe('POST /api/ingest (Web Bluetooth path)', () => {
  it('stores raw packets and keeps frame state across batches', async () => {
    const t = Date.now();
    const first = await post({
      deviceId: 'browser-strap',
      reset: true,
      packets: [
        { uuid: '2a37', hex: '10407c03', t },
        { uuid: WHOOP5.COMMAND_RESPONSE, hex: bytesToHex(CLIENT_HELLO.slice(0, 7)), t: t + 1 },
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ stored: 2, statuses: { decoded: 1, fragment: 1 } });

    const second = await post({ deviceId: 'browser-strap', packets: [{ uuid: WHOOP5.COMMAND_RESPONSE, hex: bytesToHex(CLIENT_HELLO.slice(7)), t: t + 2 }] });
    expect(second.body.statuses).toEqual({ decoded: 1 });

    const { getDb } = await import('@/lib/storage/db');
    const { rawPackets, hrRrSamples } = await import('@/lib/storage/schema');
    const db = getDb();
    expect(db.select().from(rawPackets).all().map((r) => [r.source, r.decodedStatus])).toEqual([
      ['web-bluetooth', 'decoded'],
      ['web-bluetooth', 'fragment'],
      ['web-bluetooth', 'decoded'],
    ]);
    expect(db.select().from(hrRrSamples).all()[0]).toMatchObject({ bpm: 64, source: 'sig_hrm' });
  });

  it('rejects malformed input without storing it', async () => {
    expect((await post({ deviceId: '', packets: [] })).status).toBe(400);
    const bad = await post({ deviceId: 'x', packets: [{ uuid: 'nope', hex: 'zz', t: 1 }] });
    expect(bad.body).toEqual({ stored: 0, statuses: { rejected: 1 } });
  });
});
