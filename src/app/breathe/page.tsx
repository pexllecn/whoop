import { BreathePacer } from '@/components/breathe-pacer';
import { PageHeader } from '@/components/ui';
import { getDb } from '@/lib/storage/db';
import { getSettings } from '@/lib/storage/settings';

export const dynamic = 'force-dynamic';

export default function BreathePage() {
  const settings = getSettings(getDb());
  return (
    <>
      <PageHeader title="Breathe" subtitle="Paced breathing with live heart-rate biofeedback" />
      <BreathePacer port={settings.daemon.wsPort} timeZone={settings.timeZone} />
    </>
  );
}
