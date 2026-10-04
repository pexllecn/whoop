import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { DEFAULT_SETTINGS, effectiveMaxHr, getSettings, publicSettings, updateSettings } from '@/lib/storage/settings';
import { memoryDb } from '../helpers/db';

const request = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  new NextRequest(url, { method: init.method ?? 'GET', headers: init.headers });

describe('request guard (src/proxy.ts)', () => {
  it('serves loopback hosts', () => {
    expect(proxy(request('http://127.0.0.1:3000/', { headers: { host: '127.0.0.1:3000' } })).status).toBe(200);
    expect(proxy(request('http://localhost:3000/sleep', { headers: { host: 'localhost:3000' } })).status).toBe(200);
  });

  it('rejects other Host headers (DNS rebinding)', () => {
    expect(proxy(request('http://evil.example/', { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('rejects cross-site writes to the API', () => {
    const cross = proxy(request('http://127.0.0.1:3000/api/recompute', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }));
    expect(cross.status).toBe(403);
    const foreignOrigin = proxy(request('http://127.0.0.1:3000/api/settings', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://localhost:9999' } }));
    expect(foreignOrigin.status).toBe(403);
    const same = proxy(request('http://127.0.0.1:3000/api/settings', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' } }));
    expect(same.status).toBe(200);
  });
});

describe('settings', () => {
  it('merges patches, validates ranges and hides API keys from the browser', () => {
    const db = memoryDb();
    expect(getSettings(db)).toEqual(DEFAULT_SETTINGS);
    const next = updateSettings(db, { profile: { age: 300, weightKg: 70 }, timeZone: 'Not/AZone', coach: { openaiApiKey: 'sk-secret' } });
    expect(next.profile.age).toBe(100);
    expect(next.profile.weightKg).toBe(70);
    expect(next.timeZone).toBe(DEFAULT_SETTINGS.timeZone);
    expect(getSettings(db).coach.openaiApiKey).toBe('sk-secret');
    const shown = publicSettings(next);
    expect(shown.coach.openaiApiKey).toBe('');
    expect(shown.coach.hasOpenaiKey).toBe(true);
  });

  it('estimates max HR with Tanaka unless overridden', () => {
    expect(effectiveMaxHr({ ...DEFAULT_SETTINGS.profile, age: 40, maxHrOverride: null })).toBe(180);
    expect(effectiveMaxHr({ ...DEFAULT_SETTINGS.profile, maxHrOverride: 195 })).toBe(195);
  });
});
