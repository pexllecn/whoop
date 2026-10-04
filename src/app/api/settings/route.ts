import { jsonError, readJson } from '@/lib/api';
import { getDb } from '@/lib/storage/db';
import { getSettings, publicSettings, updateSettings, type SettingsPatch } from '@/lib/storage/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(publicSettings(getSettings(getDb())));
}

/**
 * Merge a partial settings object. API keys are only replaced when a non-empty
 * value is sent; `clearKeys: ["openai" | "anthropic"]` removes stored keys.
 */
export async function POST(request: Request) {
  try {
    const body = await readJson<SettingsPatch & { clearKeys?: string[] }>(request);
    const { clearKeys, ...patch } = body;
    if (patch.coach) {
      if (!patch.coach.openaiApiKey) delete patch.coach.openaiApiKey;
      if (!patch.coach.anthropicApiKey) delete patch.coach.anthropicApiKey;
    }
    const db = getDb();
    let next = updateSettings(db, patch);
    if (clearKeys?.length) {
      next = updateSettings(db, {
        coach: {
          ...(clearKeys.includes('openai') ? { openaiApiKey: '' } : {}),
          ...(clearKeys.includes('anthropic') ? { anthropicApiKey: '' } : {}),
        },
      });
    }
    return Response.json(publicSettings(next));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Invalid settings');
  }
}
