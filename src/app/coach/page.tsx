import Link from 'next/link';
import { CoachChat } from '@/components/coach-chat';
import { Banner, PageHeader } from '@/components/ui';
import { STARTER_QUESTIONS } from '@/lib/coach/prompts';
import { providerModel } from '@/lib/coach/providers';
import { getDb } from '@/lib/storage/db';
import { getSettings } from '@/lib/storage/settings';

export const dynamic = 'force-dynamic';

export default function CoachPage() {
  const { coach } = getSettings(getDb());
  const external = coach.provider !== 'ollama';
  return (
    <>
      <PageHeader title="Coach" subtitle="Plain-language guidance from your own numbers" />
      {external && !coach.allowExternal && (
        <Banner tone="warn">
          {coach.provider === 'openai' ? 'OpenAI' : 'Anthropic'} is selected but sending data to it is not allowed yet. Enable it in{' '}
          <Link href="/settings" className="text-accent underline">
            Settings
          </Link>{' '}
          or switch to Ollama to stay offline.
        </Banner>
      )}
      <CoachChat provider={coach.provider} model={providerModel(coach)} external={external} starters={STARTER_QUESTIONS} />
      <p className="mt-4 text-xs text-muted">The coach is not a medical service. For symptoms or sustained abnormal readings, talk to a healthcare professional.</p>
    </>
  );
}
