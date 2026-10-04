import { eq } from 'drizzle-orm';
import { isValidTimeZone, systemTimeZone } from '../time';
import type { OpenPulseDb } from './db';
import { settings } from './schema';

export interface UserProfile {
  age: number;
  sex: 'male' | 'female';
  weightKg: number;
  heightCm: number;
  /** Measured maximum heart rate; when null the Tanaka estimate 208 - 0.7 x age is used. */
  maxHrOverride: number | null;
  /** Baseline nightly sleep need in hours (default 7.75 h). */
  baselineSleepNeedHours: number;
}

export type CoachProvider = 'ollama' | 'openai' | 'anthropic';

export interface AppSettings {
  profile: UserProfile;
  /** IANA zone used for calendar days. */
  timeZone: string;
  daemon: {
    /** Connect to this peripheral id only (null: first strap found). */
    deviceId: string | null;
    /** Advertised-name substring filter. */
    nameFilter: string | null;
    /** Command names sent after CLIENT_HELLO (built-in or protocol map). */
    startupCommands: string[];
    /** Use R-R intervals from historical 0x2F records for HRV. */
    useHistoricalRr: boolean;
    wsPort: number;
    /** Browser origins allowed to open the live WebSocket. */
    allowedOrigins: string[];
  };
  coach: {
    provider: CoachProvider;
    ollamaUrl: string;
    ollamaModel: string;
    openaiModel: string;
    anthropicModel: string;
    /** Stored locally; environment variables OPENAI_API_KEY / ANTHROPIC_API_KEY take precedence. */
    openaiApiKey: string;
    anthropicApiKey: string;
    /** Must be true before any biometric context is sent to a cloud provider. */
    allowExternal: boolean;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  profile: {
    age: 35,
    sex: 'male',
    weightKg: 75,
    heightCm: 178,
    maxHrOverride: null,
    baselineSleepNeedHours: 7.75,
  },
  timeZone: systemTimeZone(),
  daemon: {
    deviceId: null,
    nameFilter: null,
    startupCommands: [],
    useHistoricalRr: true,
    wsPort: 7781,
    allowedOrigins: ['http://127.0.0.1:3000', 'http://localhost:3000'],
  },
  coach: {
    provider: 'ollama',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.1:8b',
    openaiModel: 'gpt-4o-mini',
    anthropicModel: 'claude-sonnet-5-5',
    openaiApiKey: '',
    anthropicApiKey: '',
    allowExternal: false,
  },
};

const KEY = 'app';

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type SettingsPatch = DeepPartial<AppSettings>;

function merge<T>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out) || value === undefined) continue;
    const current = out[key];
    if (typeof current === 'object' && current !== null && !Array.isArray(current)) out[key] = merge(current, value);
    else if (typeof value === typeof current || current === null || value === null) out[key] = value;
  }
  return out as T;
}

export function validateSettings(value: AppSettings): AppSettings {
  const p = value.profile;
  const clamp = (n: number, min: number, max: number, fallback: number) => (Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback);
  return {
    ...value,
    timeZone: isValidTimeZone(value.timeZone) ? value.timeZone : DEFAULT_SETTINGS.timeZone,
    profile: {
      age: Math.round(clamp(p.age, 13, 100, DEFAULT_SETTINGS.profile.age)),
      sex: p.sex === 'female' ? 'female' : 'male',
      weightKg: clamp(p.weightKg, 30, 250, DEFAULT_SETTINGS.profile.weightKg),
      heightCm: clamp(p.heightCm, 120, 230, DEFAULT_SETTINGS.profile.heightCm),
      maxHrOverride: p.maxHrOverride === null ? null : Math.round(clamp(p.maxHrOverride, 120, 230, 190)),
      baselineSleepNeedHours: clamp(p.baselineSleepNeedHours, 5, 11, 7.75),
    },
    daemon: {
      ...value.daemon,
      wsPort: Math.round(clamp(value.daemon.wsPort, 1024, 65535, 7781)),
      startupCommands: value.daemon.startupCommands.filter((c) => typeof c === 'string').slice(0, 16),
      allowedOrigins: value.daemon.allowedOrigins.filter((o) => typeof o === 'string' && /^https?:\/\//.test(o)),
    },
  };
}

export function getSettings(db: OpenPulseDb): AppSettings {
  const row = db.select().from(settings).where(eq(settings.key, KEY)).get();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return validateSettings(merge(DEFAULT_SETTINGS, JSON.parse(row.value)));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function updateSettings(db: OpenPulseDb, patch: SettingsPatch): AppSettings {
  const next = validateSettings(merge(getSettings(db), patch));
  db.insert(settings)
    .values({ key: KEY, value: JSON.stringify(next), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(next), updatedAt: Date.now() } })
    .run();
  return next;
}

/** Settings safe to send to the browser: API keys are replaced by presence flags. */
export function publicSettings(value: AppSettings): AppSettings & { coach: AppSettings['coach'] & { hasOpenaiKey: boolean; hasAnthropicKey: boolean } } {
  return {
    ...value,
    coach: {
      ...value.coach,
      openaiApiKey: '',
      anthropicApiKey: '',
      hasOpenaiKey: Boolean(value.coach.openaiApiKey || process.env.OPENAI_API_KEY),
      hasAnthropicKey: Boolean(value.coach.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
    },
  };
}

/** Maximum heart rate: measured override, else Tanaka et al. (2001): 208 - 0.7 x age. */
export function effectiveMaxHr(profile: UserProfile): number {
  return profile.maxHrOverride ?? Math.round(208 - 0.7 * profile.age);
}
